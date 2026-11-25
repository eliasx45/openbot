import { createOpenBotLogger } from "@openbot/logging";
import type { WebContents } from "electron";

/**
 * Fork (docs/fork/FEATURES.md #109). The chat's own notes on why it left the latest message or moved
 * by more than a screen (renderer `chat-scroll-log.ts`) go into the main log, so the next "the chat
 * jumped" can be matched with what the chat did. Only lines with the tag pass; they carry row ids,
 * counts and scroll offsets, never message text.
 */
export const CHAT_SCROLL_LOG_TAG = "[openbot:chat-scroll]";
const LINE_LIMIT = 2_000;
const LINES_PER_MINUTE = 60;

const logger = createOpenBotLogger("chat-scroll");

export function forwardChatScrollLog(
  contents: Pick<WebContents, "on">,
  write: (line: string) => void = (line) => logger.info(line),
): void {
  let minute = 0;
  let lines = 0;
  contents.on("console-message", (event) => {
    if (!event.message.startsWith(CHAT_SCROLL_LOG_TAG)) return;
    const now = Math.floor(Date.now() / 60_000);
    if (now !== minute) {
      minute = now;
      lines = 0;
    }
    lines += 1;
    if (lines > LINES_PER_MINUTE) return;
    write(event.message.slice(CHAT_SCROLL_LOG_TAG.length).trim().slice(0, LINE_LIMIT));
  });
}
