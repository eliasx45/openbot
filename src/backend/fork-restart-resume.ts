/**
 * Fork (docs/fork/FEATURES.md, "Agents continue after a restart"): when OpenBot restarts while an
 * agent works in its own chat, the agent gets one wake message in its own provider session, so it
 * goes on with everything it knew, like Claude Code's "You were interrupted, continue your work".
 *
 * Boot recovery (`BootRecovery.recoverPersistedTurns`) still settles the interrupted turn as before.
 * Just before, `capture` notes what the restart stopped in each agent's own chat: a running turn,
 * background subagents that still ran, or a goal chain between two turns. Each note is kept in a JSON
 * file beside the database, keyed by the interrupted turn, so a restart that comes again does not
 * resume the same turn again. When the wake's own turn is interrupted by another restart, it gets one
 * more try (`RESTART_RESUME_MAX_ATTEMPTS`), then the turn stays interrupted.
 *
 * After start, each note becomes an open wait ("🔄 Resumes after the restart", with Cancel) for a
 * short grace time, then a delivery with a routine sender (`routineId` `fork-restart-resume`, no real
 * routine), like the wake of `wait_until`: its text is the whole prompt, and it runs in the agent's
 * own session. The wakes start one at a time, a few seconds apart.
 *
 * No wake: in channel, messaging and task threads; for a turn that ran a routine or OpenBot's own
 * upkeep; when the turn waited for the user's answer; when a message waits in the queue or a turn
 * started since; for an agent that is gone,
 * hidden, or has a new chat; when the provider session is gone or the provider is not ready in time.
 * A Stop or a turn that ended is not running, so it is never captured.
 *
 * Fork (docs/fork/FEATURES.md, "Stopped subagents continue"): the same wake also runs while OpenBot
 * runs, when a Claude process ends with background subagents still working (a crash, or a close for a
 * settings, account or tool change). `captureStopped` notes it at once (`trigger` "process"). Then the
 * same wait, skips and wake follow, with these extra rules: the wake runs only in the provider session
 * the subagents ran in (`SendMessage` finds them only there); a new message in the chat since the stop,
 * a session that changed, or more than `LIVE_WAKES_PER_HOUR` wakes of the agent in an hour gives a
 * line that says the subagent was not continued, so the user knows.
 */

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type { ConversationMessage, ConversationSubagent, QueueDelivery } from "@openbot/contracts/ipc";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { sourceText } from "@openbot/i18n/source";

export const FORK_RESTART_RESUME_ROUTINE_ID = "fork-restart-resume";
/**
 * Fork (docs/fork/FEATURES.md, "Stopped subagents continue"): a client's notification that background
 * subagents of a session stopped because its process ended while OpenBot ran. `cause` is "closed"
 * (OpenBot closed the process) or "crashed" (the process ended by itself).
 */
export const FORK_BACKGROUND_STOPPED_METHOD = "openbot/fork-background-stopped";
/**
 * A turn interrupted longer ago than this still gets its wake (the user wants every agent to go on),
 * but the wake says how long the app was down and to check time-sensitive steps before doing them late.
 */
const RESTART_RESUME_LONG_DOWNTIME_MS = 2 * 60 * 60_000;
/** The first wake and one more try when that wake's own turn is interrupted by a restart too. */
const RESTART_RESUME_MAX_ATTEMPTS = 2;
/** The routine id of `wait_until` wakes, which continue the agent's own work as a user message does. */
const WAIT_ROUTINE_ID = "fork-wait";
const FILE = "fork-restart-resume.json";
/**
 * The time the user has to cancel the wakes after a start, and the time between two wakes, so the
 * agents do not all start at once (rate limits). Test switches: `OPENBOT_FORK_RESTART_RESUME_GRACE_MS`,
 * `..._STAGGER_MS`, `..._PROVIDER_WAIT_MS`, `..._SETTLE_WAIT_MS`; `OPENBOT_FORK_RESTART_RESUME=0` turns it off.
 */
const GRACE_MS = () => envNumber("OPENBOT_FORK_RESTART_RESUME_GRACE_MS", 10_000);
const STAGGER_MS = () => envNumber("OPENBOT_FORK_RESTART_RESUME_STAGGER_MS", 5_000);
const HEARTBEAT_MS = 60_000;
const PUMP_MS = 500;
/** How long a wake waits for the provider to be ready and signed in. */
const PROVIDER_WAIT_MS = () => envNumber("OPENBOT_FORK_RESTART_RESUME_PROVIDER_WAIT_MS", 10 * 60_000);
/** How long a wake waits for boot recovery to settle the interrupted deliveries. */
const SETTLE_WAIT_MS = () => envNumber("OPENBOT_FORK_RESTART_RESUME_SETTLE_WAIT_MS", 3 * 60_000);
const RETRY_MS = 3_000;
const KEEP_MS = 24 * 60 * 60_000;
const REQUEST_LIMIT = 4_000;
/** At most this many wakes for stopped subagents per agent per hour, so a crash loop ends. */
const LIVE_WAKES_PER_HOUR = 3;
const HOUR_MS = 60 * 60_000;

export type RestartResumeKind = "turn" | "subagents" | "goal";
type RestartResumeState = "pending" | "queued" | "skipped" | "cancelled";

export interface RestartResumeSubagent {
  /** OpenBot's id of the subagent: the provider's call id. */
  id: string;
  title: string;
  /** The id `SendMessage` takes, when known. */
  providerAgentId: string | null;
  background: boolean;
}

export interface RestartResumeEntry {
  /** The interrupted work, the same over every try: `<kind>:<turn or delivery id>`. */
  key: string;
  agentId: string;
  threadId: string;
  kind: RestartResumeKind;
  turnId: string | null;
  /** The interrupted deliveries. Boot recovery settles them before the wake starts. */
  deliveryIds: string[];
  /** When the previous run was last known to be alive. */
  interruptedAt: string;
  capturedAt: string;
  requestText: string;
  subagents: RestartResumeSubagent[];
  goal: boolean;
  /** 1 for the first wake, 2 for the try after the first wake was interrupted too. */
  attempt: number;
  state: RestartResumeState;
  reason: string | null;
  waitId: string | null;
  deliveryId: string | null;
  /** "process": the subagents stopped while OpenBot ran. Absent for a note of a restart. */
  trigger?: "restart" | "process";
  /** For "process": whether OpenBot closed the process or it crashed. */
  cause?: "closed" | "crashed";
  /** For "process": the provider session the subagents ran in. The wake runs only there. */
  externalSessionId?: string;
}

interface SavedState {
  version: 1;
  enabled: boolean;
  aliveAt: string | null;
  entries: RestartResumeEntry[];
}

export interface ForkRestartResumeHooks {
  /** The agent's own chat, or null when the agent is gone, hidden or being deleted. */
  agent(agentId: string): { threadId: string | null; provider: string } | null;
  /** Whether a turn can start on the agent's provider now: ready and signed in. */
  providerReady(agentId: string): boolean;
  /** The provider session of the agent's own chat, or null when there is none to resume. */
  session(agentId: string, threadId: string): { externalSessionId: string } | null;
  /** Claude only: the `SendMessage` id of each subagent of the session, by its call id. */
  subagentIds(agentId: string, externalSessionId: string): Promise<Map<string, string>>;
  /** A delivery of a channel or a messaging conversation: it runs in that thread. */
  executionDelivery(deliveryId: string): boolean;
  /** A turn runs, or a delivery starts, in the agent's own chat. */
  laneBusy(agentId: string): boolean;
  /** Messages that wait in the queue of the agent's own chat (not a plan continuation). */
  laneQueued(agentId: string): number;
  /** The first queued delivery of the own chat waits for its goal or plan continuation. */
  continuationQueued(agentId: string): boolean;
  delivery(deliveryId: string): QueueDelivery | null;
  /** Any delivery, also a settled one, that ran in this turn. */
  deliveryOfTurn(turnId: string): QueueDelivery | null;
  unresolvedOwnDeliveries(agentId: string): QueueDelivery[];
  goalWorking(agentId: string): boolean;
  /** Opens the wait the user can cancel; null when none can be opened. */
  openWait(input: { agentId: string; requestId: string; requestText: string; note: string }): string | null;
  waitOpen(agentId: string, waitId: string): boolean;
  closeWait(agentId: string, waitId: string): void;
  /** Queues the wake in the agent's own chat; gives its delivery id. */
  enqueue(input: { agentId: string; runId: string; title: string; text: string }): Promise<string>;
  /** A quiet status line in the agent's own chat. */
  line(agentId: string, text: string): void;
  timezone(): string | undefined;
  isRunning(): boolean;
  log(message: string, details: Record<string, string | number | boolean | null>): void;
}

export class ForkRestartResume {
  readonly #file: string | null;
  readonly #hooks: ForkRestartResumeHooks;
  #state: SavedState = { version: 1, enabled: true, aliveAt: null, entries: [] };
  /** The `aliveAt` of the previous run, read once at construction. */
  readonly #previousAliveAt: number | null;
  #heartbeat: ReturnType<typeof setInterval> | null = null;
  #pump: ReturnType<typeof setInterval> | null = null;
  #busy = false;
  #nextAt = 0;
  #startedAt = 0;
  /** Per entry key: when it may be tried next, and when it was first tried. */
  readonly #notBefore = new Map<string, number>();
  readonly #firstTry = new Map<string, { settle: number | null; provider: number | null }>();
  /** When a turn last started in each agent's own chat. A note older than that was taken over. */
  readonly #turnStartedAt = new Map<string, number>();

  constructor(options: { databasePath: string; hooks: ForkRestartResumeHooks }) {
    this.#hooks = options.hooks;
    this.#file = isAbsolute(options.databasePath) ? join(dirname(options.databasePath), FILE) : null;
    if (this.#file) {
      try {
        const saved = JSON.parse(readFileSync(this.#file, "utf8"));
        if (isDynamicRecord(saved)) {
          this.#state = {
            version: 1,
            enabled: saved.enabled !== false,
            aliveAt: typeof saved.aliveAt === "string" ? saved.aliveAt : null,
            entries: Array.isArray(saved.entries) ? saved.entries.filter(isEntry) : [],
          };
        }
      } catch {}
    }
    const alive = this.#state.aliveAt ? Date.parse(this.#state.aliveAt) : Number.NaN;
    this.#previousAliveAt = Number.isFinite(alive) ? alive : null;
  }

  /** On unless the user turned it off (`/autoresume off`) or `OPENBOT_FORK_RESTART_RESUME=0`. */
  enabled(): boolean {
    return this.#state.enabled && process.env.OPENBOT_FORK_RESTART_RESUME !== "0";
  }

  setEnabled(on: boolean): void {
    this.#state.enabled = on;
    if (!on) for (const entry of this.#state.entries) if (entry.state === "pending") this.#skip(entry, "turned off");
    this.#save();
  }

  /** Every note, for checks and the e2e report. */
  entries(): readonly RestartResumeEntry[] {
    return this.#state.entries;
  }

  /**
   * One thread as the previous run left it, before boot recovery settles it. Notes the work to
   * resume, or why it is not resumed.
   */
  capture(input: {
    agentId: string;
    threadId: string;
    ownChat: boolean;
    turnId: string | null;
    messages: readonly ConversationMessage[];
  }): void {
    if (!this.enabled() || !input.ownChat) return;
    const { agentId, threadId, turnId, messages } = input;
    const now = new Date();
    const own = this.#hooks
      .unresolvedOwnDeliveries(agentId)
      .filter((delivery) => turnId === null || delivery.turnId === null || delivery.turnId === turnId);
    const running = messages.flatMap((message) =>
      (message.subagents ?? []).filter((item) => item.status === "running"),
    );
    const subagents = running.map(subagentNote);
    const goal = this.#hooks.goalWorking(agentId);
    let kind: RestartResumeKind;
    let originId: string;
    if (turnId !== null || own.length > 0) {
      kind = "turn";
      originId = turnId ?? own[0]?.id ?? threadId;
    } else if (running.some((subagent) => subagent.background)) {
      kind = "subagents";
      originId =
        messages.find((message) => message.subagents?.some((item) => item.status === "running"))?.turnId ?? threadId;
    } else if (goal && this.#hooks.continuationQueued(agentId)) {
      kind = "goal";
      originId = threadId;
    } else return;
    // A wake whose own turn was interrupted: the same work, one try further.
    const wake = own.find(
      (delivery) => delivery.sender.kind === "routine" && delivery.sender.routineId === FORK_RESTART_RESUME_ROUTINE_ID,
    );
    const earlier = wake
      ? (this.#state.entries.find((entry) => entry.deliveryId === wake.id) ??
        this.#entryForRun(wake.sender.kind === "routine" ? wake.sender.runId : ""))
      : null;
    const key = earlier?.key ?? `${kind}:${originId}`;
    const existing = this.#state.entries.find((entry) => entry.key === key);
    // The same interrupted turn seen again (a crash during this boot): its note stands.
    if (existing && !wake) return;
    const attempt = wake ? (earlier?.attempt ?? attemptOfRun(wake)) + 1 : 1;
    const request =
      own.findLast((delivery) => delivery.sender.kind === "user") ??
      own.find((delivery) => delivery.sender.kind !== "routine") ??
      own[0] ??
      (kind === "subagents" && originId !== threadId ? this.#hooks.deliveryOfTurn(originId) : null);
    const entry: RestartResumeEntry = {
      key,
      agentId,
      threadId,
      kind,
      turnId,
      deliveryIds: own.map((delivery) => delivery.id),
      interruptedAt: new Date(this.#interruptedAt(own, messages, now)).toISOString(),
      capturedAt: now.toISOString(),
      requestText: (earlier?.requestText ?? (request && request !== wake ? request.text : "")).slice(0, REQUEST_LIMIT),
      subagents: mergeSubagents(earlier?.subagents ?? [], subagents),
      goal,
      attempt,
      state: "pending",
      reason: null,
      waitId: null,
      deliveryId: null,
    };
    const reason = this.#captureSkip(entry, own, messages);
    if (reason) {
      entry.state = "skipped";
      entry.reason = reason;
    }
    this.#state.entries = [...this.#state.entries.filter((item) => item.key !== key), entry];
    this.#save();
  }

  #captureSkip(
    entry: RestartResumeEntry,
    own: readonly QueueDelivery[],
    messages: readonly ConversationMessage[],
  ): string | null {
    if (entry.attempt > RESTART_RESUME_MAX_ATTEMPTS) return "retry limit: the resume was interrupted again";
    if (messages.some((message) => message.questionPrompt && message.questionPrompt.resolution === null))
      return "waited for the user's answer";
    for (const delivery of own) {
      if (this.#hooks.executionDelivery(delivery.id)) return "channel or messaging work";
      if (delivery.sender.kind !== "routine") continue;
      const { routineId } = delivery.sender;
      if (routineId === "fork-compact" || routineId === "fork-keepwarm") return "OpenBot upkeep (compact or keep-warm)";
      if (routineId !== WAIT_ROUTINE_ID && routineId !== FORK_RESTART_RESUME_ROUTINE_ID) return "routine run";
    }
    if (this.#hooks.laneQueued(entry.agentId) > 0) return "a queued message runs instead";
    return null;
  }

  /** The last time the previous run was alive: its heartbeat, else the newest sign of the turn. */
  #interruptedAt(own: readonly QueueDelivery[], messages: readonly ConversationMessage[], now: Date): number {
    if (this.#previousAliveAt !== null) return Math.min(this.#previousAliveAt, now.getTime());
    const times = [...own.map((delivery) => delivery.createdAt), ...messages.map((message) => message.createdAt)]
      .map((value) => Date.parse(value))
      .filter(Number.isFinite);
    return times.length > 0 ? Math.max(...times) : now.getTime();
  }

  #entryForRun(runId: string): RestartResumeEntry | null {
    const parsed = parseRunId(runId);
    return parsed ? (this.#state.entries.find((entry) => entry.key === parsed.key) ?? null) : null;
  }

  /** After boot: opens the waits, starts the heartbeat and the wakes. */
  start(): void {
    this.#startedAt = Date.now();
    this.#state.aliveAt = new Date().toISOString();
    const cutoff = Date.now() - KEEP_MS;
    this.#state.entries = this.#state.entries.filter((entry) => Date.parse(entry.capturedAt) >= cutoff);
    for (const entry of this.#state.entries) {
      if (entry.state !== "pending") continue;
      const agent = this.#hooks.agent(entry.agentId);
      if (!agent) {
        this.#skip(entry, "agent gone");
        continue;
      }
      if (entry.waitId && this.#hooks.waitOpen(entry.agentId, entry.waitId)) continue;
      entry.waitId = this.#hooks.openWait({
        agentId: entry.agentId,
        requestId: entry.deliveryIds[0] ?? entry.key,
        requestText: entry.requestText || "(the work before the restart)",
        note: sourceText("status.agent.restartResumeWait"),
      });
    }
    this.#save();
    this.#heartbeat = setInterval(() => {
      this.#state.aliveAt = new Date().toISOString();
      this.#save();
    }, HEARTBEAT_MS);
    this.#heartbeat.unref?.();
    this.#nextAt = this.#startedAt + GRACE_MS();
    if (this.#state.entries.some((entry) => entry.state === "pending")) this.#startPump();
  }

  /** At stop: the run is alive until now. */
  dispose(): void {
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    if (this.#pump) clearInterval(this.#pump);
    this.#heartbeat = null;
    this.#pump = null;
    if (this.#startedAt > 0) {
      this.#state.aliveAt = new Date().toISOString();
      this.#save();
    }
  }

  /** A turn started in an agent's own chat: a wake not queued yet is no longer wanted. */
  turnStarted(agentId: string, threadId: string): void {
    if (this.#hooks.agent(agentId)?.threadId === threadId) this.#turnStartedAt.set(agentId, Date.now());
  }

  /**
   * Fork (docs/fork/FEATURES.md, "Stopped subagents continue"): a Claude process ended while OpenBot
   * ran, and these background subagents of `turnId` stopped with it. Notes one wake for the agent's
   * own chat, or writes the line that says why the subagents are not continued.
   */
  captureStopped(input: {
    agentId: string;
    threadId: string;
    externalSessionId: string;
    turnId: string | null;
    cause: "closed" | "crashed";
    subagents: ReadonlyArray<{ id: string; title: string; providerAgentId: string | null }>;
  }): void {
    // Before start, at boot or while OpenBot quits: the restart resume notes the subagents instead.
    if (this.#startedAt === 0 || !this.#hooks.isRunning() || input.subagents.length === 0) return;
    const agent = this.#hooks.agent(input.agentId);
    // Channel, messaging and task threads have no wake; an agent being deleted needs none.
    if (!agent || agent.threadId !== input.threadId) return;
    const title = input.subagents.map((subagent) => subagent.title || "subagent").join("”, “");
    if (!this.enabled()) {
      this.#hooks.line(input.agentId, sourceText("status.agent.subagentResumeOff", { title }));
      return;
    }
    const now = new Date();
    const key = `subagents:${input.turnId ?? input.externalSessionId}`;
    const earlier = this.#state.entries.find((entry) => entry.key === key);
    const subagents = input.subagents.map((subagent) => ({
      id: subagent.id,
      title: subagent.title,
      providerAgentId: subagent.providerAgentId,
      background: true,
    }));
    // The same subagents stopped again before their wake ran: one wake for both.
    if (earlier?.state === "pending") {
      earlier.subagents = mergeSubagents(earlier.subagents, subagents);
      this.#save();
      return;
    }
    const request = input.turnId ? this.#hooks.deliveryOfTurn(input.turnId) : null;
    const entry: RestartResumeEntry = {
      key,
      agentId: input.agentId,
      threadId: input.threadId,
      kind: "subagents",
      turnId: input.turnId,
      deliveryIds: [],
      interruptedAt: now.toISOString(),
      capturedAt: now.toISOString(),
      requestText: (earlier?.requestText ?? request?.text ?? "").slice(0, REQUEST_LIMIT),
      subagents: mergeSubagents(earlier?.subagents ?? [], subagents),
      goal: this.#hooks.goalWorking(input.agentId),
      // A wake that ran, and whose continued subagents stopped again: one try further.
      attempt: earlier ? earlier.attempt + 1 : 1,
      state: "pending",
      reason: null,
      waitId: null,
      deliveryId: null,
      trigger: "process",
      cause: input.cause,
      externalSessionId: input.externalSessionId,
    };
    const recent = this.#state.entries.filter(
      (item) =>
        item.trigger === "process" &&
        item.agentId === input.agentId &&
        item.state === "queued" &&
        now.getTime() - Date.parse(item.capturedAt) < HOUR_MS,
    ).length;
    this.#state.entries = [...this.#state.entries.filter((item) => item.key !== key), entry];
    if (entry.attempt > RESTART_RESUME_MAX_ATTEMPTS) {
      this.#skipLive(entry, "retry limit: the continued subagents stopped again", "status.agent.subagentResumeLimit");
    } else if (recent >= LIVE_WAKES_PER_HOUR) {
      this.#skipLive(entry, "too many stops in an hour", "status.agent.subagentResumeLimit");
    } else {
      entry.waitId = this.#hooks.openWait({
        agentId: entry.agentId,
        requestId: entry.key,
        requestText: entry.requestText || title,
        note: sourceText("status.agent.subagentResumeWait"),
      });
      this.#notBefore.set(entry.key, now.getTime() + GRACE_MS());
      this.#startPump();
    }
    this.#save();
  }

  /** A note of stopped subagents that is not woken: the user gets a line, so they know. */
  #skipLive(
    entry: RestartResumeEntry,
    reason: string,
    line:
      | "status.agent.subagentResumeLimit"
      | "status.agent.subagentResumeTookOver"
      | "status.agent.subagentResumeSessionChanged"
      | "status.agent.subagentResumeNotReady",
    extra: { provider?: string } = {},
  ): void {
    this.#skip(entry, reason);
    const title = entry.subagents.map((subagent) => subagent.title || "subagent").join("”, “");
    const text =
      line === "status.agent.subagentResumeLimit"
        ? sourceText(line, { title, count: String(LIVE_WAKES_PER_HOUR) })
        : line === "status.agent.subagentResumeNotReady"
          ? sourceText(line, { title, provider: extra.provider ?? "the provider" })
          : sourceText(line, { title });
    // An agent that is gone has no chat to write in.
    if (this.#hooks.agent(entry.agentId)) this.#hooks.line(entry.agentId, text);
  }

  /** Whether this wait is a wake that waits for its turn; a routine run does not wake it. */
  ownsWait(waitId: string): boolean {
    return this.#state.entries.some((entry) => entry.state === "pending" && entry.waitId === waitId);
  }

  #startPump(): void {
    if (this.#pump) return;
    this.#pump = setInterval(() => void this.#tick(), PUMP_MS);
    this.#pump.unref?.();
  }

  async #tick(): Promise<void> {
    if (this.#busy || !this.#hooks.isRunning()) return;
    const now = Date.now();
    const pending = this.#state.entries.filter((entry) => entry.state === "pending");
    if (pending.length === 0) {
      if (this.#pump) clearInterval(this.#pump);
      this.#pump = null;
      return;
    }
    if (now < this.#nextAt) return;
    const entry = pending.find((candidate) => (this.#notBefore.get(candidate.key) ?? 0) <= now);
    if (!entry) return;
    this.#busy = true;
    try {
      const result = await this.#fire(entry, now);
      if (result === "queued") this.#nextAt = Date.now() + STAGGER_MS();
      else if (result === "later") this.#notBefore.set(entry.key, Date.now() + RETRY_MS);
    } catch (error) {
      this.#skip(entry, `failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300));
      this.#hooks.line(entry.agentId, sourceText("status.agent.restartResumeFailed"));
    } finally {
      this.#busy = false;
      this.#save();
    }
  }

  async #fire(entry: RestartResumeEntry, now: number): Promise<"queued" | "later" | "skipped"> {
    const skip = (reason: string, line?: string) => {
      this.#skip(entry, reason);
      if (line) this.#hooks.line(entry.agentId, line);
      return "skipped" as const;
    };
    if (!this.enabled()) return skip("turned off");
    // Before the wait: deleting an agent deletes its waits too.
    const agent = this.#hooks.agent(entry.agentId);
    if (!agent) return skip("agent gone");
    if (entry.waitId && !this.#hooks.waitOpen(entry.agentId, entry.waitId)) {
      entry.waitId = null;
      entry.state = "cancelled";
      entry.reason = "cancelled by the user";
      this.#log(entry);
      return "skipped";
    }
    const live = entry.trigger === "process";
    const tookOver = (reason: string) => {
      if (!live) return skip(reason);
      this.#skipLive(entry, reason, "status.agent.subagentResumeTookOver");
      return "skipped" as const;
    };
    if (agent.threadId !== entry.threadId) return skip("a new chat replaced the interrupted one");
    if ((this.#turnStartedAt.get(entry.agentId) ?? 0) >= Date.parse(entry.capturedAt))
      return tookOver(live ? "another turn started since the stop" : "another turn started since the restart");
    if (entry.kind === "goal" && !this.#hooks.goalWorking(entry.agentId)) return skip("the goal no longer runs");
    if (this.#hooks.laneQueued(entry.agentId) > 0) return tookOver("a queued message runs instead");
    const tries = this.#firstTry.get(entry.key) ?? { settle: null, provider: null };
    this.#firstTry.set(entry.key, tries);
    // A provider that is not ready, or signed out, gets some time; then one quiet line, no loop.
    if (!this.#hooks.providerReady(entry.agentId)) {
      tries.provider ??= now;
      if (now - tries.provider <= PROVIDER_WAIT_MS()) return "later";
      if (!live)
        return skip(
          "provider not ready",
          sourceText("status.agent.restartResumeNotReady", { provider: agent.provider }),
        );
      this.#skipLive(entry, "provider not ready", "status.agent.subagentResumeNotReady", { provider: agent.provider });
      return "skipped";
    }
    // Boot recovery settles the interrupted deliveries once the provider is ready.
    const statuses = entry.deliveryIds.map((id) => this.#hooks.delivery(id)?.status ?? "missing");
    if (statuses.some((status) => status === "queued" || status === "starting" || status === "running")) {
      tries.settle ??= now;
      return now - tries.settle > SETTLE_WAIT_MS() ? skip("the interrupted turn did not settle") : "later";
    }
    if (entry.kind === "turn" && statuses.length > 0 && statuses.every((status) => status === "completed"))
      return skip("the interrupted turn had completed");
    if (this.#hooks.laneBusy(entry.agentId)) return tookOver("another turn runs");
    const session = this.#hooks.session(entry.agentId, entry.threadId);
    // `SendMessage` finds a subagent only in the session it ran in: a context reset, an account or
    // provider change gives the chat a new one.
    if (live && session?.externalSessionId !== entry.externalSessionId) {
      this.#skipLive(entry, "the provider session changed", "status.agent.subagentResumeSessionChanged");
      return "skipped";
    }
    if (!session) return skip("provider session gone", sourceText("status.agent.restartResumeSessionGone"));
    let subagents = entry.subagents;
    if (agent.provider === "claude" && subagents.some((subagent) => !subagent.providerAgentId)) {
      const ids = await this.#hooks.subagentIds(entry.agentId, session.externalSessionId).catch(() => new Map());
      subagents = subagents.map((subagent) => ({
        ...subagent,
        providerAgentId: subagent.providerAgentId ?? ids.get(subagent.id) ?? null,
      }));
      entry.subagents = subagents;
    }
    // Again after the await. From here to the queued delivery nothing waits, so no turn slips in.
    if (entry.waitId && !this.#hooks.waitOpen(entry.agentId, entry.waitId)) {
      entry.waitId = null;
      entry.state = "cancelled";
      entry.reason = "cancelled by the user";
      return "skipped";
    }
    if (this.#hooks.laneBusy(entry.agentId) || this.#hooks.laneQueued(entry.agentId) > 0)
      return tookOver("another turn runs");
    if (entry.waitId) this.#hooks.closeWait(entry.agentId, entry.waitId);
    entry.waitId = null;
    // Saved once the delivery exists (`#tick`): a stop before that leaves the note pending, and the
    // idempotency key keeps a second enqueue of the same try from making a second delivery.
    entry.state = "queued";
    entry.reason = null;
    entry.deliveryId = await this.#hooks.enqueue({
      agentId: entry.agentId,
      runId: runIdOf(entry),
      title: restartResumeTitle(entry.attempt, entry.trigger),
      text: restartResumeText({
        kind: entry.kind,
        ...(live ? { trigger: "process" as const, cause: entry.cause ?? "closed" } : {}),
        interruptedAt: entry.interruptedAt,
        timezone: this.#hooks.timezone(),
        attempt: entry.attempt,
        subagents: agent.provider === "claude" ? subagents : [],
        requestText: entry.requestText,
        now: new Date(now).toISOString(),
      }),
    });
    this.#log(entry);
    return "queued";
  }

  #skip(entry: RestartResumeEntry, reason: string): void {
    if (entry.waitId) {
      try {
        this.#hooks.closeWait(entry.agentId, entry.waitId);
      } catch {}
    }
    entry.waitId = null;
    entry.state = "skipped";
    entry.reason = reason;
    this.#log(entry);
  }

  #log(entry: RestartResumeEntry): void {
    this.#hooks.log("Restart resume.", {
      agentId: entry.agentId,
      key: entry.key,
      state: entry.state,
      reason: entry.reason,
      attempt: entry.attempt,
    });
  }

  #save(): void {
    if (!this.#file) return;
    try {
      const temporary = `${this.#file}.tmp`;
      writeFileSync(temporary, JSON.stringify(this.#state, null, 2), { mode: 0o600 });
      renameSync(temporary, this.#file);
    } catch {}
  }
}

/** The routine name of the wake, which the chat shows as its line. Within the contract's 80 characters. */
export function restartResumeTitle(attempt: number, trigger?: "restart" | "process"): string {
  const title =
    trigger === "process"
      ? attempt > 1
        ? "🔄 Stopped subagent continues (second try)"
        : "🔄 Stopped subagent continues"
      : attempt > 1
        ? "🔄 Resumed after restart (second try)"
        : "🔄 Resumed after restart";
  return title.slice(0, INPUT_LIMITS.routineName);
}

/** The whole prompt of the wake. */
export function restartResumeText(input: {
  kind: RestartResumeKind;
  /** "process": the subagents stopped while OpenBot ran, because their Claude process ended. */
  trigger?: "restart" | "process";
  cause?: "closed" | "crashed";
  interruptedAt: string;
  timezone: string | undefined;
  attempt: number;
  subagents: readonly RestartResumeSubagent[];
  requestText: string;
  /** When the wake is built; a long gap since `interruptedAt` adds the time-sensitive check. */
  now?: string;
}): string {
  const at = localTime(input.interruptedAt, input.timezone);
  const downMs = input.now ? Date.parse(input.now) - Date.parse(input.interruptedAt) : 0;
  const longDowntime =
    downMs > RESTART_RESUME_LONG_DOWNTIME_MS
      ? `OpenBot was down for about ${downtimeText(downMs)}; it is now ${localTime(input.now ?? "", input.timezone)}. Go on with your work, but before any step that depends on time (a send or post planned for a certain time, a deadline, "today", "tonight", a live event), check that it still makes sense now. If it doesn't, skip that step and tell the user why instead of doing it late.`
      : null;
  const process = input.trigger === "process";
  const what = process
    ? `Your background subagents were stopped at ${at}: their Claude process ${input.cause === "crashed" ? "crashed" : "was closed by OpenBot (a settings, account or tool change)"} while OpenBot kept running — this is not a message from the user.`
    : input.kind === "subagents"
      ? `Your background subagents were stopped at ${at} by an OpenBot restart while you waited for them — this is not a message from the user.`
      : input.kind === "goal"
        ? `Your goal turns were stopped at ${at} by an OpenBot restart, between two turns — this is not a message from the user.`
        : `Your last turn was interrupted at ${at} by an OpenBot restart — this is not a message from the user.`;
  const subagents = input.subagents.filter((subagent) => subagent.title || subagent.providerAgentId);
  return [
    `[OpenBot: 🔄 restart] ${what}`,
    input.attempt > 1
      ? process
        ? "The subagents you continued after the first stop stopped again. This is the last automatic try."
        : "Your first resume after the restart was interrupted by another restart. This is the last automatic try."
      : null,
    longDowntime,
    subagents.length > 0
      ? `These subagents were stopped mid-task: ${subagents
          .map(
            (subagent) =>
              `${subagent.providerAgentId ?? "(agent ID unknown: see your Agent call)"} — ${subagent.title || "(no description)"}`,
          )
          .join("; ")}.`
      : null,
    "Before you redo anything, check what already happened (files, git, messages already sent). Never repeat sends, posts, payments or other outward actions.",
    subagents.length > 0
      ? `For each stopped subagent, continue it with SendMessage to its agent ID ("You were interrupted by ${process ? "a process stop" : "a restart"}; check what's done and continue") — do NOT launch it again from scratch.`
      : null,
    process
      ? "Then tell the user in one line that you continued it, and end your turn: its result comes back to you as before."
      : "Then continue your work. This is the same chat and session: you know what you did before the restart.",
    input.requestText ? "The request it continues:" : null,
    input.requestText || null,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

/** "45 minutes", "9 hours", "2 days". */
function downtimeText(ms: number): string {
  const hours = ms / 3_600_000;
  if (hours >= 48) return `${Math.round(hours / 24)} days`;
  if (hours >= 1.5) return `${Math.round(hours)} hours`;
  return `${Math.max(1, Math.round(ms / 60_000))} minutes`;
}

/** "15:12 on 6 Nov (Europe/Berlin)", in the user's zone. */
function localTime(iso: string, timezone: string | undefined): string {
  const date = new Date(iso);
  try {
    const zone = timezone ? { timeZone: timezone } : {};
    const time = new Intl.DateTimeFormat("en-GB", { ...zone, hour: "2-digit", minute: "2-digit" }).format(date);
    const day = new Intl.DateTimeFormat("en-GB", { ...zone, day: "numeric", month: "short" }).format(date);
    return `${time} on ${day}${timezone ? ` (${timezone})` : ""}`;
  } catch {
    return iso;
  }
}

function runIdOf(entry: RestartResumeEntry): string {
  return `restart-resume:${entry.attempt}:${entry.key}`.slice(0, INPUT_LIMITS.identifier);
}

export function parseRunId(runId: string): { attempt: number; key: string } | null {
  const match = /^restart-resume:(\d+):(.+)$/u.exec(runId);
  return match?.[1] && match[2] ? { attempt: Number(match[1]), key: match[2] } : null;
}

function attemptOfRun(delivery: QueueDelivery): number {
  return delivery.sender.kind === "routine" ? (parseRunId(delivery.sender.runId)?.attempt ?? 1) : 1;
}

function subagentNote(subagent: ConversationSubagent): RestartResumeSubagent {
  return {
    id: subagent.id,
    title: subagent.title,
    providerAgentId: subagent.providerAgentId ?? null,
    background: subagent.background === true,
  };
}

function mergeSubagents(
  earlier: readonly RestartResumeSubagent[],
  now: readonly RestartResumeSubagent[],
): RestartResumeSubagent[] {
  const byId = new Map(earlier.map((subagent) => [subagent.id, subagent]));
  for (const subagent of now) {
    const known = byId.get(subagent.id);
    byId.set(subagent.id, { ...subagent, providerAgentId: subagent.providerAgentId ?? known?.providerAgentId ?? null });
  }
  return [...byId.values()].slice(0, 24);
}

function isEntry(value: unknown): value is RestartResumeEntry {
  return (
    isDynamicRecord(value) &&
    typeof value.key === "string" &&
    typeof value.agentId === "string" &&
    typeof value.threadId === "string" &&
    typeof value.interruptedAt === "string" &&
    typeof value.capturedAt === "string" &&
    typeof value.attempt === "number" &&
    typeof value.state === "string" &&
    Array.isArray(value.deliveryIds) &&
    Array.isArray(value.subagents)
  );
}

function envNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 && process.env[name] !== "" && process.env[name] !== undefined
    ? value
    : fallback;
}
