import type { AgentEvent } from "@openbot/contracts/ipc";
import { describe, expect, it } from "vitest";
import { reduceAgentActivity } from "./agent-activity";

describe("the wait line of an agent on the phone", () => {
  it("shows a question as one line of plain text", () => {
    const event: Extract<AgentEvent, { type: "prompt" }> = {
      type: "prompt",
      agentId: "bot",
      threadId: "main",
      turnId: "turn-1",
      requestId: "request-1",
      questions: [
        {
          id: "q1",
          header: "Target",
          question: "Which **deploy target** should I use:\n`prod` or [staging](https://example.com/staging)?",
          isSecret: false,
          options: null,
        },
      ],
    };
    expect(reduceAgentActivity({}, event).bot?.detail).toBe("Which deploy target should I use: prod or staging?");
  });
});
