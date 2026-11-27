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
import { agentProviderName, isAgentProvider } from "@openbot/contracts/agent-providers";
import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type { ConversationMessage, ConversationSubagent, QueueDelivery } from "@openbot/contracts/ipc";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { sourceText } from "@openbot/i18n/source";
import { isForkTeamRoutine } from "./fork-team-routines";

export const FORK_RESTART_RESUME_ROUTINE_ID = "fork-restart-resume";
/**
 * Fork (docs/fork/FEATURES.md, "Stopped subagents continue"): a client's notification that background
 * subagents of a session stopped because its process ended while OpenBot ran. `cause` is "closed"
 * (OpenBot closed the process), "crashed" (the process ended by itself) or "interrupted" (OpenBot
 * stopped the turn itself, and the CLI ended the subagents with it: #83).
 */
export const FORK_BACKGROUND_STOPPED_METHOD = "openbot/fork-background-stopped";
/**
 * A turn interrupted longer ago than this still gets its wake (the user wants every agent to go on),
 * but the wake says how long the app was down and to check time-sensitive steps before doing them late.
 */
const RESTART_RESUME_LONG_DOWNTIME_MS = 2 * 60 * 60_000;
/** The first wake and one more try when that wake's own turn is interrupted by a restart too. */
const RESTART_RESUME_MAX_ATTEMPTS = 2;
/**
 * Fork (docs/fork/FEATURES.md #136): the tries when each stop was OpenBot quitting (a rebuild, an update,
 * the user's Quit), not a crash. A lead's turn that user messages keep open for hours is the wake's own
 * turn after the first restart, and 5 quits in 83 minutes (27 Nov) ended it for good at the third.
 */
const RESTART_RESUME_MAX_QUIT_ATTEMPTS = 6;
/** Fork (#136): at most this many messages that came into the interrupted turn are named in the wake. */
const STEERED_LIMIT = 12;
const STEERED_TEXT_LIMIT = 600;
/** The routine id of `wait_until` wakes, which continue the agent's own work as a user message does. */
const WAIT_ROUTINE_ID = "fork-wait";
/** Fork (#130): the routine id of team follow-through wakes (`fork-follow-through.ts`, which imports this file). */
const FOLLOW_THROUGH_ROUTINE_ID = "fork-follow-through";
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
/** The skip reason when a message of the user waits in the queue and runs instead of the wake. */
const QUEUED_MESSAGE_RUNS = "a queued message runs instead";
const KEEP_MS = 24 * 60 * 60_000;
const REQUEST_LIMIT = 4_000;
/** Fork (#92): the longest task of one stopped subagent that a wake repeats. */
const SUBAGENT_TASK_LIMIT = 400;
/** The longest text of the finished subagents' answers in one wake. */
const FINISHED_RESULTS_LIMIT = 6_000;
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
  /** Fork (docs/fork/FEATURES.md #92): the subagent's task, for a provider whose agent starts it again. */
  prompt?: string | null;
  /**
   * Fork (docs/fork/FEATURES.md, "Stopped subagents continue"): the final answer of a subagent whose
   * transcript shows it finished just before the stop (its "done" was lost with the process). It is
   * handed to the agent instead of continuing the subagent.
   */
  result?: string;
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
  cause?: "closed" | "crashed" | "interrupted";
  /** For "process": the provider session the subagents ran in. The wake runs only there. */
  externalSessionId?: string;
  /**
   * Fork (docs/fork/FEATURES.md #113): the user's delivery that got the note instead of the wake
   * (`handOverNote`), so a rebuild of its prompt gets the same note once more.
   */
  handedTo?: string;
  /** Fork (docs/fork/FEATURES.md #126): noted as OpenBot quit; cleared when the next run starts. */
  quit?: true;
  /**
   * Fork (docs/fork/FEATURES.md #136): every stop of this work so far was OpenBot quitting, not a crash,
   * so it gets `RESTART_RESUME_MAX_QUIT_ATTEMPTS` tries.
   */
  cleanStops?: true;
  /**
   * Fork (#136): messages that came into the interrupted turn after the agent's last written answer
   * (steered in, or batched with the request). The wake names those that did not run again by themselves.
   */
  steered?: RestartResumeMessage[];
}

/** Fork (docs/fork/FEATURES.md #136): one message of the interrupted turn that the wake names. */
export interface RestartResumeMessage {
  deliveryId: string;
  /** "the user", or the sending agent's name and id. */
  from: string;
  at: string;
  text: string;
}

interface SavedState {
  version: 1;
  enabled: boolean;
  aliveAt: string | null;
  /** Fork (docs/fork/FEATURES.md #136): when the run stopped cleanly (`dispose`); null while it runs. */
  stoppedAt?: string | null;
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
  /** Claude only: the subagents, by agent ID, that finished before the stop, with their answers. */
  subagentOutcomes(
    agentId: string,
    externalSessionId: string,
    agentIds: readonly string[],
  ): Promise<Map<string, { finished: true; result: string }>>;
  /** A delivery of a channel or a messaging conversation: it runs in that thread. */
  executionDelivery(deliveryId: string): boolean;
  /** A turn runs, or a delivery starts, in the agent's own chat. */
  laneBusy(agentId: string): boolean;
  /** Messages that wait in the queue of the agent's own chat (not a plan continuation). */
  laneQueued(agentId: string): number;
  /**
   * Fork (docs/fork/FEATURES.md #136): of those, the user's. Only a message of the user runs instead of the
   * wake (with the hand-over note); a teammate's report or a routine run waits in the queue before the
   * wake, which goes on after it. Without the hook every queued message counts.
   */
  laneQueuedFromUser?(agentId: string): number;
  /** Fork (#136): a turn of the own chat that runs, or a delivery that starts, is the user's. */
  laneBusyWithUser?(agentId: string): boolean;
  /** Fork (#136): an agent's name, for the messages that the wake names. */
  agentName?(agentId: string): string | null;
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
  /** Fork (docs/fork/FEATURES.md #136): the previous run stopped cleanly (it quit; it did not crash). */
  readonly #previousCleanStop: boolean;
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
  /**
   * Fork (docs/fork/FEATURES.md #113): the notes that a message took over in this run (a queued message
   * at the restart, or a turn that started before the wake). The next message of the user gets them.
   */
  readonly #handOver = new Set<string>();

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
            stoppedAt: typeof saved.stoppedAt === "string" ? saved.stoppedAt : null,
            entries: Array.isArray(saved.entries) ? saved.entries.filter(isEntry) : [],
          };
        }
      } catch {}
    }
    const alive = this.#state.aliveAt ? Date.parse(this.#state.aliveAt) : Number.NaN;
    this.#previousAliveAt = Number.isFinite(alive) ? alive : null;
    this.#previousCleanStop = typeof this.#state.stoppedAt === "string";
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
    /**
     * Fork (docs/fork/FEATURES.md #126): noted as OpenBot quits, before an ACP provider (Antigravity,
     * Gemini) settles its turn as interrupted; boot recovery would then find no running turn.
     */
    quitting?: boolean;
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
    // The same interrupted turn seen again (a crash during this boot, or noted as OpenBot quit): its
    // note stands. A wake noted at the quit is already one try further.
    if (existing && (!wake || existing.quit)) return;
    const attempt = wake ? (earlier?.attempt ?? attemptOfRun(wake)) + 1 : 1;
    // Fork (docs/fork/FEATURES.md #136): OpenBot quit (noted now, or the previous run stopped cleanly).
    const cleanStop = input.quitting === true || this.#previousCleanStop;
    const cleanStops = cleanStop && (!wake || earlier?.cleanStops === true || earlier === null);
    // Fork (docs/fork/FEATURES.md #136): the user's first message of the turn is the request it continues;
    // the ones steered in after it are listed (`steered`). Before, the newest one replaced the request.
    const request =
      own.find((delivery) => delivery.sender.kind === "user") ??
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
      interruptedAt: (input.quitting ? now : new Date(this.#interruptedAt(own, messages, now))).toISOString(),
      capturedAt: now.toISOString(),
      requestText: (earlier?.requestText ?? (request && request !== wake ? request.text : "")).slice(0, REQUEST_LIMIT),
      subagents: mergeSubagents(earlier?.subagents ?? [], subagents),
      goal,
      attempt,
      state: "pending",
      reason: null,
      waitId: null,
      deliveryId: null,
      ...(input.quitting ? { quit: true as const } : {}),
      ...(cleanStops ? { cleanStops: true as const } : {}),
    };
    // Fork (docs/fork/FEATURES.md #136): the messages after the agent's last answer, newest last.
    const steered = this.#steeredMessages(own, messages, request && request !== wake ? request.id : null, wake?.id);
    const kept = mergeSteered(earlier?.steered ?? [], steered);
    if (kept.length > 0) entry.steered = kept;
    const reason = this.#captureSkip(entry, own, messages);
    if (reason) {
      entry.state = "skipped";
      entry.reason = reason;
      // Fork (docs/fork/FEATURES.md #113): the queued message runs instead, and tells the agent.
      if (reason === QUEUED_MESSAGE_RUNS) this.#handOver.add(key);
    }
    this.#state.entries = [...this.#state.entries.filter((item) => item.key !== key), entry];
    this.#save();
  }

  #captureSkip(
    entry: RestartResumeEntry,
    own: readonly QueueDelivery[],
    messages: readonly ConversationMessage[],
  ): string | null {
    if (entry.attempt > maxAttempts(entry)) return "retry limit: the resume was interrupted again";
    if (messages.some((message) => message.questionPrompt && message.questionPrompt.resolution === null))
      return "waited for the user's answer";
    for (const delivery of own) {
      if (this.#hooks.executionDelivery(delivery.id)) return "channel or messaging work";
      if (delivery.sender.kind !== "routine") continue;
      const { routineId } = delivery.sender;
      if (routineId === "fork-compact" || routineId === "fork-keepwarm") return "OpenBot upkeep (compact or keep-warm)";
      // Fork (docs/fork/FEATURES.md #130): a team follow-through wake is the agent's own work in its own
      // chat, like a wait's wake; its report is noted only once, so a restart resumes it.
      if (
        routineId !== WAIT_ROUTINE_ID &&
        routineId !== FORK_RESTART_RESUME_ROUTINE_ID &&
        routineId !== FOLLOW_THROUGH_ROUTINE_ID &&
        !isForkTeamRoutine(routineId) // Fork (docs/fork/FEATURES.md #135): team watchdog and team check.
      )
        return "routine run";
    }
    if (this.#queuedFromUser(entry.agentId) > 0) return QUEUED_MESSAGE_RUNS;
    return null;
  }

  /** Fork (docs/fork/FEATURES.md #136): queued messages that run instead of the wake: the user's. */
  #queuedFromUser(agentId: string): number {
    return this.#hooks.laneQueuedFromUser?.(agentId) ?? this.#hooks.laneQueued(agentId);
  }

  /** Fork (#136): a turn of the user runs or starts in the own chat; it takes the wake's place. */
  #busyWithUser(agentId: string): boolean {
    return this.#hooks.laneBusyWithUser?.(agentId) ?? this.#hooks.laneBusy(agentId);
  }

  /**
   * Fork (docs/fork/FEATURES.md #136): the messages of the interrupted turn, besides its request, that came
   * after the agent's last written answer of the turn: the ones it most likely had not handled yet.
   */
  #steeredMessages(
    own: readonly QueueDelivery[],
    messages: readonly ConversationMessage[],
    requestId: string | null,
    wakeId: string | undefined,
  ): RestartResumeMessage[] {
    const answered = messages
      .filter((message) => message.author === "assistant" && !message.itemType && message.text.trim() !== "")
      .map((message) => Date.parse(message.createdAt))
      .filter(Number.isFinite);
    const lastAnswer = answered.length > 0 ? Math.max(...answered) : Number.NEGATIVE_INFINITY;
    return own
      .filter(
        (delivery) =>
          delivery.id !== requestId &&
          delivery.id !== wakeId &&
          delivery.sender.kind !== "routine" &&
          Date.parse(delivery.createdAt) > lastAnswer,
      )
      .map((delivery) => ({
        deliveryId: delivery.id,
        from:
          delivery.sender.kind === "agent"
            ? `${this.#hooks.agentName?.(delivery.sender.agentId) ?? "an agent"} (${delivery.sender.agentId})`
            : "the user",
        at: delivery.createdAt,
        text: delivery.text.slice(0, STEERED_TEXT_LIMIT),
      }));
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
    this.#state.stoppedAt = null; // Fork (docs/fork/FEATURES.md #136)
    const cutoff = Date.now() - KEEP_MS;
    this.#state.entries = this.#state.entries.filter((entry) => Date.parse(entry.capturedAt) >= cutoff);
    for (const entry of this.#state.entries) {
      // Fork (docs/fork/FEATURES.md #126): the hand-over list lives in memory, so a note taken at the
      // quit that a queued message took over gets it again in this run.
      if (entry.quit) {
        delete entry.quit;
        if (entry.state === "skipped" && entry.reason === QUEUED_MESSAGE_RUNS) this.#handOver.add(entry.key);
      }
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
      this.#state.stoppedAt = this.#state.aliveAt; // Fork (docs/fork/FEATURES.md #136): a clean stop.
      this.#save();
    }
  }

  /**
   * A turn started in an agent's own chat: a wake not queued yet is no longer wanted. Fork
   * (docs/fork/FEATURES.md #136): only a turn of the user takes the wake's place; after a teammate's
   * report or a routine run the wake still runs (`fromUser` false).
   */
  turnStarted(agentId: string, threadId: string, fromUser = true): void {
    if (fromUser && this.#hooks.agent(agentId)?.threadId === threadId) this.#turnStartedAt.set(agentId, Date.now());
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
    cause: "closed" | "crashed" | "interrupted";
    subagents: ReadonlyArray<{ id: string; title: string; providerAgentId: string | null; prompt?: string | null }>;
  }): void {
    // Before start, at boot or while OpenBot quits: the restart resume notes the subagents instead.
    if (this.#startedAt === 0 || !this.#hooks.isRunning() || input.subagents.length === 0) return;
    const agent = this.#hooks.agent(input.agentId);
    // Channel, messaging and task threads have no wake; an agent being deleted needs none.
    if (!agent || agent.threadId !== input.threadId) return;
    const title = input.subagents.map((subagent) => subagent.title || "subagent").join("”, “");
    if (!this.enabled()) {
      this.#hooks.line(
        input.agentId,
        agent.provider === "claude"
          ? sourceText("status.agent.subagentResumeOff", { title })
          : sourceText("status.agent.processSubagentResumeOff", { title, provider: providerName(agent.provider) }),
      );
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
      ...(subagent.prompt ? { prompt: subagent.prompt.slice(0, SUBAGENT_TASK_LIMIT) } : {}),
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
        note:
          agent.provider === "claude"
            ? sourceText("status.agent.subagentResumeWait")
            : sourceText("status.agent.processSubagentResumeWait", { provider: providerName(agent.provider) }),
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
    const agent = this.#hooks.agent(entry.agentId);
    // An agent that is gone has no chat to write in.
    if (!agent) return;
    // Fork (#92): the lines name the Claude process; another provider's name its own.
    const provider = providerName(agent.provider);
    const text =
      agent.provider !== "claude"
        ? line === "status.agent.subagentResumeLimit"
          ? sourceText("status.agent.processSubagentResumeLimit", {
              title,
              provider,
              count: String(LIVE_WAKES_PER_HOUR),
            })
          : line === "status.agent.subagentResumeNotReady"
            ? sourceText("status.agent.processSubagentResumeNotReady", { title, provider })
            : sourceText("status.agent.processSubagentResumeTookOver", { title, provider })
        : line === "status.agent.subagentResumeLimit"
          ? sourceText(line, { title, count: String(LIVE_WAKES_PER_HOUR) })
          : line === "status.agent.subagentResumeNotReady"
            ? sourceText(line, { title, provider: extra.provider ?? "the provider" })
            : sourceText(line, { title });
    this.#hooks.line(entry.agentId, text);
  }

  /**
   * Fork (docs/fork/FEATURES.md #113): the user wrote in the agent's own chat before the wake ran (or
   * a message waited in the queue at the restart). That message runs instead of the wake, and without
   * this the agent never learned that its turn or its background subagents had been stopped, so they
   * stayed stopped. Gives the note to put before the user's message, once per note: the wait closes,
   * and the note is not woken any more. The same delivery asking again (its prompt rebuilt) gets the
   * same note. Null for a slash command (the provider runs it only at the start of the prompt), a task
   * or channel thread, a note of a process stop (it has its own line), or nothing to tell.
   */
  handOverNote(input: { agentId: string; deliveryId: string; typed: string }): string | null {
    if (!this.enabled() || /^\/[\w:-]+(?=$|\s)/u.test(input.typed.trim())) return null;
    const agent = this.#hooks.agent(input.agentId);
    if (!agent?.threadId) return null;
    const notes = this.#state.entries.filter(
      (entry) =>
        entry.agentId === input.agentId &&
        entry.threadId === agent.threadId &&
        entry.trigger !== "process" &&
        (entry.handedTo === input.deliveryId ||
          (entry.handedTo === undefined &&
            (entry.state === "pending" || (entry.state === "skipped" && this.#handOver.has(entry.key))))),
    );
    if (notes.length === 0) return null;
    // Only a message of the agent's own chat: not a task thread, a channel or a messaging chat.
    if (!this.#hooks.unresolvedOwnDeliveries(input.agentId).some((delivery) => delivery.id === input.deliveryId))
      return null;
    for (const entry of notes) {
      if (entry.state === "pending") this.#skip(entry, "another turn started since the restart");
      this.#handOver.delete(entry.key);
      entry.handedTo = input.deliveryId;
    }
    this.#save();
    return restartHandOverText({
      notes: notes.map((entry) => ({
        kind: entry.kind,
        interruptedAt: entry.interruptedAt,
        subagents: entry.subagents,
        requestText: entry.requestText,
        // Fork (docs/fork/FEATURES.md #136): the messages that came into the stopped turn, not the one that runs now.
        steered: (entry.steered ?? []).filter((message) => message.deliveryId !== input.deliveryId),
      })),
      timezone: this.#hooks.timezone(),
      provider: agent.provider,
    });
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
      if (!live) {
        // Fork (docs/fork/FEATURES.md #113): the message that came first gets the note instead.
        this.#handOver.add(entry.key);
        return skip(reason);
      }
      this.#skipLive(entry, reason, "status.agent.subagentResumeTookOver");
      return "skipped" as const;
    };
    if (agent.threadId !== entry.threadId) return skip("a new chat replaced the interrupted one");
    if ((this.#turnStartedAt.get(entry.agentId) ?? 0) >= Date.parse(entry.capturedAt))
      return tookOver(live ? "another turn started since the stop" : "another turn started since the restart");
    if (entry.kind === "goal" && !this.#hooks.goalWorking(entry.agentId)) return skip("the goal no longer runs");
    if (this.#queuedFromUser(entry.agentId) > 0) return tookOver(QUEUED_MESSAGE_RUNS);
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
    // Boot recovery settles the interrupted deliveries once the provider is ready. Fork (docs/fork/FEATURES.md
    // #136): a teammate's report that it queued again (`requeueAfterRestart`) runs by itself; it is settled.
    const deliveries = entry.deliveryIds.map((id) => this.#hooks.delivery(id));
    const ranAgain = (delivery: QueueDelivery | null) =>
      delivery !== null &&
      entry.turnId !== null &&
      delivery.turnId !== entry.turnId &&
      delivery.status !== "interrupted" &&
      delivery.status !== "failed" &&
      delivery.status !== "cancelled";
    const statuses = deliveries.map((delivery) => delivery?.status ?? "missing");
    if (
      deliveries.some(
        (delivery) =>
          !ranAgain(delivery) &&
          (delivery?.status === "queued" || delivery?.status === "starting" || delivery?.status === "running"),
      )
    ) {
      tries.settle ??= now;
      return now - tries.settle > SETTLE_WAIT_MS() ? skip("the interrupted turn did not settle") : "later";
    }
    if (entry.kind === "turn" && statuses.length > 0 && statuses.every((status) => status === "completed"))
      return skip("the interrupted turn had completed");
    if (
      entry.kind === "turn" &&
      deliveries.length > 0 &&
      deliveries.every((d) => ranAgain(d) || d?.status === "completed")
    )
      return skip("the interrupted messages run again");
    if (this.#busyWithUser(entry.agentId)) return tookOver("another turn runs");
    const session = this.#hooks.session(entry.agentId, entry.threadId);
    // `SendMessage` finds a subagent only in the session it ran in: a context reset, an account or
    // provider change gives the chat a new one. Fork (#92): another provider's agent is told what
    // stopped in the session that the chat has now, or in a new one that the wake starts: a refresh
    // after an MCP change gives an Antigravity chat a new session.
    const sameSessionOnly = agent.provider === "claude";
    if (live && sameSessionOnly && session?.externalSessionId !== entry.externalSessionId) {
      this.#skipLive(entry, "the provider session changed", "status.agent.subagentResumeSessionChanged");
      return "skipped";
    }
    // Fork (docs/fork/FEATURES.md #136): a Gemini (Antigravity) chat whose session is gone continues in a
    // new one, and the wake says so (`freshSession`).
    if (!session && (sameSessionOnly || (!live && agent.provider !== "antigravity")))
      return skip("provider session gone", sourceText("status.agent.restartResumeSessionGone"));
    let subagents = entry.subagents;
    if (session && agent.provider === "claude" && subagents.some((subagent) => !subagent.providerAgentId)) {
      const ids = await this.#hooks.subagentIds(entry.agentId, session.externalSessionId).catch(() => new Map());
      subagents = subagents.map((subagent) => ({
        ...subagent,
        providerAgentId: subagent.providerAgentId ?? ids.get(subagent.id) ?? null,
      }));
      entry.subagents = subagents;
    }
    // A subagent whose transcript ends with its final answer finished just before the stop: its
    // answer is handed over, and it is not continued (it would only repeat that it is done).
    const known = subagents.flatMap((subagent) => (subagent.providerAgentId ? [subagent.providerAgentId] : []));
    if (session && agent.provider === "claude" && known.length > 0) {
      const outcomes = await this.#hooks
        .subagentOutcomes(entry.agentId, session.externalSessionId, known)
        .catch(() => new Map<string, { finished: true; result: string }>());
      subagents = subagents.map((subagent) => {
        const outcome = subagent.providerAgentId ? outcomes.get(subagent.providerAgentId) : undefined;
        return outcome ? { ...subagent, result: outcome.result } : subagent;
      });
      entry.subagents = subagents;
    }
    // Again after the await. From here to the queued delivery nothing waits, so no turn slips in.
    if (entry.waitId && !this.#hooks.waitOpen(entry.agentId, entry.waitId)) {
      entry.waitId = null;
      entry.state = "cancelled";
      entry.reason = "cancelled by the user";
      return "skipped";
    }
    if (this.#busyWithUser(entry.agentId) || this.#queuedFromUser(entry.agentId) > 0)
      return tookOver("another turn runs");
    // Fork (#136): the messages of the interrupted turn that did not run again by themselves.
    const steered = (entry.steered ?? []).filter((message) => {
      const delivery = this.#hooks.delivery(message.deliveryId);
      return delivery === null || !ranAgain(delivery);
    });
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
        subagents: agent.provider === "claude" || agent.provider === "antigravity" ? subagents : [],
        requestText: entry.requestText,
        now: new Date(now).toISOString(),
        provider: agent.provider,
        steered,
        freshSession: !session,
        lastTry: entry.attempt >= maxAttempts(entry),
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

/** The longest request that a hand-over note repeats: the user's own message follows it. */
const HAND_OVER_REQUEST_LIMIT = 1_000;

/**
 * Fork (docs/fork/FEATURES.md #113): the note before a message of the user that came before the
 * restart's wake. It says what the restart stopped, names the stopped subagents as the wake does, and
 * leaves the order to the agent: the user's message first, then the stopped work if it is still wanted.
 */
export function restartHandOverText(input: {
  notes: ReadonlyArray<Pick<RestartResumeEntry, "kind" | "interruptedAt" | "subagents" | "requestText" | "steered">>;
  timezone: string | undefined;
  provider: string;
}): string {
  const first = input.notes[0];
  const at = localTime(first?.interruptedAt ?? new Date().toISOString(), input.timezone);
  const kinds = new Set(input.notes.map((note) => note.kind));
  const what = [
    kinds.has("turn") ? "your last turn was interrupted" : null,
    kinds.has("subagents") ? "your background subagents were stopped while you waited for them" : null,
    kinds.has("goal") ? "your goal turns were stopped between two turns" : null,
  ].filter((part): part is string => part !== null);
  const claude = input.provider === "claude";
  const antigravity = input.provider === "antigravity";
  const subagents =
    claude || antigravity
      ? mergeSubagents(
          [],
          input.notes.flatMap((note) => note.subagents),
        ).filter((subagent) => subagent.title || subagent.providerAgentId)
      : [];
  const name = (subagent: RestartResumeSubagent) =>
    `${subagent.providerAgentId ?? (claude ? "(agent ID unknown: see your Agent call)" : "(conversation ID unknown)")} — ${subagent.title || "(no description)"}`;
  const request = input.notes.map((note) => note.requestText).find((text) => text.trim() !== "") ?? "";
  return [
    `[OpenBot: 🔄 restart note] At ${at} an OpenBot restart stopped your work: ${what.join("; ") || "your last turn was interrupted"}. This note is from OpenBot, not from the user. The user wrote the message below before you were resumed, so it runs now instead of the automatic resume.`,
    subagents.length > 0 ? `These subagents were stopped mid-task: ${subagents.map(name).join("; ")}.` : null,
    "Answer the user's message first. Then, unless that message replaces or cancels the stopped work, continue it: check what already happened (files, git, messages already sent), never repeat sends, posts, payments or other outward actions.",
    subagents.length > 0
      ? claude
        ? 'Continue each stopped subagent with SendMessage to its agent ID ("You were interrupted by a restart; check what\'s done and continue") — do NOT launch it again from scratch. Its result comes back to you as before.'
        : "A stopped subagent does not report back and cannot be continued: check what it already did, then start a new subagent with invoke_subagent only for the work that is left."
      : null,
    request ? "The request that was stopped:" : null,
    request ? request.slice(0, HAND_OVER_REQUEST_LIMIT) : null,
    steeredText(
      input.notes.flatMap((note) => note.steered ?? []),
      input.timezone,
    ),
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
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
  cause?: "closed" | "crashed" | "interrupted";
  interruptedAt: string;
  timezone: string | undefined;
  attempt: number;
  subagents: readonly RestartResumeSubagent[];
  requestText: string;
  /** When the wake is built; a long gap since `interruptedAt` adds the time-sensitive check. */
  now?: string;
  /** Fork (#92): the agent's provider. Antigravity's subagents are continued with its own tools. */
  provider?: string;
  /** Fork (docs/fork/FEATURES.md #136): messages of the interrupted turn the agent may not have handled. */
  steered?: readonly RestartResumeMessage[];
  /** Fork (#136): the earlier provider session is gone; the wake runs in a new one. */
  freshSession?: boolean;
  /** Fork (#136): no automatic try follows this one. Without it, any try after the first is the last. */
  lastTry?: boolean;
}): string {
  if (input.provider === "antigravity") return antigravityResumeText(input);
  const at = localTime(input.interruptedAt, input.timezone);
  const downMs = input.now ? Date.parse(input.now) - Date.parse(input.interruptedAt) : 0;
  const longDowntime =
    downMs > RESTART_RESUME_LONG_DOWNTIME_MS
      ? `OpenBot was down for about ${downtimeText(downMs)}; it is now ${localTime(input.now ?? "", input.timezone)}. Go on with your work, but before any step that depends on time (a send or post planned for a certain time, a deadline, "today", "tonight", a live event), check that it still makes sense now. If it doesn't, skip that step and tell the user why instead of doing it late.`
      : null;
  const process = input.trigger === "process";
  const what = process
    ? input.cause === "interrupted"
      ? `Your background subagents were stopped at ${at}: OpenBot ended your turn by itself (not the user), and Claude Code ends background subagents with the turn. Claude Code's "[Request interrupted by user]" and "stopped by the user or by the app connected to this session" notes mean OpenBot here — the user did NOT stop your work and wants it to go on.`
      : `Your background subagents were stopped at ${at}: their Claude process ${input.cause === "crashed" ? "crashed" : "was closed by OpenBot (a settings, account or tool change)"} while OpenBot kept running — this is not a message from the user.`
    : input.kind === "subagents"
      ? `Your background subagents were stopped at ${at} by an OpenBot restart while you waited for them — this is not a message from the user.`
      : input.kind === "goal"
        ? `Your goal turns were stopped at ${at} by an OpenBot restart, between two turns — this is not a message from the user.`
        : `Your last turn was interrupted at ${at} by an OpenBot restart — this is not a message from the user.`;
  const named = input.subagents.filter((subagent) => subagent.title || subagent.providerAgentId);
  // Fork (docs/fork/FEATURES.md, "Stopped subagents continue"): finished ones hand over their answer.
  const finished = named.filter((subagent) => subagent.result !== undefined);
  const subagents = named.filter((subagent) => subagent.result === undefined);
  const name = (subagent: RestartResumeSubagent) =>
    `${subagent.providerAgentId ?? "(agent ID unknown: see your Agent call)"} — ${subagent.title || "(no description)"}`;
  let budget = FINISHED_RESULTS_LIMIT;
  const results = finished.map((subagent) => {
    const result = (subagent.result ?? "").slice(0, Math.max(0, budget));
    budget -= result.length;
    return `${name(subagent)}. Its final answer:\n${result || "(see its transcript)"}`;
  });
  return [
    `[OpenBot: 🔄 restart] ${what}`,
    input.attempt > 1
      ? process
        ? "The subagents you continued after the first stop stopped again. This is the last automatic try."
        : input.lastTry === false
          ? `Your resume after the restart was interrupted by another restart; this is automatic try ${input.attempt}.`
          : "Your first resume after the restart was interrupted by another restart. This is the last automatic try."
      : null,
    longDowntime,
    input.freshSession ? FRESH_SESSION_LINE : null,
    finished.length > 0
      ? `These subagents had finished just before the stop; only their "done" notification was lost. Do NOT continue or relaunch them — use their answers as if they had reported:\n${results.join("\n\n")}`
      : null,
    subagents.length > 0 ? `These subagents were stopped mid-task: ${subagents.map(name).join("; ")}.` : null,
    "Before you redo anything, check what already happened (files, git, messages already sent). Never repeat sends, posts, payments or other outward actions.",
    subagents.length > 0
      ? `For each stopped subagent, continue it with SendMessage to its agent ID ("You were interrupted by ${process ? "a process stop" : "a restart"}; check what's done and continue") — do NOT launch it again from scratch.`
      : null,
    process
      ? subagents.length > 0
        ? "Then tell the user in one line that you continued it, and end your turn: its result comes back to you as before."
        : "Then go on as you would have when they reported: tell the user the result, or continue your work with it."
      : input.freshSession
        ? "Then continue your work."
        : "Then continue your work. This is the same chat and session: you know what you did before the restart.",
    input.requestText ? "The request it continues:" : null,
    input.requestText || null,
    steeredText(input.steered ?? [], input.timezone),
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

/**
 * Fork (docs/fork/FEATURES.md #92): the wake of an Antigravity agent whose subagents stopped. They
 * ran in the process of the agent's session, are conversations of their own (`brain/<id>`), and
 * report with `send_message`. A subagent that a process stop ended does not restart by itself (lab
 * `RE-antigravity-restart-resume`, run R1). A `send_message` from its parent's own conversation
 * continues it once a client opened both again (run R2), but OpenBot does not do that: a refresh
 * gives the chat a new session, because a resume keeps the MCP servers that the session had (run R3),
 * and its report would go to the old conversation. So the agent starts the work that is left again.
 */
function antigravityResumeText(input: Parameters<typeof restartResumeText>[0]): string {
  const at = localTime(input.interruptedAt, input.timezone);
  const process = input.trigger === "process";
  const what = process
    ? `Your subagents were stopped at ${at}: ${input.cause === "crashed" ? "the Antigravity process they ran in ended by itself" : "OpenBot closed the Antigravity process they ran in (a settings, MCP or account change)"} while OpenBot kept running — this is not a message from the user. A stopped subagent does not report back, so do not wait for it.`
    : `Your subagents were stopped at ${at} by an OpenBot restart — this is not a message from the user. A stopped subagent does not report back, so do not wait for it.`;
  const named = input.subagents.filter((subagent) => subagent.title || subagent.providerAgentId);
  // Fork (docs/fork/FEATURES.md #136): a stopped turn without subagents is worded as one (it said
  // "Your subagents were stopped" to a lead whose own turn the quit had stopped).
  const turnOnly = !process && named.length === 0 && input.kind !== "subagents";
  const said = turnOnly
    ? input.kind === "goal"
      ? `Your goal turns were stopped at ${at} by an OpenBot restart, between two turns — this is not a message from the user.`
      : `Your last turn was interrupted at ${at} by an OpenBot restart — this is not a message from the user.`
    : what;
  const task = (subagent: RestartResumeSubagent) =>
    subagent.prompt ? ` (task: ${subagent.prompt.replace(/\s+/gu, " ").trim()})` : "";
  const name = (subagent: RestartResumeSubagent) =>
    `${subagent.providerAgentId ?? "(conversation ID unknown)"} — ${subagent.title || "(no role)"}${task(subagent)}`;
  return [
    `[OpenBot: 🔄 restart] ${said}`,
    input.attempt > 1
      ? input.lastTry === false && !process
        ? `Your resume after the restart was interrupted by another restart; this is automatic try ${input.attempt}.`
        : "The subagents stopped again after the first try. This is the last automatic try."
      : null,
    input.freshSession ? FRESH_SESSION_LINE : null,
    named.length > 0 ? `These subagents were stopped mid-task: ${named.map(name).join("; ")}.` : null,
    "Before you redo anything, check what already happened (files, git, messages already sent). Never repeat sends, posts, payments or other outward actions.",
    named.length > 0
      ? "They cannot be continued from here. For each one, check what it already did, then start a new subagent with invoke_subagent only for the work that is left, and tell it what is already done."
      : null,
    named.length > 0
      ? "Then tell the user in one line what you did, and end your turn: the subagents' reports come back to you as before."
      : "Then continue your work.",
    input.requestText ? "The request it continues:" : null,
    input.requestText || null,
    steeredText(input.steered ?? [], input.timezone),
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

/** Fork (docs/fork/FEATURES.md #136): the earlier provider session could not be kept. */
const FRESH_SESSION_LINE =
  "OpenBot could not reopen your earlier provider session, so this is a new one and you do not remember that turn: rebuild what you need from the request below, the files you wrote, git and the messages you sent before you go on.";

/**
 * Fork (docs/fork/FEATURES.md #136): the messages that came into the interrupted turn after the agent's
 * last answer (the lead's updates, a teammate's report, the user's follow-ups): the restart stopped the
 * turn before the agent handled them, and nothing else brings them back.
 */
function steeredText(messages: readonly RestartResumeMessage[], timezone: string | undefined): string | null {
  if (messages.length === 0) return null;
  const lines = messages
    .slice(-STEERED_LIMIT)
    .map(
      (message) =>
        `- ${localTime(message.at, timezone)}, from ${message.from}: ${message.text.replace(/\s+/gu, " ").trim()}`,
    );
  return [
    `These messages came into that turn after your last answer, and the restart stopped it before you handled them. Handle each one now (answer, act on it, or reply to its sender with openbot.send_message as it asks):`,
    ...lines,
  ].join("\n");
}

/** Fork (#136): the tries this work gets. */
function maxAttempts(entry: Pick<RestartResumeEntry, "cleanStops">) {
  return entry.cleanStops ? RESTART_RESUME_MAX_QUIT_ATTEMPTS : RESTART_RESUME_MAX_ATTEMPTS;
}

/** Fork (#136): the messages of earlier tries and of this one, each once, oldest first. */
function mergeSteered(
  earlier: readonly RestartResumeMessage[],
  now: readonly RestartResumeMessage[],
): RestartResumeMessage[] {
  const byId = new Map(earlier.map((message) => [message.deliveryId, message]));
  for (const message of now) byId.set(message.deliveryId, message);
  return [...byId.values()].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).slice(-STEERED_LIMIT);
}

/** "45 minutes", "9 hours", "2 days". */
function downtimeText(ms: number): string {
  const hours = ms / 3_600_000;
  if (hours >= 48) return `${Math.round(hours / 24)} days`;
  if (hours >= 1.5) return `${Math.round(hours)} hours`;
  return `${Math.max(1, Math.round(ms / 60_000))} minutes`;
}

/**
 * "15:12 on 6 Nov (Europe/Berlin)", in the user's zone. Fork (docs/fork/FEATURES.md #130): team
 * follow-through words its times the same way.
 */
export function localTime(iso: string, timezone: string | undefined): string {
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
    ...(subagent.prompt ? { prompt: subagent.prompt.slice(0, SUBAGENT_TASK_LIMIT) } : {}),
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

/** Fork (#92): the name that the chat's lines give a provider. */
function providerName(provider: string): string {
  return isAgentProvider(provider) ? agentProviderName(provider) : provider;
}
