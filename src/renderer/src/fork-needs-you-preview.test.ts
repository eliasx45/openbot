// @vitest-environment node
import type { AgentEvent } from "@openbot/contracts/ipc";
import { computeSidebarAgentStates } from "@openbot/ui/features/sidebar/sidebar-agent-states";
import { describe, expect, it } from "vitest";

const QUESTION = "Which **deploy target** should I use:\n`prod` or [staging](https://example.com/staging)?";

function prompt(question: string): Extract<AgentEvent, { type: "prompt" }> {
  return {
    type: "prompt",
    agentId: "bot",
    threadId: "main",
    turnId: "turn-1",
    requestId: "request-1",
    questions: [{ id: "q1", header: "Target", question, isSecret: false, options: null }],
  };
}

function waitDetail(input: Partial<Parameters<typeof computeSidebarAgentStates>[0]>) {
  const state = computeSidebarAgentStates({
    agentIds: ["bot"],
    activeTurns: {},
    queues: {},
    unreadReplies: {},
    recentReplies: {},
    pendingPrompts: {},
    pendingApprovals: {},
    failedTurns: {},
    ...input,
  }).bot;
  return state?.kind === "waiting" ? state.detail : undefined;
}

describe("a Needs you row in the sidebar", () => {
  it("shows a question as one line of plain text", () => {
    expect(waitDetail({ pendingPrompts: { bot: prompt(QUESTION) } })).toBe(
      "Which deploy target should I use: prod or staging?",
    );
  });

  it("keeps an approval's command as written", () => {
    const approval = {
      requestId: "approval-1",
      turnId: "turn-1",
      threadId: "main",
      kind: "command" as const,
      command: "rm -rf build/*.log **/tmp",
      cwd: null,
      reason: "Clean **old** logs",
      grantRoot: null,
      permissions: null,
    };
    expect(waitDetail({ pendingApprovals: { bot: approval } })).toBe("rm -rf build/*.log **/tmp");
    expect(waitDetail({ pendingApprovals: { bot: { ...approval, command: null } } })).toBe("Clean old logs");
  });
});
