// Fork (docs/fork/FEATURES.md #109): the chat's tagged notes on why it scrolled reach the main log;
// other console lines of the window do not, and a burst is capped.
import { EventEmitter } from "node:events";
import type { WebContents } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CHAT_SCROLL_LOG_TAG, forwardChatScrollLog } from "./fork-chat-scroll-log";

const info = vi.fn();

function contents(): EventEmitter {
  const emitter = new EventEmitter();
  // biome-ignore lint/nursery/noUnsafeTypeAssertion: the forwarder only listens for console messages.
  forwardChatScrollLog(emitter as unknown as Pick<WebContents, "on">, info);
  return emitter;
}

afterEach(() => info.mockReset());

describe("chat scroll notes in the main log", () => {
  it("keeps only the chat's tagged lines", () => {
    const window = contents();
    window.emit("console-message", { message: "some other renderer warning" });
    window.emit("console-message", { message: `${CHAT_SCROLL_LOG_TAG} {"reason":"focus-in","rows":120}` });
    expect(info.mock.calls).toEqual([['{"reason":"focus-in","rows":120}']]);
  });

  it("writes at most 60 lines a minute", () => {
    const window = contents();
    for (let line = 0; line < 100; line += 1)
      window.emit("console-message", { message: `${CHAT_SCROLL_LOG_TAG} {"reason":"unprompted-move"}` });
    expect(info).toHaveBeenCalledTimes(60);
  });
});
