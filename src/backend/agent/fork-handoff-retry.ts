// Fork (docs/fork/FEATURES.md #106): a message whose start failed because its provider was briefly down
// (the CLI being replaced, the SDK client stopped, the CLI not ready yet, OpenBot quitting) waits in the
// queue and starts once the provider is back, instead of failing for good. The wait is bounded: after
// FORK_HANDOFF_RETRY.maxAttempts failed starts, or FORK_HANDOFF_RETRY.giveUpMs after the first one, the
// message fails as before. A messaging message (a WhatsApp line) that fails before its turn shows in its
// thread with the failed state, as an app message does.
import type { ConversationMessage, QueueDeliveryStatus } from "@openbot/contracts/ipc";
import { matchingSourceKeys } from "@openbot/i18n/source";
import { createOpenBotLogger } from "@openbot/logging";
import { classifyUserError } from "@openbot/user-errors";
import { ProviderStoppedError } from "../agent-client";
import type { DeliveryContext } from "../mailbox-store";
import type { MessagingThreads } from "../messaging/messaging-threads";
import { ProviderSignInError } from "../provider-client-effects";
import type { ConversationRuntime } from "./conversation-runtime";
import type { MailboxSync } from "./mailbox-sync";

const logger = createOpenBotLogger("drain-scheduler");

export const FORK_HANDOFF_RETRY = {
  /** Failed starts while the provider looked ready; the waits while it is held do not count. */
  maxAttempts: 12,
  /** From the first failed start of this run of OpenBot. */
  giveUpMs: 3 * 60 * 60_000,
};

/**
 * The provider clients' own texts for a client that OpenBot stopped or has not started (claude-client,
 * acp-client, acp-connection, app-server-client, pi-rpc). A crash ("… exited with code 1") is not one.
 */
const NOT_RUNNING =
  /^(?:(?:Claude Agent SDK|ACP client|ACP connection|Codex App Server|Pi) is not running|Codex App Server stopped)\.$/u;
const DOWN_KEYS: ReadonlySet<string> = new Set(["error.provider.cliNotReady", "error.provider.closing"]);

/**
 * True when a start failed only because the provider was not there for a moment. A missing sign-in,
 * an auth error, a usage limit or any other refusal is not: those fail as before.
 */
export function forkProviderDownAtStart(error: unknown, signInRequired: boolean): boolean {
  if (signInRequired || error instanceof ProviderSignInError) return false;
  if (classifyUserError(error) === "auth") return false;
  if (error instanceof ProviderStoppedError) return true;
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (NOT_RUNNING.test(message)) return true;
  return matchingSourceKeys(message).some((key) => DOWN_KEYS.has(key));
}

interface Attempts {
  readonly firstAt: number;
  count: number;
}

export class ForkHandoffRetry {
  readonly #attempts = new Map<string, Attempts>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /** Counts one failed start; false once the message has waited long enough and should fail. */
  allow(deliveryId: string): boolean {
    const now = this.#now();
    const attempts = this.#attempts.get(deliveryId) ?? { firstAt: now, count: 0 };
    attempts.count += 1;
    this.#attempts.set(deliveryId, attempts);
    if (attempts.count <= FORK_HANDOFF_RETRY.maxAttempts && now - attempts.firstAt < FORK_HANDOFF_RETRY.giveUpMs)
      return true;
    this.#attempts.delete(deliveryId);
    return false;
  }

  attempts(deliveryId: string): number {
    return this.#attempts.get(deliveryId)?.count ?? 0;
  }

  forget(deliveryId: string): void {
    this.#attempts.delete(deliveryId);
  }

  clear(): void {
    this.#attempts.clear();
  }
}

/**
 * Shows a messaging message's current state in its thread. Messaging messages are not mailbox copies
 * in the chat (`MailboxStore.conversationMessages` skips them): the start adds them. So a start that
 * failed before that step left no trace in the thread, and one that failed after it showed "starting".
 * A failed message is added when missing, with the "Failed" state that the chat shows for app messages.
 */
export function forkSyncMessagingLine(
  conversation: ConversationRuntime,
  mailboxSync: MailboxSync,
  messaging: MessagingThreads | undefined,
  context: DeliveryContext,
  status: QueueDeliveryStatus,
): void {
  const { delivery } = context;
  if (!messaging?.ownsDelivery(delivery.id)) return;
  try {
    syncMessagingLine(conversation, mailboxSync, messaging, context, status);
  } catch (error) {
    logger.warn("A messaging message's state did not reach its thread.", {
      deliveryId: delivery.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function syncMessagingLine(
  conversation: ConversationRuntime,
  mailboxSync: MailboxSync,
  messaging: MessagingThreads,
  context: DeliveryContext,
  status: QueueDeliveryStatus,
): void {
  const { delivery } = context;
  const threadId = messaging.threadForDelivery(delivery.id);
  if (!threadId) return;
  conversation.registerExecutionThread(delivery.recipientAgentId, threadId);
  const snapshot = conversation.ensureSnapshot(delivery.recipientAgentId, threadId);
  if (snapshot.threadId !== threadId) return;
  let message = snapshot.messages.find((candidate) => candidate.id === delivery.id);
  if (!message) {
    if (status !== "failed") return;
    message = {
      id: delivery.id,
      author: "user",
      source: "user",
      replyToMessageId: delivery.replyToMessageId,
      attachments: delivery.attachments,
      delivery: { id: delivery.id, status, position: null },
      text: delivery.text,
      createdAt: delivery.createdAt,
      status: "failed",
    } satisfies ConversationMessage;
    snapshot.messages.push(message);
  }
  mailboxSync.syncDeliveryMessage(snapshot, delivery.id);
  if (status === "failed") message.status = "failed";
  conversation.emitConversation(snapshot);
}
