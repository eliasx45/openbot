/**
 * Fork (docs/fork/FEATURES.md #135, "Team watchdogs and guards"): a lead agent that manages teammates
 * with `openbot.send_message` hears when a teammate that works on one of its requests looks stuck,
 * instead of only when the user asks ("is Chopper still alive?"). Modelled on team follow-through
 * (#130, `fork-follow-through.ts`).
 *
 * For each open request of an agent to a teammate (no reply yet, `fork-team-guards.ts`), three patterns:
 * - quiet: the teammate's turn that handles it runs, and nothing new came from it (no step, no output)
 *   for `QUIET_MS` (20 min); not while the teammate holds a declared wait (`wait_until`, `await_event`)
 *   or holds its turn open for background subagents after an answer (Antigravity, Claude);
 * - looping: in that turn, the last `LOOP_REPEATS` (4) tool calls were the same call, or the last
 *   `LOOP_FAILURES` (3) tool calls failed;
 * - overdue: the request's `dueMinutes` passed without a reply.
 *
 * A sweep every `SWEEP_MS` (60 s) gives each lead one wake for all its new flags, only while its own
 * chat is idle and its provider is ready, at most one per `GAP_MS` (5 min); each request gets at most
 * one wake per pattern. The wake is a delivery with a routine sender (`routineId` `fork-team-watchdog`,
 * no real routine), like the follow-through wake: its text is the whole prompt, it runs in the lead's
 * own session, it resumes after a restart, and the lead may end it quietly with `routine_no_update`.
 * The marks of what a wake named are kept with the request details (`fork-team-watchdog.json`), and the
 * wake's idempotency key is its first flag, so a restart wakes no one twice. The tool calls of running
 * turns are kept in memory only: a restart ends those turns anyway. `OPENBOT_FORK_TEAM_WATCHDOG=0`
 * turns it off.
 */

import { toolCallName } from "./agent/thread-items";
import { localTime } from "./fork-restart-resume";
import {
  excerpt,
  type TeamMetaStore,
  type TeamRequestMeta,
  type TeamRequestRecord,
  teamOpenWindowMs,
} from "./fork-team-guards";
import { FORK_TEAM_WATCHDOG_ROUTINE_ID } from "./fork-team-routines";
import type { ThreadItem } from "./protocol";

export { FORK_TEAM_WATCHDOG_ROUTINE_ID, FORK_TEAM_WATCHDOG_ROUTINE_NAME } from "./fork-team-routines";
export const FORK_TEAM_WATCHDOG_HEADER = "[OpenBot: 🐕 team watchdog]";

/** Test switches: `OPENBOT_FORK_TEAM_WATCHDOG_SWEEP_MS`, `..._QUIET_MS`, `..._GAP_MS`, `..._LOOP_REPEATS`, `..._LOOP_FAILURES`. */
const SWEEP_MS = () => envNumber("OPENBOT_FORK_TEAM_WATCHDOG_SWEEP_MS", 60_000);
export const watchdogThresholds = () => ({
  quietMs: envNumber("OPENBOT_FORK_TEAM_WATCHDOG_QUIET_MS", 20 * 60_000),
  repeats: Math.max(2, envNumber("OPENBOT_FORK_TEAM_WATCHDOG_LOOP_REPEATS", 4)),
  failures: Math.max(1, envNumber("OPENBOT_FORK_TEAM_WATCHDOG_LOOP_FAILURES", 3)),
});
const GAP_MS = () => envNumber("OPENBOT_FORK_TEAM_WATCHDOG_GAP_MS", 5 * 60_000);
const TOOL_LOG_TURNS = 200;
const TOOL_LOG_STEPS = 64;
const SIGNATURE_KEYS = ["arguments", "input", "rawInput", "command", "path", "file_path", "pattern", "query", "url"];

export function teamWatchdogEnabled(): boolean {
  return process.env.OPENBOT_FORK_TEAM_WATCHDOG !== "0";
}

export type WatchPattern = "quiet" | "looping" | "overdue";

/** One tool call of a running turn. */
export interface WatchToolStep {
  itemId: string;
  name: string;
  /** The tool and its arguments: equal for the same call. */
  signature: string;
  startedAt: number;
  endedAt: number | null;
  failed: boolean;
}

/** The tool calls of running turns, as the turn's items arrive (`TurnLifecycle`). */
export class TurnToolLog {
  readonly #turns = new Map<string, WatchToolStep[]>();

  observe(turnId: string, item: ThreadItem, completed: boolean, failed: boolean, now = Date.now()): void {
    const itemId = typeof item.id === "string" ? item.id : null;
    if (!turnId || !itemId) return;
    let steps = this.#turns.get(turnId);
    if (!steps) {
      steps = [];
      this.#turns.set(turnId, steps);
      for (const oldest of this.#turns.keys()) {
        if (this.#turns.size <= TOOL_LOG_TURNS) break;
        this.#turns.delete(oldest);
      }
    }
    const name = toolCallName(item) ?? item.type;
    let step = steps.find((candidate) => candidate.itemId === itemId);
    if (!step) {
      step = { itemId, name, signature: signature(name, item), startedAt: now, endedAt: null, failed: false };
      steps.push(step);
      if (steps.length > TOOL_LOG_STEPS) steps.splice(0, steps.length - TOOL_LOG_STEPS);
    }
    step.name = name;
    // The arguments can come in later updates of the item; the last one has them all.
    step.signature = signature(name, item);
    if (completed && step.endedAt === null) {
      step.endedAt = now;
      step.failed = failed;
    }
  }

  steps(turnId: string): readonly WatchToolStep[] {
    return this.#turns.get(turnId) ?? [];
  }

  drop(turnId: string): void {
    this.#turns.delete(turnId);
  }
}

function signature(name: string, item: ThreadItem): string {
  const parts = SIGNATURE_KEYS.flatMap((key) => (item[key] === undefined ? [] : [[key, item[key]]]));
  return `${name} ${stableJson(Object.fromEntries(parts))}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

/** A loop in the finished tool calls since `since`: the same call again and again, or failures in a row. */
export function loopEvidence(
  steps: readonly WatchToolStep[],
  since: number,
  limits: { repeats: number; failures: number },
): { kind: "same-call" | "failures"; count: number; name: string; signature: string; lastAt: number } | null {
  const done = steps.filter((step) => step.endedAt !== null && step.startedAt >= since);
  const last = done.at(-1);
  if (!last || last.endedAt === null) return null;
  let same = 0;
  for (let index = done.length - 1; index >= 0 && done[index]?.signature === last.signature; index -= 1) same += 1;
  if (same >= limits.repeats)
    return { kind: "same-call", count: same, name: last.name, signature: last.signature, lastAt: last.endedAt };
  let failed = 0;
  for (let index = done.length - 1; index >= 0 && done[index]?.failed; index -= 1) failed += 1;
  if (failed >= limits.failures)
    return { kind: "failures", count: failed, name: last.name, signature: last.signature, lastAt: last.endedAt };
  return null;
}

/** What the watchdog knows of the teammate's work on a request. */
export interface WatchTeammate {
  /** When the turn that handles the request started, while it runs; null when it does not run. */
  turnStartedAt: number | null;
  lastEventAt: number | null;
  /** The note of a wait the teammate declared (`wait_until`, `await_event`), or null. */
  declaredWait: string | null;
  /** The turn waits for background subagents after an answer. */
  backgroundHold: boolean;
  steps: readonly WatchToolStep[];
}

export interface WatchFlag {
  key: string;
  requestId: string;
  leadId: string;
  teammateId: string;
  pattern: WatchPattern;
  requestText: string;
  requestAt: string;
  evidence: string;
}

export function flagKey(requestId: string, teammateId: string, pattern: WatchPattern): string {
  return `${requestId}:${teammateId}:${pattern}`;
}

export function watchdogWakeKey(flag: string): string {
  return `${FORK_TEAM_WATCHDOG_ROUTINE_ID}:${flag}`;
}

/** The patterns that one teammate's work on one request shows now. */
export function watchFlags(input: {
  request: TeamRequestRecord;
  delivery: TeamRequestRecord["deliveries"][number];
  meta: TeamRequestMeta | undefined;
  teammate: WatchTeammate;
  now: number;
  thresholds: { quietMs: number; repeats: number; failures: number };
  timezone: string | undefined;
}): WatchFlag[] {
  const { request, delivery, meta, teammate, now, thresholds } = input;
  if (delivery.repliedAt !== null) return [];
  const time = (at: number) => localTime(new Date(at).toISOString(), input.timezone);
  const flag = (pattern: WatchPattern, evidence: string): WatchFlag => ({
    key: flagKey(request.id, delivery.recipientAgentId, pattern),
    requestId: request.id,
    leadId: request.senderAgentId,
    teammateId: delivery.recipientAgentId,
    pattern,
    requestText: request.text,
    requestAt: request.createdAt,
    evidence,
  });
  const flags: WatchFlag[] = [];
  const running = delivery.status === "running" && teammate.turnStartedAt !== null;
  const start = Math.max(teammate.turnStartedAt ?? 0, delivery.steeredAt ? Date.parse(delivery.steeredAt) : 0);
  const steps = teammate.steps.filter((step) => step.startedAt >= start);
  const lastStep = steps.at(-1);
  const lastStepText = lastStep
    ? `last step: \`${lastStep.name}\` at ${time(lastStep.endedAt ?? lastStep.startedAt)}${lastStep.endedAt === null ? ", still running" : lastStep.failed ? ", failed" : ""}`
    : "no tool step since it started on your request";
  if (running) {
    const activity = Math.max(
      start,
      teammate.lastEventAt ?? 0,
      ...steps.map((step) => Math.max(step.startedAt, step.endedAt ?? 0)),
    );
    const quietFor = now - activity;
    if (quietFor >= thresholds.quietMs && !teammate.declaredWait && !teammate.backgroundHold)
      flags.push(
        flag(
          "quiet",
          `quiet: its turn runs, but nothing new came from it for ${minutes(quietFor)} (since ${time(activity)}); ${lastStepText}.`,
        ),
      );
    const loop = loopEvidence(steps, start, thresholds);
    if (loop)
      flags.push(
        flag(
          "looping",
          loop.kind === "same-call"
            ? `looping: its last ${loop.count} tool calls were the same call, \`${excerpt(loop.signature, 160)}\`, the last at ${time(loop.lastAt)}.`
            : `looping: its last ${loop.count} tool calls failed, the last \`${loop.name}\` at ${time(loop.lastAt)}.`,
        ),
      );
  }
  if (meta?.dueMinutes) {
    const due = Date.parse(request.createdAt) + meta.dueMinutes * 60_000;
    if (now >= due) {
      const state =
        delivery.status === "queued" || delivery.status === "starting"
          ? "it has not started on it yet (queued)"
          : running
            ? `its turn runs; ${lastStepText}`
            : teammate.declaredWait
              ? `it waits: "${excerpt(teammate.declaredWait, 80)}"`
              : "its turn ended without a reply";
      flags.push(
        flag(
          "overdue",
          `overdue: you gave it ${meta.dueMinutes} min (due ${time(due)}), and there is no reply after ${minutes(now - Date.parse(request.createdAt))}; ${state}.`,
        ),
      );
    }
  }
  return flags;
}

const ACTIONS: Record<WatchPattern, string> = {
  quiet:
    "quiet → a long job (render, training, download) may be fine: wait. Otherwise ask it for a short status with openbot.send_message (expectsReply true), or stop its turn with openbot.interrupt_agent and send the request again.",
  looping:
    "looping → it repeats itself: stop its turn with openbot.interrupt_agent and send a changed request, or tell it what to do differently.",
  overdue: "overdue → ask it for a status, give it more time in your plan, or take the work elsewhere.",
};

/** The wake: the whole prompt of the lead's turn. */
export function watchdogText(input: {
  flags: ReadonlyArray<WatchFlag & { teammateName: string }>;
  timezone: string | undefined;
}): string {
  const bullets = input.flags.map(
    (flag) =>
      `- ${flag.teammateName} (${flag.teammateId}), your request ${flag.requestId} of ${localTime(flag.requestAt, input.timezone)} ("${excerpt(flag.requestText)}"): ${flag.evidence}`,
  );
  const patterns = [...new Set(input.flags.map((flag) => flag.pattern))];
  return [
    `${FORK_TEAM_WATCHDOG_HEADER} Teammates that work on your requests look stuck (OpenBot noticed this; it is not a message from the user):`,
    ...bullets,
    "What you can do:",
    ...patterns.map((pattern) => `- ${ACTIONS[pattern]}`),
    "- Tell the user in one or two lines only when only the user can unblock it.",
    "OpenBot names each request once per pattern. If nothing needs doing now, call openbot.routine_no_update and write nothing.",
  ].join("\n");
}

export interface ForkTeamWatchdogHooks {
  /** The agent's name, or null when it is gone, hidden or being deleted. */
  agent(agentId: string): { name: string } | null;
  requests(since: string): TeamRequestRecord[];
  store: Pick<TeamMetaStore, "get" | "flagged" | "flag">;
  /** A delivery delivered through the channel or messaging service: it ran in that thread. */
  executionDelivery(deliveryId: string): boolean;
  turnStartedAt(turnId: string): number | null;
  lastEventAt(agentId: string): number | null;
  declaredWait(agentId: string): string | null;
  backgroundHold(agentId: string, turnId: string): boolean;
  keyUsed(key: string): boolean;
  laneBusy(agentId: string): boolean;
  laneQueued(agentId: string): number;
  providerReady(agentId: string): boolean;
  enqueue(input: { agentId: string; runId: string; text: string; idempotencyKey: string }): Promise<string>;
  timezone(): string | undefined;
  isRunning(): boolean;
  log(message: string, details: Record<string, string | number | boolean | null>): void;
}

export class ForkTeamWatchdog {
  readonly tools = new TurnToolLog();
  readonly #hooks: ForkTeamWatchdogHooks;
  #timer: ReturnType<typeof setInterval> | null = null;
  #sweeping = false;
  /** The wakes queued by this run, before the store shows them. */
  readonly #wokenAt = new Map<string, number>();

  constructor(options: { hooks: ForkTeamWatchdogHooks }) {
    this.#hooks = options.hooks;
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.sweep(), Math.max(10, SWEEP_MS()));
    this.#timer.unref?.();
  }

  dispose(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  /** The flags of every open request now, by lead, without the ones a wake already named. */
  flags(now = Date.now()): Map<string, WatchFlag[]> {
    const hooks = this.#hooks;
    const timezone = hooks.timezone();
    const thresholds = watchdogThresholds();
    const byLead = new Map<string, WatchFlag[]>();
    for (const request of hooks.requests(new Date(now - teamOpenWindowMs()).toISOString())) {
      if (request.channel || !hooks.agent(request.senderAgentId)) continue;
      for (const delivery of request.deliveries) {
        const teammateId = delivery.recipientAgentId;
        if (teammateId === request.senderAgentId || delivery.repliedAt !== null) continue;
        if (!hooks.agent(teammateId) || hooks.executionDelivery(delivery.id)) continue;
        const turnStartedAt = delivery.turnId ? hooks.turnStartedAt(delivery.turnId) : null;
        const found = watchFlags({
          request,
          delivery,
          meta: hooks.store.get(request.id),
          teammate: {
            turnStartedAt,
            lastEventAt: hooks.lastEventAt(teammateId),
            declaredWait: hooks.declaredWait(teammateId),
            backgroundHold:
              delivery.turnId !== null && turnStartedAt !== null && hooks.backgroundHold(teammateId, delivery.turnId),
            steps: delivery.turnId ? this.tools.steps(delivery.turnId) : [],
          },
          now,
          thresholds,
          timezone,
        }).filter((flag) => !hooks.store.flagged(flag.key) && !hooks.keyUsed(watchdogWakeKey(flag.key)));
        if (found.length > 0)
          byLead.set(request.senderAgentId, [...(byLead.get(request.senderAgentId) ?? []), ...found]);
      }
    }
    return byLead;
  }

  /** One pass; gives the leads that got a wake. */
  async sweep(now = Date.now()): Promise<string[]> {
    if (this.#sweeping || !teamWatchdogEnabled() || !this.#hooks.isRunning()) return [];
    this.#sweeping = true;
    const woken: string[] = [];
    try {
      for (const [leadId, flags] of this.flags(now)) {
        try {
          if (await this.#wake(leadId, flags, now)) woken.push(leadId);
        } catch (error) {
          this.#hooks.log("Team watchdog failed for an agent.", {
            agentId: leadId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } finally {
      this.#sweeping = false;
    }
    return woken;
  }

  async #wake(leadId: string, flags: readonly WatchFlag[], now: number): Promise<boolean> {
    const hooks = this.#hooks;
    const first = flags[0];
    if (!first) return false;
    const leadKey = `lead:${leadId}`;
    const last = Math.max(Date.parse(hooks.store.flagged(leadKey) ?? "") || 0, this.#wokenAt.get(leadId) ?? 0);
    if (now - last < GAP_MS()) return false;
    if (hooks.laneBusy(leadId) || hooks.laneQueued(leadId) > 0 || !hooks.providerReady(leadId)) return false;
    const text = watchdogText({
      flags: flags.map((flag) => ({ ...flag, teammateName: hooks.agent(flag.teammateId)?.name ?? flag.teammateId })),
      timezone: hooks.timezone(),
    });
    this.#wokenAt.set(leadId, now);
    await hooks.enqueue({
      agentId: leadId,
      runId: `team-watchdog:${first.requestId}:${first.pattern}`,
      text,
      idempotencyKey: watchdogWakeKey(first.key),
    });
    hooks.store.flag([...flags.map((flag) => flag.key), leadKey], new Date(now).toISOString());
    hooks.log("Team watchdog woke a lead.", {
      agentId: leadId,
      flags: flags.length,
      patterns: [...new Set(flags.map((flag) => flag.pattern))].join(","),
    });
    return true;
  }
}

function minutes(ms: number): string {
  const total = Math.max(1, Math.round(ms / 60_000));
  return total >= 120 ? `${Math.round(total / 60)} h` : `${total} min`;
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  const value = Number(raw);
  return raw !== undefined && raw !== "" && Number.isFinite(value) && value >= 0 ? value : fallback;
}
