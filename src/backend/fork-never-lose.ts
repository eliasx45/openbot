/**
 * Fork (docs/fork/FEATURES.md #136, "Never lose work"): the rules of a teammate's failed turn and of a
 * repeated send. The restart part lives in `fork-restart-resume.ts`.
 *
 * - One automatic retry (GAPS R2-9, R3-8): a teammate's turn that worked on another agent's request and
 *   failed on a cause that can be temporary runs once more, with the same request and a line that says
 *   the first attempt failed and to continue from what is done. The requester hears nothing of the first
 *   failure. A second failure gives the usual failure note. A turn that OpenBot's provider-restart resume
 *   (#131) continues is not retried, and nothing that the user stopped is.
 * - Messages that came into the failed turn (R3-3): they go with the retry; without one, a message of
 *   another agent that needs no answer is queued again once for the next turn (on a temporary cause), or
 *   listed in the one failure note its sender gets.
 * - Repeated sends (R2-5): an identical `send_message` (same sender, recipients and text, spaces aside)
 *   while the earlier request is open is not sent again; `rework: true` sends it anyway, and an
 *   `idempotencyKey` makes any later send with that key a no-op.
 */

import type { CauseCode } from "@openbot/telemetry";

/** The causes that one more run can fix: the provider was slow, stalled, unreachable or answered nothing. */
const RETRY_CAUSES: ReadonlySet<CauseCode> = new Set([
  "timeout",
  "stalled",
  "network",
  "provider_unavailable",
  "empty_answer",
]);

/** How long an identical request counts as the same hand-off (R2-5). */
export const FORK_SEND_DEDUPE_MS = 6 * 60 * 60_000;
const REASON_LIMIT = 300;
const LISTED_LIMIT = 8;
const LISTED_TEXT_LIMIT = 200;

export function forkRetryCause(cause: CauseCode | undefined): boolean {
  return cause !== undefined && RETRY_CAUSES.has(cause);
}

export interface ForkRetryDelivery {
  id: string;
  /** The sending agent, or null for the user or a routine. */
  senderAgentId: string | null;
  expectsReply: boolean;
  channel: boolean;
  /** Already queued again once (it carries a retry marker). */
  retried: boolean;
}

/**
 * Whether a failed turn runs once more. Only a teammate's turn in its own chat that worked on another
 * agent's request, failed (not stopped), on a cause that can be temporary, that no other path continues
 * (#131 provider restart, a usage limit, a refused session), and that no retry ran for yet.
 */
export function forkRetriesTurn(input: {
  agentId: string;
  status: string;
  cause: CauseCode | undefined;
  /** A refused session, a usage limit, a compaction continuation, a channel, routine or task thread. */
  otherPath: boolean;
  /** #131: OpenBot ended a hung provider and the chat resumes by itself. */
  providerRestart: boolean;
  deliveries: readonly ForkRetryDelivery[];
}): boolean {
  if (input.status !== "failed" || input.otherPath || input.providerRestart || !forkRetryCause(input.cause))
    return false;
  if (input.deliveries.length === 0 || input.deliveries.some((delivery) => delivery.retried)) return false;
  return input.deliveries.some(
    (delivery) =>
      delivery.senderAgentId !== null &&
      delivery.senderAgentId !== input.agentId &&
      delivery.expectsReply &&
      !delivery.channel,
  );
}

export function forkRetryReason(error: string | undefined, cause: CauseCode | undefined): string {
  const text = (error ?? "").replace(/\s+/gu, " ").trim();
  return (text || `the provider failed (${cause ?? "unknown"})`).slice(0, REASON_LIMIT);
}

/** The line before a queued-again delivery's prompt. */
export function forkRetryPromptLine(marker: { kind: "retry" | "steered"; reason: string } | undefined): string | null {
  if (!marker) return null;
  return marker.kind === "retry"
    ? `[OpenBot: 🔁 retry] OpenBot retry: your previous attempt at this request failed: ${marker.reason}. Continue from what's already done: check the files, git and messages you already sent, and do not repeat outward actions. This is the only automatic retry.`
    : `[OpenBot: 🔁 resent] This message came into an earlier turn of yours that failed (${marker.reason}) before you handled it. You may have seen it already: check what you did, then act on it where that is still needed.`;
}

/** The text of a send, compared for repeats: spaces aside. */
export function forkSendText(text: string): string {
  return text.normalize("NFC").replace(/\s+/gu, " ").trim();
}

const SEND_KEY_LIMIT = 200;

/** The mailbox key of an agent's own `idempotencyKey`, scoped to the sender; null without one. */
export function forkSendKey(senderAgentId: string, key: unknown): string | null {
  if (key === undefined || key === null) return null;
  if (typeof key !== "string" || key.trim() === "" || key.length > SEND_KEY_LIMIT)
    throw new Error(`idempotencyKey must be a text of 1 to ${SEND_KEY_LIMIT} characters.`);
  return `fork-send:${senderAgentId}:${key.trim()}`;
}

/** The tool result of a send that was not sent again. */
interface ForkDuplicateSend {
  duplicate: true;
  sent: false;
  messageId: string;
  note: string;
}

export function forkDuplicateSendResult(input: {
  messageId: string;
  createdAt: string;
  byKey: boolean;
}): ForkDuplicateSend {
  return {
    duplicate: true,
    sent: false,
    messageId: input.messageId,
    note: input.byKey
      ? `Not sent again: a message with this idempotencyKey was already sent at ${input.createdAt} (message ${input.messageId}). Pass rework:true to send it again.`
      : `Not sent again: already sent at ${input.createdAt} (message ${input.messageId}), still open — wait, or pass rework:true to send again.`,
  };
}

/** The lines of a failure note that name a sender's messages (oldest first, cut). */
export function forkListedMessages(
  messages: ReadonlyArray<{ text: string; createdAt: string }>,
  heading = "The messages:",
): string[] {
  if (messages.length === 0) return [];
  const shown = messages.slice(0, LISTED_LIMIT).map((message) => {
    const text = message.text.replace(/\s+/gu, " ").trim();
    return `- ${message.createdAt.slice(11, 16)} UTC: ${text.length > LISTED_TEXT_LIMIT ? `${text.slice(0, LISTED_TEXT_LIMIT - 1)}…` : text}`;
  });
  return [
    heading,
    ...shown,
    ...(messages.length > LISTED_LIMIT ? [`- and ${messages.length - LISTED_LIMIT} more`] : []),
  ];
}
