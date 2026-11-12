// Fork (docs/fork/FEATURES.md #76): where the owner's WhatsApp "Message yourself" conversation, with the
// watched chats' turns in it (#68), shows in OpenBot. The owner chooses it on the WhatsApp page: in the
// orchestrator's own chat (the default), in a side thread of it, or only on the phone.

import type { MessagingPlatform, WhatsAppWatchPlacement } from "@openbot/contracts/ipc";
import { sourceText } from "@openbot/i18n/source";
import type { MessagingPlacement } from "../messaging-threads";
import { userJid } from "./whatsapp-events";

/** The name of the "Message yourself" conversation, whoever wrote its first message. */
export function selfChatTitle(): string {
  return sourceText("status.messaging.whatsappOwnChat");
}

/** The title of the side thread: an eye and the watched names, or the conversation's own name. */
export function watchThreadTitle(watchedNames: readonly string[]): string {
  const names = watchedNames.filter((name) => name.trim()).join(", ");
  return `👁️ ${names || selfChatTitle()}`;
}

/** Whether a message is in the linked number's own "Message yourself" chat. */
export function isSelfChat(platform: MessagingPlatform, workspaceId: string, platformChannelId: string): boolean {
  return platform === "whatsapp" && platformChannelId === userJid(workspaceId);
}

/**
 * Where a message's conversation shows: the owner's choice for the self chat, nothing for any other
 * conversation, which keeps its own hidden thread.
 */
export function selfChatPlacement(input: {
  selfChat: boolean;
  placement: WhatsAppWatchPlacement;
  watchedNames: readonly string[];
}): MessagingPlacement | undefined {
  if (!input.selfChat) return undefined;
  if (input.placement === "thread") return { kind: "thread", title: watchThreadTitle(input.watchedNames) };
  return { kind: input.placement };
}
