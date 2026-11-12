// @vitest-environment node
// Fork: a subagent that Claude Code's `SendMessage` resumes counts as running until the CLI's
// `task_notification` for that run, which names the `SendMessage` call. Tatiana, 12 Nov 2026: the
// resumed subagent showed as done, and the turn's end sent a "plan has open steps" note.
import { describe, expect, it } from "vitest";
import {
  endSubagentTurn,
  foldClaudeSubagentCall,
  foldClaudeSubagentResult,
  foldClaudeSubagentResume,
  foldClaudeTaskMessage,
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
