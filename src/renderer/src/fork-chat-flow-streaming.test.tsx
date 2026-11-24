import type { AgentMessage } from "@openbot/ui/data";
import { MessageBody } from "@openbot/ui/features/conversation/MessageRendering";
import { render } from "@solidjs/testing-library";
import { createSignal, flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";

function streamingReply(first: string) {
  const [body, setBody] = createSignal(first);
  const [streaming, setStreaming] = createSignal(true);
  const message: AgentMessage = { id: "reply", author: "agent", body: first, time: "10:00", kind: "text" };
  Object.defineProperties(message, {
    body: { enumerable: true, get: body },
    streaming: { enumerable: true, get: streaming },
  });
  const view = render(() => (
    <MessageBody
      message={message}
      agents={[]}
      onSelectAgent={vi.fn()}
      onOpenLink={vi.fn()}
      onPreview={vi.fn()}
      onAttachmentAction={vi.fn()}
    />
  ));
  return { view, setBody, setStreaming };
}

function shownAfter(ms: number, view: ReturnType<typeof render>): string {
  vi.advanceTimersByTime(ms);
  flush();
  return view.container.textContent ?? "";
}

describe("a reply that streams", () => {
  afterEach(() => vi.useRealTimers());

  it("shows Chinese text as it arrives, not only when the line ends", () => {
    vi.useFakeTimers();
    const { view, setBody } = streamingReply("我检查了发布说明。");
    setBody("我检查了发布说明。标签与更新日志一致，所以今晚可以发布构建版本");
    flush();
    expect(shownAfter(2_000, view)).toContain("今晚可以发布构建版本");
  });

  it("still holds back the last English word until a space follows it", () => {
    vi.useFakeTimers();
    const { view, setBody, setStreaming } = streamingReply("I checked ");
    setBody("I checked the release notes and the tag matches");
    flush();
    const shown = shownAfter(2_000, view);
    expect(shown).toContain("and the tag");
    expect(shown).not.toContain("matches");
    setStreaming(false);
    flush();
    expect(shownAfter(2_000, view)).toContain("the tag matches");
  });
});
