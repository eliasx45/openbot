// @vitest-environment node
// Fork: a subagent that Claude Code's `SendMessage` resumes counts as running until the CLI's
// `task_notification` for that run, which names the `SendMessage` call. Tatiana, 12 Nov 2026: the
// resumed subagent showed as done, and the turn's end sent a "plan has open steps" note.

import { clampConversationSubagents, isConversationSubagents } from "@openbot/contracts/ipc";
import type { DynamicRecord } from "@openbot/contracts/runtime-values";
import { describe, expect, it } from "vitest";
import { foldAcpSubagentTool } from "./acp-subagent-updates";
import {
  type CodexSubagentModels,
  endSubagentTurn,
  foldClaudeSubagentCall,
  foldClaudeSubagentMessage,
  foldClaudeSubagentResult,
  foldClaudeSubagentResume,
  foldClaudeTaskMessage,
  foldCodexSubagentItem,
  newSubagentState,
  type SubagentState,
  stopSubagents,
} from "./subagent-updates";

const AGENT_ID = "a150ab794b19a747a";
const now = (minute: number) => `2026-11-12T17:${String(minute).padStart(2, "0")}:00.000Z`;

/** A background subagent that started in turn-1 and finished after that turn ended. */
function finishedSubagent(): SubagentState {
  const state = newSubagentState();
  foldClaudeSubagentCall(
    state,
    "turn-1",
    {
      id: "toolu_agent",
      name: "Agent",
      input: { description: "Smoothness analysis", prompt: "Go", run_in_background: true },
    },
    now(0),
  );
  foldClaudeSubagentResult(
    state,
    "toolu_agent",
    { isAsync: true, status: "async_launched", agentId: AGENT_ID },
    false,
    "",
    now(0),
  );
  endSubagentTurn(state, "turn-1", now(1));
  const done = foldClaudeTaskMessage(
    state,
    {
      type: "system",
      subtype: "task_notification",
      task_id: AGENT_ID,
      tool_use_id: "toolu_agent",
      status: "completed",
    },
    now(22),
  );
  expect(done?.subagents[0]?.status).toBe("completed");
  return state;
}

function sendMessage(state: SubagentState, id: string, to = AGENT_ID): void {
  foldClaudeSubagentCall(
    state,
    "turn-2",
    { id, name: "SendMessage", input: { to, summary: "Pass 2: motion", message: "Now do pass 2." } },
    now(29),
  );
}

const running = (state: SubagentState) =>
  [...state.turns.values()].flatMap((turn) => turn.subagents).filter((subagent) => subagent.status === "running");

describe("a subagent that SendMessage resumes", () => {
  it("runs again until the notification that names the SendMessage call", () => {
    const state = finishedSubagent();
    sendMessage(state, "toolu_send");
    // The shape Claude Code wrote at 17:29:58 on 12 Nov 2026.
    const resumed = foldClaudeSubagentResume(
      state,
      "turn-2",
      "toolu_send",
      {
        success: true,
        message: "Resuming agent a150ab7",
        resumedAgentId: AGENT_ID,
        revivedAgentId: AGENT_ID,
        pin: { id: AGENT_ID, name: AGENT_ID, ref: "74785e" },
      },
      false,
      "",
      now(29),
    );
    expect(resumed?.turnId).toBe("turn-2");
    expect(resumed?.subagents).toMatchObject([
      { id: "toolu_send", status: "running", background: true, providerAgentId: AGENT_ID, prompt: "Now do pass 2." },
    ]);
    // The turn that sent it ends; the background subagent works on, so no plan note may follow.
    endSubagentTurn(state, "turn-2", now(32));
    expect(running(state).map((subagent) => subagent.id)).toEqual(["toolu_send"]);

    const done = foldClaudeTaskMessage(
      state,
      {
        type: "system",
        subtype: "task_notification",
        task_id: AGENT_ID,
        tool_use_id: "toolu_send",
        status: "completed",
      },
      now(55),
    );
    expect(done?.subagents[0]?.status).toBe("completed");
    expect(running(state)).toEqual([]);
    expect(state.turns.size).toBe(0);
  });

  it("reads the result from the text when the structured result is missing", () => {
    const state = finishedSubagent();
    sendMessage(state, "toolu_send");
    const text = JSON.stringify({ success: true, message: "Resuming agent a150ab7", resumedAgentId: AGENT_ID });
    expect(foldClaudeSubagentResume(state, "turn-2", "toolu_send", undefined, false, text, now(29))).not.toBeNull();
    expect(running(state)).toHaveLength(1);
  });

  it("starts nothing for a message queued to a subagent that still runs", () => {
    const state = finishedSubagent();
    sendMessage(state, "toolu_send");
    const queued = {
      success: true,
      message: `Message queued for delivery to ${AGENT_ID} at its next tool round.`,
      pin: { id: AGENT_ID, name: AGENT_ID, ref: "74785e" },
    };
    expect(foldClaudeSubagentResume(state, "turn-2", "toolu_send", queued, false, "", now(29))).toBeNull();
    expect(running(state)).toEqual([]);
  });

  it("starts nothing and keeps nothing for an unknown id", () => {
    const state = finishedSubagent();
    sendMessage(state, "toolu_send", "no-such-agent");
    expect(
      foldClaudeSubagentResume(state, "turn-2", "toolu_send", undefined, true, "No agent named no-such-agent", now(29)),
    ).toBeNull();
    expect(running(state)).toEqual([]);
    expect(state.sends?.size).toBe(0);
    // A notification for an id nobody runs changes nothing.
    expect(
      foldClaudeTaskMessage(
        state,
        { type: "system", subtype: "task_notification", tool_use_id: "toolu_send", status: "completed" },
        now(30),
      ),
    ).toBeNull();
  });

  it("ends with the session when no notification comes", () => {
    const state = finishedSubagent();
    sendMessage(state, "toolu_send");
    foldClaudeSubagentResume(
      state,
      "turn-2",
      "toolu_send",
      { success: true, resumedAgentId: AGENT_ID },
      false,
      "",
      now(29),
    );
    endSubagentTurn(state, "turn-2", now(32));
    const stopped = stopSubagents(state, now(40));
    expect(stopped[0]?.subagents[0]?.status).toBe("stopped");
    expect(running(state)).toEqual([]);
  });

  it("forgets a SendMessage call whose turn ended without its result", () => {
    const state = finishedSubagent();
    sendMessage(state, "toolu_send");
    endSubagentTurn(state, "turn-2", now(32));
    expect(state.sends?.size).toBe(0);
  });
});

// Fork #78: every subagent shows the model (and effort) it runs on, for every provider. Elias,
// 12 Nov 2026: "not just Claude ofc, everything, i wanna see the subagents model".
describe("the model a subagent runs on", () => {
  const PARENT = { model: "claude-opus-5-5", effort: "high" };
  const agentCall = (state: SubagentState, input: DynamicRecord) =>
    foldClaudeSubagentCall(
      state,
      "turn-1",
      { id: "toolu_agent", name: "Agent", input: { description: "Scan", prompt: "Go", ...input } },
      now(0),
      PARENT,
      (alias) => (alias === "sonnet" ? "claude-sonnet-5" : undefined),
    )?.subagents[0];

  it("Claude: takes the model alias and effort of the Agent call", () => {
    const subagent = agentCall(newSubagentState(), { model: "sonnet", effort: "low" });
    expect(subagent).toMatchObject({ model: "claude-sonnet-5", effort: "low" });
  });

  it("Claude: inherits the parent's model and effort when the call names none", () => {
    const subagent = agentCall(newSubagentState(), { subagent_type: "general-purpose" });
    expect(subagent).toMatchObject({ model: "claude-opus-5-5", effort: "high", agentType: "general-purpose" });
  });

  it("Claude: keeps an alias the lists do not know as it is", () => {
    expect(agentCall(newSubagentState(), { model: "fable" })?.model).toBe("fable");
  });

  it("Claude: the model the subagent's first message names wins, and an inherited effort goes", () => {
    const state = newSubagentState();
    agentCall(state, { subagent_type: "Explore" });
    const change = foldClaudeSubagentMessage(state, "toolu_agent", "msg-1", {
      model: "claude-haiku-4-5-20251001",
      content: [{ type: "text", text: "Looking" }],
    });
    expect(change?.subagents[0]?.model).toBe("claude-haiku-4-5-20251001");
    expect(change?.subagents[0]?.effort).toBeUndefined();
    // A later message does not change it again.
    foldClaudeSubagentMessage(state, "toolu_agent", "msg-2", { model: "x", content: [{ type: "text", text: "a" }] });
    expect(running(state)[0]?.model).toBe("claude-haiku-4-5-20251001");
  });

  it("Claude: an explicit effort stays when the reported model differs", () => {
    const state = newSubagentState();
    agentCall(state, { model: "sonnet", effort: "max" });
    const change = foldClaudeSubagentMessage(state, "toolu_agent", "msg-1", {
      model: "claude-sonnet-5-1",
      content: [{ type: "text", text: "a" }],
    });
    expect(change?.subagents[0]).toMatchObject({ model: "claude-sonnet-5-1", effort: "max" });
  });

  it("Codex: the requested model and effort of spawnAgent, then the resolved ones", () => {
    const models: CodexSubagentModels = { parent: { model: "gpt-5.5", effort: "medium" }, resolved: new Map() };
    const spawn = {
      type: "collabAgentToolCall",
      tool: "spawnAgent",
      status: "completed",
      receiverThreadIds: ["child-1"],
      prompt: "Run the tests",
      model: "gpt-5.5-mini",
      reasoningEffort: "low",
      agentsStates: {},
    };
    const spawned = foldCodexSubagentItem([], spawn, now(0), models);
    expect(spawned?.[0]).toMatchObject({ model: "gpt-5.5-mini", effort: "low", agentType: null });
    const activity = {
      type: "subAgentActivity",
      kind: "started",
      agentThreadId: "child-1",
      model: "gpt-5.5-mini-2026",
      reasoningEffort: "high",
    };
    expect(foldCodexSubagentItem(spawned ?? [], activity, now(1), models)?.[0]).toMatchObject({
      model: "gpt-5.5-mini-2026",
      effort: "high",
    });
  });

  it("Codex: inherits the parent's model, and an activity that came first wins", () => {
    const models: CodexSubagentModels = { parent: { model: "gpt-5.5", effort: "xhigh" }, resolved: new Map() };
    const spawn = (id: string) => ({ type: "collabAgentToolCall", tool: "spawnAgent", receiverThreadIds: [id] });
    expect(foldCodexSubagentItem([], spawn("a"), now(0), models)?.[0]).toMatchObject({
      model: "gpt-5.5",
      effort: "xhigh",
    });
    foldCodexSubagentItem([], { type: "subAgentActivity", agentThreadId: "b", model: "gpt-5.4" }, now(0), models);
    expect(foldCodexSubagentItem([], spawn("b"), now(1), models)?.[0]).toMatchObject({
      model: "gpt-5.4",
      effort: "xhigh",
    });
    expect(models.resolved.size).toBe(0);
  });

  it("ACP: the model the call names, else the session's", () => {
    const call = (id: string, rawInput: DynamicRecord) =>
      foldAcpSubagentTool(
        newSubagentState(),
        "turn-1",
        ["delegate_task"],
        { id, name: "delegate_task", status: "in_progress", rawInput, rawOutput: null, content: null },
        now(0),
        { model: "kimi-k3", effort: null },
      )?.subagents[0];
    expect(call("a", { goal: "x" })).toMatchObject({ model: "kimi-k3" });
    expect(call("a", { goal: "x" })?.effort).toBeUndefined();
    expect(call("b", { goal: "x", model: "glm-5", reasoning_effort: "high" })).toMatchObject({
      model: "glm-5",
      effort: "high",
    });
  });

  it("stored lists without the fields still load, and the fields survive the clamp", () => {
    const old = {
      id: "s1",
      title: "Old",
      agentType: "Explore",
      prompt: null,
      status: "completed" as const,
      startedAt: now(0),
      endedAt: now(1),
      steps: [],
      error: null,
    };
    expect(isConversationSubagents([old])).toBe(true);
    const withModel = { ...old, model: " claude-opus-5-5 ", effort: "high" } as const;
    expect(isConversationSubagents([withModel])).toBe(true);
    expect(clampConversationSubagents([withModel])?.[0]).toMatchObject({ model: "claude-opus-5-5", effort: "high" });
    expect(clampConversationSubagents([old])?.[0]).not.toHaveProperty("model");
  });
});
