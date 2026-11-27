/**
 * Fork (docs/fork/FEATURES.md #135, "Team watchdogs and guards"): guards on the messages that agents
 * send each other with `openbot.send_message`, and the request details that the team watchdog reads.
 *
 * - Hop count: a message sent in a turn carries the hops of the agent messages that turn handles, plus
 *   one. A reply that ends an exchange (a reply to the agent's own request, `expectsReply` false) gives
 *   back the hops of the request it answers minus one, so a lead and its teammates can go back and forth
 *   for hours, while a chain that hands work on (A → B → C …) or bounces questions grows. A message
 *   beyond `MAX_HOPS` (8) is refused; a reply that ends an exchange never is.
 * - Open requests: at most `MAX_OPEN_PER_SENDER` (16) requests of one agent, and `MAX_OPEN_PER_TREE`
 *   (64) of one lead's tree (all requests that descend from one top agent), wait for a reply at once.
 * - Mutual waits: a request to an agent that (through open requests of the same chain) waits for the
 *   sender is refused; the sender must reply instead of asking back.
 * - `dueMinutes`, `doneWhen` and `check` on a request: the watchdog wakes the lead when it is overdue;
 *   the teammate sees `doneWhen` and the check in its prompt; a "Status: done" reply runs the check in
 *   the lead's workspace, and a failed one goes back to the teammate once, then to the lead marked.
 *
 * Every refusal tells the agent what to do instead. What a request carries is kept in
 * `fork-team-watchdog.json` beside the database (with the watchdog's wake marks), so it holds over a
 * restart; whether a request is open is read from the mailbox. `OPENBOT_FORK_TEAM_GUARDS=0` turns the
 * refusals off (the request details stay).
 */

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { QueueDeliveryStatus } from "@openbot/contracts/ipc";
import { type DynamicRecord, isDynamicRecord } from "@openbot/contracts/runtime-values";
import { localTime } from "./fork-restart-resume";
import {
  describeTeamCheck,
  parseTeamCheck,
  runTeamCheck,
  type TeamCheck,
  type TeamCheckResult,
} from "./fork-team-check";
import { FORK_TEAM_CHECK_ROUTINE_ID } from "./fork-team-routines";

export { FORK_TEAM_CHECK_ROUTINE_ID, FORK_TEAM_CHECK_ROUTINE_NAME } from "./fork-team-routines";
export const FORK_TEAM_CHECK_HEADER = "[OpenBot: 🐕 team check]";
export const TEAM_DONE_WHEN_LIMIT = 1_000;
export const TEAM_DUE_MINUTES_MAX = 7 * 24 * 60;
const FILE = "fork-team-watchdog.json";
const KEEP_REQUESTS_MS = 7 * 24 * 60 * 60_000;
const KEEP_FLAGS_MS = 3 * 24 * 60 * 60_000;
const EXCERPT_LIMIT = 120;

/** Test switches: `OPENBOT_FORK_TEAM_MAX_HOPS`, `..._MAX_OPEN_PER_SENDER`, `..._MAX_OPEN_PER_TREE`, `..._OPEN_WINDOW_MS`. */
export const teamLimits = () => ({
  hops: envNumber("OPENBOT_FORK_TEAM_MAX_HOPS", 8),
  perSender: envNumber("OPENBOT_FORK_TEAM_MAX_OPEN_PER_SENDER", 16),
  perTree: envNumber("OPENBOT_FORK_TEAM_MAX_OPEN_PER_TREE", 64),
});
/** A request older than this no longer counts as open work (a lost reply must not block forever). */
export const teamOpenWindowMs = () => envNumber("OPENBOT_FORK_TEAM_OPEN_WINDOW_MS", 24 * 60 * 60_000);

export function teamGuardsEnabled(): boolean {
  return process.env.OPENBOT_FORK_TEAM_GUARDS !== "0";
}

/** What OpenBot keeps of a message an agent sent with `send_message`. */
export interface TeamRequestMeta {
  sender: string;
  hops: number;
  /** The top agent of the chain: the lead whose tree this message belongs to. */
  root: string;
  createdAt: string;
  dueMinutes?: number;
  doneWhen?: string;
  check?: TeamCheck;
  /** How many "Status: done" replies failed the check. */
  checkFailures?: number;
  checkResult?: TeamCheckResult & { at: string };
}

/** An agent's request as the mailbox has it (`MailboxStore.forkTeamRequests`). */
export interface TeamRequestRecord {
  id: string;
  senderAgentId: string;
  text: string;
  createdAt: string;
  /** Sent in a channel: the channel's own rules apply, not these. */
  channel: boolean;
  deliveries: ReadonlyArray<{
    id: string;
    recipientAgentId: string;
    status: QueueDeliveryStatus;
    turnId: string | null;
    createdAt: string;
    steeredAt: string | null;
    /** When the recipient replied to the request, or null. */
    repliedAt: string | null;
  }>;
}

/** A request of one agent to another that still waits for a reply. */
export interface TeamOpenRequest {
  id: string;
  sender: string;
  recipient: string;
  createdAt: string;
  root: string;
  text: string;
}

const OPEN_STATUSES: ReadonlySet<QueueDeliveryStatus> = new Set(["queued", "starting", "running", "completed"]);

export function openRequests(
  records: readonly TeamRequestRecord[],
  meta: (id: string) => TeamRequestMeta | undefined,
  now: number,
  windowMs = teamOpenWindowMs(),
): TeamOpenRequest[] {
  const open: TeamOpenRequest[] = [];
  for (const record of records) {
    if (record.channel || Date.parse(record.createdAt) < now - windowMs) continue;
    const root = meta(record.id)?.root ?? record.senderAgentId;
    for (const delivery of record.deliveries) {
      if (delivery.repliedAt !== null || !OPEN_STATUSES.has(delivery.status)) continue;
      if (delivery.recipientAgentId === record.senderAgentId) continue;
      open.push({
        id: record.id,
        sender: record.senderAgentId,
        recipient: delivery.recipientAgentId,
        createdAt: record.createdAt,
        root,
        text: record.text,
      });
    }
  }
  return open;
}

/** A delivery that the sending turn handles. */
export interface TeamTurnDelivery {
  messageId: string;
  sender: { kind: "agent"; agentId: string } | { kind: "user" } | { kind: "routine" };
  replyToMessageId: string | null;
  expectsReply: boolean;
}

/** The hops and the tree of the turn that sends: the chain it continues. */
export function chainBase(
  senderAgentId: string,
  deliveries: readonly TeamTurnDelivery[],
  meta: (id: string) => TeamRequestMeta | undefined,
  requestSender: (id: string) => string | null,
): { hops: number; root: string } {
  let best = { hops: 0, root: senderAgentId };
  for (const delivery of deliveries) {
    // The user, a routine or OpenBot's own wake starts a new chain; so does the agent's own task.
    if (delivery.sender.kind !== "agent" || delivery.sender.agentId === senderAgentId) continue;
    const answered = delivery.replyToMessageId;
    let base: { hops: number; root: string };
    if (answered && !delivery.expectsReply && requestSender(answered) === senderAgentId) {
      // A reply that ends an exchange of this agent: back to where the agent asked.
      const request = meta(answered);
      base = { hops: Math.max(0, (request?.hops ?? 1) - 1), root: request?.root ?? senderAgentId };
    } else {
      const own = meta(delivery.messageId);
      base = { hops: own?.hops ?? 1, root: own?.root ?? delivery.sender.agentId };
    }
    if (base.hops > best.hops) best = base;
  }
  return best;
}

export interface SendGuardInput {
  senderAgentId: string;
  recipientAgentIds: readonly string[];
  expectsReply: boolean;
  /** The message this one replies to, resolved, or null. */
  replyTo: string | null;
  base: { hops: number; root: string };
  open: readonly TeamOpenRequest[];
  /** The messages the sending turn handles: an open request among them is part of this chain. */
  turnMessageIds: ReadonlySet<string>;
  name: (agentId: string) => string;
  limits: { hops: number; perSender: number; perTree: number };
}

/** Why a message must not be sent, for the agent, or null. */
export function sendRefusal(input: SendGuardInput): string | null {
  const { senderAgentId, recipientAgentIds, expectsReply, replyTo, base, open, name, limits } = input;
  // A reply that ends an exchange always goes: it closes a chain, it never opens one.
  if (replyTo !== null && !expectsReply) return null;
  const hops = base.hops + 1;
  if (hops > limits.hops)
    return [
      `Refused by OpenBot: this message would be hop ${hops} of one chain of agent-to-agent messages, and the limit is ${limits.hops}.`,
      "A chain this long usually means work is handed on and on, or agents keep asking each other back.",
      "Do the work yourself, or answer the agent that asked you: openbot.send_message with replyToMessageId of its request and expectsReply false, with what you have and Status: blocked when you cannot finish. The user or a lead can start a new chain.",
    ].join(" ");
  if (!expectsReply) return null;
  const mine = open.filter((request) => request.sender === senderAgentId);
  if (mine.length + recipientAgentIds.length > limits.perSender)
    return [
      `Refused by OpenBot: you already have ${mine.length} open requests that wait for a reply (${openList(mine, name, "recipient")}), and one agent may have ${limits.perSender} at once.`,
      "End your turn and wait: replies come back to this chat. Or send this as information with expectsReply false, or to fewer recipients.",
    ].join(" ");
  const tree = open.filter((request) => request.root === base.root);
  if (tree.length + recipientAgentIds.length > limits.perTree)
    return [
      `Refused by OpenBot: the team of ${name(base.root)} already has ${tree.length} open requests between its agents, and one team may have ${limits.perTree} at once.`,
      "Finish your part yourself or wait for the replies that are on their way; send this with expectsReply false if it needs no answer.",
    ].join(" ");
  for (const recipient of recipientAgentIds) {
    const path = waitPath(recipient, senderAgentId, input);
    const first = path?.[0];
    if (!path || !first) continue;
    const chain = path.map((edge) => `${name(edge.sender)} → ${name(edge.recipient)}`).join(", ");
    return [
      path.length === 1
        ? `Refused by OpenBot: ${name(recipient)} (${recipient}) waits for your answer to its request ${first.id} ("${excerpt(first.text)}"), so asking it back with expectsReply true would make you wait for each other.`
        : `Refused by OpenBot: ${name(recipient)} (${recipient}) waits for you through open requests (${chain}), so a request back to it would make you all wait for each other.`,
      path.length === 1
        ? `Reply instead: openbot.send_message to ${recipient} with replyToMessageId "${first.id}" and expectsReply false. When you need something from it to go on, say so in that reply: Status: blocked, then Unblock: <your question>.`
        : "Reply to the request you are working on instead (replyToMessageId, expectsReply false), with Status: blocked and Unblock: <your question> when you need something.",
      "To only inform it, send with expectsReply false.",
    ].join(" ");
  }
  return null;
}

/** The open requests through which `from` waits for `to`, in this chain, or null. */
function waitPath(from: string, to: string, input: SendGuardInput): TeamOpenRequest[] | null {
  const edges = input.open.filter(
    (edge) => edge.id !== input.replyTo && (edge.root === input.base.root || input.turnMessageIds.has(edge.id)),
  );
  const queue: Array<{ at: string; path: TeamOpenRequest[] }> = [{ at: from, path: [] }];
  const seen = new Set([from]);
  while (queue.length > 0) {
    const step = queue.shift();
    if (!step) break;
    for (const edge of edges) {
      if (edge.sender !== step.at) continue;
      const path = [...step.path, edge];
      if (edge.recipient === to) return path;
      if (seen.has(edge.recipient)) continue;
      seen.add(edge.recipient);
      queue.push({ at: edge.recipient, path });
    }
  }
  return null;
}

function openList(requests: readonly TeamOpenRequest[], name: (agentId: string) => string, side: "recipient"): string {
  const counts = new Map<string, number>();
  for (const request of requests) counts.set(request[side], (counts.get(request[side]) ?? 0) + 1);
  const shown = [...counts]
    .slice(0, 8)
    .map(([agentId, count]) => (count > 1 ? `${name(agentId)} ×${count}` : name(agentId)));
  return counts.size > shown.length ? `${shown.join(", ")}, …` : shown.join(", ");
}

export function excerpt(text: string, limit = EXCERPT_LIMIT): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit).trimEnd()}…` : flat;
}

/** "Status: done" as the first status line of a reply. */
export function saysDone(text: string): boolean {
  return /^[\s>*_#-]*status\s*[:：]\s*[*_]*\s*done\b/imu.test(text);
}

/** The new `send_message` fields, checked: `dueMinutes`, `doneWhen`, `check`. */
export function parseRequestFields(
  args: DynamicRecord,
): { dueMinutes?: number; doneWhen?: string; check?: TeamCheck } | string {
  const fields: { dueMinutes?: number; doneWhen?: string; check?: TeamCheck } = {};
  const due = args.dueMinutes;
  if (due !== undefined && due !== null) {
    if (typeof due !== "number" || !Number.isInteger(due) || due < 1 || due > TEAM_DUE_MINUTES_MAX)
      return `dueMinutes must be a whole number of minutes from 1 to ${TEAM_DUE_MINUTES_MAX}.`;
    fields.dueMinutes = due;
  }
  const doneWhen = args.doneWhen;
  if (doneWhen !== undefined && doneWhen !== null) {
    if (typeof doneWhen !== "string" || !doneWhen.trim() || doneWhen.length > TEAM_DONE_WHEN_LIMIT)
      return `doneWhen must be text of 1 to ${TEAM_DONE_WHEN_LIMIT} characters.`;
    fields.doneWhen = doneWhen.trim();
  }
  const check = parseTeamCheck(args.check);
  if (typeof check === "string") return check;
  if (check) fields.check = check;
  return fields;
}

interface StoredState {
  version: 1;
  requests: Record<string, TeamRequestMeta>;
  /** The watchdog's wake marks: `<request>:<teammate>:<pattern>` → when a wake named it. */
  flags: Record<string, string>;
}

/** The request details and wake marks, in a file beside the database (none in tests). */
export class TeamMetaStore {
  readonly #file: string | null;
  #state: StoredState = { version: 1, requests: {}, flags: {} };

  constructor(databasePath: string | null) {
    this.#file = databasePath && isAbsolute(databasePath) ? join(dirname(databasePath), FILE) : null;
    if (!this.#file) return;
    try {
      const saved = JSON.parse(readFileSync(this.#file, "utf8"));
      if (isDynamicRecord(saved) && isDynamicRecord(saved.requests) && isDynamicRecord(saved.flags)) {
        const requests = new Map<string, TeamRequestMeta>();
        for (const [id, value] of Object.entries(saved.requests)) if (isMeta(value)) requests.set(id, value);
        const flags = new Map<string, string>();
        for (const [key, value] of Object.entries(saved.flags)) if (typeof value === "string") flags.set(key, value);
        this.#state = { version: 1, requests: Object.fromEntries(requests), flags: Object.fromEntries(flags) };
      }
    } catch {}
  }

  get(id: string): TeamRequestMeta | undefined {
    return this.#state.requests[id];
  }

  set(id: string, meta: TeamRequestMeta): void {
    this.#state.requests[id] = meta;
    this.#save();
  }

  flagged(key: string): string | undefined {
    return this.#state.flags[key];
  }

  flag(keys: readonly string[], at: string): void {
    for (const key of keys) this.#state.flags[key] = at;
    this.#save();
  }

  #save(): void {
    const now = Date.now();
    for (const [id, meta] of Object.entries(this.#state.requests))
      if (Date.parse(meta.createdAt) < now - KEEP_REQUESTS_MS) delete this.#state.requests[id];
    for (const [key, at] of Object.entries(this.#state.flags))
      if (Date.parse(at) < now - KEEP_FLAGS_MS) delete this.#state.flags[key];
    if (!this.#file) return;
    try {
      const temporary = `${this.#file}.tmp`;
      writeFileSync(temporary, JSON.stringify(this.#state), { mode: 0o600 });
      renameSync(temporary, this.#file);
    } catch {}
  }
}

function isMeta(value: unknown): value is TeamRequestMeta {
  return (
    isDynamicRecord(value) &&
    typeof value.sender === "string" &&
    typeof value.hops === "number" &&
    typeof value.root === "string" &&
    typeof value.createdAt === "string"
  );
}

export interface ForkTeamGuardsHooks {
  /** The agent's name, or its id when it is gone. */
  name(agentId: string): string;
  /** Agents' requests since `since` (`MailboxStore.forkTeamRequests`). */
  requests(since: string): TeamRequestRecord[];
  /** The agent that sent a message, when an agent did. */
  messageSender(messageId: string): string | null;
  /** The folder the agent works in: a check runs there. */
  workspace(agentId: string): string | null;
  /** Queues OpenBot's message to an agent, as a routine wake in its own chat. */
  enqueue(input: { agentId: string; runId: string; text: string; idempotencyKey: string }): Promise<string>;
  timezone(): string | undefined;
  log(message: string, details: Record<string, string | number | boolean | null>): void;
}

/** A send that passed the guards: what to keep once it is queued. */
export interface TeamSendPlan {
  meta: TeamRequestMeta;
}

export type TeamReplyGate = { kind: "send"; text: string } | { kind: "refuse"; message: string } | { kind: "held" };

export class ForkTeamGuards {
  readonly store: TeamMetaStore;
  readonly #hooks: ForkTeamGuardsHooks;

  constructor(options: { databasePath: string | null; hooks: ForkTeamGuardsHooks }) {
    this.store = new TeamMetaStore(options.databasePath);
    this.#hooks = options.hooks;
  }

  meta(messageId: string): TeamRequestMeta | undefined {
    return this.store.get(messageId);
  }

  /** The open requests between agents now (from the mailbox). */
  open(now = Date.now()): TeamOpenRequest[] {
    const since = new Date(now - teamOpenWindowMs()).toISOString();
    return openRequests(this.#hooks.requests(since), (id) => this.store.get(id), now);
  }

  /** Checks a `send_message` call before it is queued: a refusal for the agent, or what to keep. */
  planSend(input: {
    senderAgentId: string;
    recipientAgentIds: readonly string[];
    expectsReply: boolean;
    replyTo: string | null;
    turnDeliveries: readonly TeamTurnDelivery[];
    args: DynamicRecord;
    now?: number;
  }): { refusal: string } | TeamSendPlan {
    const now = input.now ?? Date.now();
    const fields = parseRequestFields(input.args);
    if (typeof fields === "string") return { refusal: fields };
    if (!input.expectsReply && (fields.dueMinutes || fields.doneWhen || fields.check))
      return {
        refusal:
          "dueMinutes, doneWhen and check belong to a request: send them with expectsReply true, or leave them out.",
      };
    const base = chainBase(
      input.senderAgentId,
      input.turnDeliveries,
      (id) => this.store.get(id),
      (id) => this.store.get(id)?.sender ?? this.#hooks.messageSender(id),
    );
    if (teamGuardsEnabled()) {
      const refusal = sendRefusal({
        senderAgentId: input.senderAgentId,
        recipientAgentIds: input.recipientAgentIds,
        expectsReply: input.expectsReply,
        replyTo: input.replyTo,
        base,
        open: input.expectsReply ? this.open(now) : [],
        turnMessageIds: new Set(input.turnDeliveries.map((delivery) => delivery.messageId)),
        name: (agentId) => this.#hooks.name(agentId),
        limits: teamLimits(),
      });
      if (refusal) {
        this.#hooks.log("Team guards refused a message.", {
          agentId: input.senderAgentId,
          hops: base.hops + 1,
          refusal: refusal.slice(0, 80),
        });
        return { refusal };
      }
    }
    return {
      meta: {
        sender: input.senderAgentId,
        hops: base.hops + 1,
        root: base.root,
        createdAt: new Date(now).toISOString(),
        ...fields,
      },
    };
  }

  recordSend(messageId: string, plan: TeamSendPlan): void {
    if (!this.store.get(messageId)) this.store.set(messageId, plan.meta);
  }

  /**
   * A teammate's reply to a request with a check: "Status: done" runs the check. A pass goes to the
   * lead with a note; the first failure goes back to the teammate (a tool error, or OpenBot's message
   * when OpenBot sends the turn's answer); a later failure goes to the lead marked as failed.
   */
  async gateReply(input: {
    teammateId: string;
    requestId: string | null;
    recipientAgentIds: readonly string[];
    text: string;
    via: "tool" | "auto";
  }): Promise<TeamReplyGate> {
    const send: TeamReplyGate = { kind: "send", text: input.text };
    if (!input.requestId) return send;
    const meta = this.store.get(input.requestId);
    if (!meta?.check || meta.sender === input.teammateId || !input.recipientAgentIds.includes(meta.sender)) return send;
    if (!saysDone(input.text)) return send;
    const cwd = this.#hooks.workspace(meta.sender);
    const result: TeamCheckResult = cwd
      ? await runTeamCheck(meta.check, cwd)
      : { passed: false, output: "The lead's workspace is gone." };
    const at = new Date().toISOString();
    const failures = (meta.checkFailures ?? 0) + (result.passed ? 0 : 1);
    this.store.set(input.requestId, { ...meta, checkFailures: failures, checkResult: { ...result, at } });
    const described = describeTeamCheck(meta.check);
    this.#hooks.log("Team check ran.", {
      requestId: input.requestId,
      teammateId: input.teammateId,
      passed: result.passed,
      failures,
    });
    if (result.passed)
      return { kind: "send", text: `${input.text}\n\n[OpenBot: ✓ check passed] ${described}: ${result.output}` };
    if (failures === 1) {
      const fix = `your result failed its check (${described}): ${result.output}`;
      if (input.via === "tool")
        return {
          kind: "refuse",
          message: `Not sent: ${fix}. Fix it, then reply again with the same call.${meta.doneWhen ? ` Done when: ${meta.doneWhen}` : ""}`,
        };
      await this.#hooks.enqueue({
        agentId: input.teammateId,
        runId: `team-check:${input.requestId}`,
        text: checkFailedText({
          leadId: meta.sender,
          leadName: this.#hooks.name(meta.sender),
          requestId: input.requestId,
          fix,
          doneWhen: meta.doneWhen,
        }),
        idempotencyKey: `${FORK_TEAM_CHECK_ROUTINE_ID}:${input.requestId}`,
      });
      return { kind: "held" };
    }
    return {
      kind: "send",
      text: `${input.text.replace(/(status\s*[:：]\s*[*_]*\s*)done\b/iu, "$1done (check failed)")}\n\n[OpenBot: ✗ check failed] ${described} failed again: ${result.output}. This result is not done; it already went back to the teammate once.`,
    };
  }

  /** Lines for the prompt of a request with these fields, or of a reply to one. */
  promptLines(delivery: { messageId: string; replyToMessageId: string | null; recipientAgentId: string }): string[] {
    const own = this.store.get(delivery.messageId);
    if (own && own.sender !== delivery.recipientAgentId && (own.doneWhen || own.check || own.dueMinutes)) {
      const lines: string[] = [];
      if (own.doneWhen) lines.push(`Done when (set by ${this.#hooks.name(own.sender)}): ${own.doneWhen}`);
      if (own.check)
        lines.push(
          `When you reply with Status: done, OpenBot checks it: ${describeTeamCheck(own.check)} (in ${this.#hooks.name(own.sender)}'s workspace). A failed check sends your reply back to you once.`,
        );
      if (own.dueMinutes) {
        const due = new Date(Date.parse(own.createdAt) + own.dueMinutes * 60_000).toISOString();
        lines.push(
          `Due: reply within ${own.dueMinutes} minutes, by ${localTime(due, this.#hooks.timezone())}. When it takes longer, send a short Status: partial reply with what is left.`,
        );
      }
      return lines;
    }
    const answered = delivery.replyToMessageId ? this.store.get(delivery.replyToMessageId) : undefined;
    if (!answered || answered.sender !== delivery.recipientAgentId || !(answered.doneWhen || answered.check)) return [];
    const lines: string[] = [];
    if (answered.doneWhen) lines.push(`Your done-when for this request: ${answered.doneWhen}`);
    const result = answered.checkResult;
    if (answered.check && result)
      lines.push(
        result.passed
          ? `OpenBot's check passed: ${describeTeamCheck(answered.check)}.`
          : `OpenBot's check failed (${describeTeamCheck(answered.check)}): ${result.output}. Do not treat this result as done.`,
      );
    return lines;
  }
}

export function checkFailedText(input: {
  leadId: string;
  leadName: string;
  requestId: string;
  fix: string;
  doneWhen: string | undefined;
}): string {
  return [
    `${FORK_TEAM_CHECK_HEADER} Your "Status: done" reply to ${input.leadName}'s request ${input.requestId} was not sent: ${input.fix}. This is OpenBot's message, not the user's.`,
    ...(input.doneWhen ? [`Done when: ${input.doneWhen}`] : []),
    `Fix the result, then reply again with openbot.send_message: recipientAgentIds ["${input.leadId}"], replyToMessageId "${input.requestId}", expectsReply false. When you cannot fix it, reply with Status: blocked and what is wrong.`,
  ].join("\n");
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  const value = Number(raw);
  return raw !== undefined && raw !== "" && Number.isFinite(value) && value >= 0 ? value : fallback;
}
