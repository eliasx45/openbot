import type { ConversationSubagent } from "@openbot/contracts/ipc";
import { LiveWorkDock, type LiveWorkItem } from "@openbot/ui/features/conversation/LiveWork";
import { render, screen } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";

const question: LiveWorkItem = { kind: "waiting", key: "prompt", agentId: undefined, label: "Which branch?" };

const subagent: ConversationSubagent = {
  id: "sub-1",
  title: "Check the build",
  agentType: "Explore",
  prompt: null,
  status: "running",
  startedAt: new Date(Date.now() - 12_000).toISOString(),
  endedAt: null,
  steps: [],
  error: null,
};

function bar(items: readonly LiveWorkItem[]) {
  render(() => (
    <LiveWorkDock items={items} agentName={(id) => id ?? "Chief"} onOpenSubagent={vi.fn()} onReveal={vi.fn()} />
  ));
  return screen.getByRole("button", { expanded: false });
}

describe("the live work bar", () => {
  it("does not say that nothing works when only a question waits", () => {
    const button = bar([question]);
    expect(button.textContent).toContain("1 waits for you");
    expect(button.textContent).not.toContain("0 working");
  });

  it("still counts the work when a subagent runs", () => {
    const button = bar([
      question,
      { kind: "subagent", key: "card:sub-1", cardId: "card", agentId: undefined, subagent },
    ]);
    expect(button.textContent).toContain("1 working");
    expect(button.textContent).toContain("1 waits for you");
  });
});
