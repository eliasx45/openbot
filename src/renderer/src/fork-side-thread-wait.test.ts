// @vitest-environment node
// Fork (docs/fork/FEATURES.md, "A question in a side thread marks its agent"): a routine thread that
// asked the user a question marked its agent with the "working" dots, because the wait was dropped
// as "not the agent's own thread" while the running task still counted as work.
import type { AgentEvent } from "@openbot/contracts/ipc";
import { computeSidebarAgentStates } from "@openbot/ui/features/sidebar/sidebar-agent-states";
import { describe, expect, it } from "vitest";
import { agentThreadAttention, agentWaitThreadId } from "./features/agents/agent-thread-attention";

const prompt = (threadId: string): Extract<AgentEvent, { type: "prompt" }> => ({
  type: "prompt",
  agentId: "bot",
  threadId,
  turnId: `turn-${threadId}`,
  requestId: `request-${threadId}`,
  questions: [{ id: "q1", header: "Check", question: "Fix the check?", isSecret: false, options: null }],
});

const agents = [{ id: "bot", threadId: "main" }];

function sidebarState(input: Parameters<typeof agentThreadAttention>[0]) {
  return computeSidebarAgentStates({
    agentIds: ["bot"],
    // The routine thread's running task, as WorkspaceSidebar's workingTurns adds it.
    activeTurns: { bot: "turn-health" },
    queues: {},
    unreadReplies: {},
    recentReplies: {},
    ...agentThreadAttention(input),
    failedTurns: {},
  }).bot;
}

describe("a question in a side thread", () => {
  it("marks its agent as waiting, not working", () => {
    const input = { agents, pendingPrompts: { k: prompt("health") }, approvals: [], sideThreads: () => ["health"] };
    expect(sidebarState(input)).toEqual({ kind: "waiting", reason: "question", detail: "Fix the check?" });
    expect(agentWaitThreadId(input, "bot")).toBe("health");
  });

  it("was shown as working before: without side threads the wait is dropped", () => {
    expect(sidebarState({ agents, pendingPrompts: { k: prompt("health") }, approvals: [] })).toEqual({
      kind: "working",
    });
  });

  it("ignores a channel thread and puts the agent's own chat first", () => {
    const channel = { agents, pendingPrompts: { k: prompt("channel") }, approvals: [], sideThreads: () => ["health"] };
    expect(sidebarState(channel)).toEqual({ kind: "working" });
    expect(agentWaitThreadId(channel, "bot")).toBeUndefined();
    const both = {
      agents,
      pendingPrompts: { a: prompt("health"), b: prompt("main") },
      approvals: [],
      sideThreads: () => ["health"],
    };
    expect(agentThreadAttention(both).pendingPrompts.bot).toMatchObject({ threadId: "main" });
    expect(agentWaitThreadId(both, "bot")).toBe("main");
  });
});
