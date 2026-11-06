// @vitest-environment node
// Fork (docs/fork/FEATURES.md, "Agents continue after a restart"): the chat shows the wake as the
// routine line "🔄 Resumed after restart", not as a message from the user.
import { describe, expect, it } from "vitest";
import { toAgentMessage } from "./app-message-projection";

describe("restart resume wake", () => {
  it("is a routine line, not a user message", () => {
    const message = toAgentMessage(
      {
        id: "message-1",
        author: "user",
        text: "[OpenBot: 🔄 restart] Your last turn was interrupted …",
        createdAt: "2026-11-06T13:12:00.000Z",
        status: "completed",
        routine: {
          routineId: "fork-restart-resume",
          runId: "restart-resume:1:turn:t1",
          name: "🔄 Resumed after restart",
          scheduledFor: "2026-11-06T13:12:00.000Z",
        },
      },
      "agent-1",
    );
    expect(message.kind).toBe("action-marker");
    expect(message.actionMarker).toMatchObject({ kind: "routine-run", routineName: "🔄 Resumed after restart" });
  });
});
