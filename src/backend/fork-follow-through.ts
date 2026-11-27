/**
 * Fork (docs/fork/FEATURES.md #130, "Team follow-through"): a lead agent that manages teammates with
 * `openbot.send_message` gets one wake when a teammate reported back and the lead gave it no next step
 * or decision since, so a report is not dropped when the lead's turn turned to other work (a message
 * of the user steered into it, a long reply, a restart).
 *
 * Everything is read from the mailbox, so it needs no file of its own and holds over a restart. A
 * report is a message from a teammate to the lead, delivered in the lead's own chat (not a channel,
 * messaging or task thread), that replies to a message the lead sent. It is pending when it is at least
 * `DELAY_MS` and at most `WINDOW_MS` old, it is the teammate's newest report, the lead sent the
 * teammate nothing since, and no follow-through wake covered it yet. A wake covers every report that
 * was pending when it was queued, that is every report at least `DELAY_MS` older than the wake; its
 * idempotency key is the oldest report it names (`fork-follow-through:<message id>`).
 *
 * A sweep every `SWEEP_MS` queues at most one wake per lead, only while the lead's own chat is idle
 * and its provider is ready, and at most one per `GAP_MS`. The wake is a delivery with a routine
 * sender (`routineId` `fork-follow-through`, no real routine), like the wake of `wait_until` and the
 * restart wake: its text is the whole prompt, it runs in the lead's own session, and the lead may end
 * it with `routine_no_update`. `OPENBOT_FORK_FOLLOW_THROUGH=0` turns it off.
 */

import type { QueueDeliveryStatus } from "@openbot/contracts/ipc";
import { localTime } from "./fork-restart-resume";

export const FORK_FOLLOW_THROUGH_ROUTINE_ID = "fork-follow-through";
export const FORK_FOLLOW_THROUGH_ROUTINE_NAME = "👥 Team follow-through";
const FORK_FOLLOW_THROUGH_HEADER = "[OpenBot: 👥 team follow-through]";
/** Test switches: `OPENBOT_FORK_FOLLOW_THROUGH_SWEEP_MS`, `..._DELAY_MS`, `..._GAP_MS`. */
const SWEEP_MS = () => envNumber("OPENBOT_FORK_FOLLOW_THROUGH_SWEEP_MS", 60_000);
/** How long a report waits for the lead's own decision before the wake. */
const DELAY_MS = () => envNumber("OPENBOT_FORK_FOLLOW_THROUGH_DELAY_MS", 3 * 60_000);
/** The shortest time between two follow-through wakes of one agent. */
const GAP_MS = () => envNumber("OPENBOT_FORK_FOLLOW_THROUGH_GAP_MS", 10 * 60_000);
/** Older reports are history, not open work. */
const FOLLOW_THROUGH_WINDOW_MS = 2 * 60 * 60_000;
const EXCERPT_LIMIT = 200;

/** A message delivered to the agent, as the mailbox has it. */
export interface FollowThroughReceived {
  id: string;
  sender: { kind: "user" } | { kind: "agent"; agentId: string } | { kind: "routine"; routineId: string };
  text: string;
  createdAt: string;
  replyToMessageId: string | null;
  /** The agent that sent the message this one replies to, if an agent did. */
  replyToSenderAgentId: string | null;
  deliveryId: string;
  status: QueueDeliveryStatus;
  /** Delivered in the agent's own chat: not a channel, messaging or task thread. */
  ownChat: boolean;
}

/** The agent's mailbox traffic in the window: what it got, and what it sent. */
export interface FollowThroughTraffic {
  received: readonly FollowThroughReceived[];
  sent: ReadonlyArray<{ id: string; recipientAgentIds: readonly string[]; createdAt: string }>;
}

export interface FollowThroughReport {
  messageId: string;
  teammateId: string;
  text: string;
  createdAt: string;
}

export interface ForkFollowThroughHooks {
  agentIds(): string[];
  /** The agent's name, or null when it is gone, hidden or being deleted. */
  agent(agentId: string): { name: string } | null;
  traffic(agentId: string, since: string): FollowThroughTraffic;
  /** A delivery delivered through the channel or messaging service: it ran in that thread. */
  executionDelivery(deliveryId: string): boolean;
  /** A message with this idempotency key exists in the mailbox. */
  keyUsed(key: string): boolean;
  laneBusy(agentId: string): boolean;
  laneQueued(agentId: string): number;
  providerReady(agentId: string): boolean;
  enqueue(input: { agentId: string; runId: string; text: string; idempotencyKey: string }): Promise<string>;
  timezone(): string | undefined;
  isRunning(): boolean;
  log(message: string, details: Record<string, string | number | boolean | null>): void;
}

function followThroughEnabled(): boolean {
  return process.env.OPENBOT_FORK_FOLLOW_THROUGH !== "0";
}

export function followThroughKey(messageId: string): string {
  return `${FORK_FOLLOW_THROUGH_ROUTINE_ID}:${messageId}`;
}

const isWake = (message: FollowThroughReceived) =>
  message.sender.kind === "routine" && message.sender.routineId === FORK_FOLLOW_THROUGH_ROUTINE_ID;

/** When the agent last got a follow-through wake, or null. */
function lastWakeAt(traffic: FollowThroughTraffic): number | null {
  const times = traffic.received.filter(isWake).map((message) => Date.parse(message.createdAt));
  return times.length > 0 ? Math.max(...times) : null;
}

/** The reports of the agent's teammates that still wait for its decision, oldest first. */
export function pendingReports(
  agentId: string,
  traffic: FollowThroughTraffic,
  input: {
    now: number;
    delayMs: number;
    keyUsed?: (key: string) => boolean;
    executionDelivery?: (deliveryId: string) => boolean;
    teammate?: (agentId: string) => boolean;
  },
): FollowThroughReport[] {
  const { now, delayMs } = input;
  const wakes = traffic.received.filter(isWake).map((message) => Date.parse(message.createdAt));
  const newest = new Map<string, FollowThroughReceived>();
  for (const message of traffic.received) {
    if (message.sender.kind !== "agent" || message.sender.agentId === agentId) continue;
    if (message.status !== "completed" || !message.ownChat || input.executionDelivery?.(message.deliveryId)) continue;
    if (!message.replyToMessageId || message.replyToSenderAgentId !== agentId) continue;
    const at = Date.parse(message.createdAt);
    if (!Number.isFinite(at) || at < now - FOLLOW_THROUGH_WINDOW_MS) continue;
    const teammateId = message.sender.agentId;
    const known = newest.get(teammateId);
    if (!known || Date.parse(known.createdAt) <= at) newest.set(teammateId, message);
  }
  const reports: FollowThroughReport[] = [];
  for (const [teammateId, message] of newest) {
    const at = Date.parse(message.createdAt);
    if (at > now - delayMs) continue;
    if (input.teammate && !input.teammate(teammateId)) continue;
    // Any message to the teammate since the report is the lead's decision.
    if (traffic.sent.some((sent) => sent.recipientAgentIds.includes(teammateId) && Date.parse(sent.createdAt) > at))
      continue;
    // A wake queued once the report was pending named it.
    if (wakes.some((wake) => wake >= at + delayMs)) continue;
    if (input.keyUsed?.(followThroughKey(message.id))) continue;
    reports.push({ messageId: message.id, teammateId, text: message.text, createdAt: message.createdAt });
  }
  return reports.sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
}

/** The wake: the whole prompt of the lead's turn. */
export function followThroughText(input: {
  reports: ReadonlyArray<FollowThroughReport & { teammateName: string }>;
  timezone: string | undefined;
}): string {
  const bullets = input.reports.map(
    (report) => `- ${report.teammateName}, ${localTime(report.createdAt, input.timezone)}: "${excerpt(report.text)}"`,
  );
  return [
    `${FORK_FOLLOW_THROUGH_HEADER} These teammates reported back to you and have had no next step or decision from you since (this is not a message from the user):`,
    ...bullets,
    "For each one: if your plan has more work for that teammate, send its next step now with openbot.send_message (expectsReply true); if its part is finished, nothing is needed for it. Tell the user only what changed, in one or two lines. If nothing needs doing, call openbot.routine_no_update and write nothing.",
  ].join("\n");
}

function excerpt(text: string): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length > EXCERPT_LIMIT ? `${flat.slice(0, EXCERPT_LIMIT).trimEnd()}…` : flat;
}

export class ForkFollowThrough {
  readonly #hooks: ForkFollowThroughHooks;
  #timer: ReturnType<typeof setInterval> | null = null;
  #sweeping = false;
  /** The wakes queued by this run, before the mailbox shows them. */
  readonly #wokenAt = new Map<string, number>();

  constructor(options: { hooks: ForkFollowThroughHooks }) {
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

  /** One pass over the agents; gives the agents that got a wake. */
  async sweep(now = Date.now()): Promise<string[]> {
    if (this.#sweeping || !followThroughEnabled() || !this.#hooks.isRunning()) return [];
    this.#sweeping = true;
    const woken: string[] = [];
    try {
      for (const agentId of this.#hooks.agentIds()) {
        try {
          if (await this.#sweepAgent(agentId, now)) woken.push(agentId);
        } catch (error) {
          this.#hooks.log("Team follow-through failed for an agent.", {
            agentId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } finally {
      this.#sweeping = false;
    }
    return woken;
  }

  async #sweepAgent(agentId: string, now: number): Promise<boolean> {
    if (!this.#hooks.agent(agentId)) return false;
    const traffic = this.#hooks.traffic(agentId, new Date(now - FOLLOW_THROUGH_WINDOW_MS).toISOString());
    const names = new Map<string, string>();
    const reports = pendingReports(agentId, traffic, {
      now,
      delayMs: DELAY_MS(),
      keyUsed: (key) => this.#hooks.keyUsed(key),
      executionDelivery: (deliveryId) => this.#hooks.executionDelivery(deliveryId),
      teammate: (teammateId) => {
        const teammate = this.#hooks.agent(teammateId);
        if (teammate) names.set(teammateId, teammate.name);
        return teammate !== null;
      },
    });
    const oldest = reports[0];
    if (!oldest) return false;
    const last = Math.max(lastWakeAt(traffic) ?? 0, this.#wokenAt.get(agentId) ?? 0);
    if (now - last < GAP_MS()) return false;
    if (this.#hooks.laneBusy(agentId) || this.#hooks.laneQueued(agentId) > 0) return false;
    if (!this.#hooks.providerReady(agentId)) return false;
    const key = followThroughKey(oldest.messageId);
    const text = followThroughText({
      reports: reports.map((report) => ({
        ...report,
        teammateName: names.get(report.teammateId) ?? report.teammateId,
      })),
      timezone: this.#hooks.timezone(),
    });
    this.#wokenAt.set(agentId, now);
    await this.#hooks.enqueue({ agentId, runId: `follow-through:${oldest.messageId}`, text, idempotencyKey: key });
    this.#hooks.log("Team follow-through woke an agent.", { agentId, reports: reports.length });
    return true;
  }
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  const value = Number(raw);
  return raw !== undefined && raw !== "" && Number.isFinite(value) && value >= 0 ? value : fallback;
}
