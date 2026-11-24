import type { AgentMessage } from "@openbot/ui/data";
import { dayMarkerLabel } from "@openbot/ui/features/conversation/chat-day-markers";
import { render } from "@solidjs/testing-library";
import { flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StoryConversation } from "../stories/conversation-story-support";

function at(day: number, hour: number, minute: number): string {
  return new Date(2026, 10, day, hour, minute).toISOString();
}

function rowsSaying(text: string): string[] {
  return [...document.querySelectorAll(".virtual-chat-row")]
    .filter((row) => row.textContent?.includes(text))
    .map((row) => row.querySelector("[data-chat-search-message]")?.getAttribute("data-chat-search-message") ?? "");
}

function timeMarkers(): string[] {
  return [...document.querySelectorAll(".time-marker")].map((marker) => marker.textContent ?? "");
}

describe("the chat timeline", () => {
  afterEach(() => vi.useRealTimers());

  it("renames the day separators when the day changes while the chat stays open", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(new Date(2026, 10, 21, 23, 59, 0));
    const messages: AgentMessage[] = [
      { id: "late", author: "you", body: "Ship it tonight.", time: "22:00", createdAt: at(21, 22, 0), kind: "text" },
    ];
    render(() => <StoryConversation messages={messages} />);
    await expect.poll(() => document.querySelectorAll(".virtual-chat-row").length).toBe(1);
    const today = dayMarkerLabel(undefined, at(21, 22, 0), { now: new Date(2026, 10, 21, 23, 59) });
    expect(timeMarkers()).toEqual([today]);

    vi.advanceTimersByTime(2 * 60_000);
    flush();
    const yesterday = dayMarkerLabel(undefined, at(21, 22, 0), { now: new Date(2026, 10, 22, 0, 1) });
    expect(yesterday).not.toBe(today);
    await expect.poll(timeMarkers).toEqual([yesterday]);
  });

  it("starts a new day at a steps row that opens the day", async () => {
    const messages: AgentMessage[] = [
      { id: "ask", author: "you", body: "Check the release.", time: "23:58", createdAt: at(20, 23, 58), kind: "text" },
      {
        id: "thinking:turn-night",
        turnId: "turn-night",
        author: "agent",
        body: "",
        time: "00:01",
        createdAt: at(21, 0, 1),
        itemType: "commentary",
        kind: "thinking",
        items: ["Reading the release notes"],
        itemIds: ["step-1"],
        itemCreatedAt: [at(21, 0, 1)],
        itemStreaming: [false],
      },
      { id: "next", author: "you", body: "Any news?", time: "00:05", createdAt: at(21, 0, 5), kind: "text" },
    ];
    render(() => <StoryConversation messages={messages} />);
    await expect.poll(() => document.querySelectorAll(".virtual-chat-row").length).toBe(3);
    expect(timeMarkers()).toEqual([
      dayMarkerLabel(undefined, at(20, 23, 58)),
      dayMarkerLabel(at(20, 23, 58), at(21, 0, 1)),
    ]);
  });

  it("shows the compaction note when the first row after it is a steps row", async () => {
    const messages: AgentMessage[] = [
      { id: "ask", author: "you", body: "Check the release.", time: "10:00", createdAt: at(21, 10, 0), kind: "text" },
      {
        id: "thinking:turn-stopped",
        turnId: "turn-stopped",
        author: "agent",
        body: "",
        time: "10:02",
        createdAt: at(21, 10, 2),
        itemType: "commentary",
        kind: "thinking",
        items: ["Reading the release notes"],
        itemIds: ["step-1"],
        itemCreatedAt: [at(21, 10, 2)],
        itemStreaming: [false],
      },
    ];
    render(() => (
      <StoryConversation
        messages={messages}
        contextState={{
          agentId: "chief",
          threadId: "thread-chief",
          usage: null,
          compaction: { id: "compaction-1", startedAt: Date.parse(at(21, 10, 1)), status: "completed" },
        }}
      />
    ));
    await expect.poll(() => document.querySelectorAll(".virtual-chat-row").length).toBe(2);
    expect(rowsSaying("Context compacted")).toEqual(["thinking:turn-stopped"]);
  });
});
