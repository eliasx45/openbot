// The Antigravity agent of `antigravity-ask-question-e2e.ts`. Each prompt asks three questions as
// `agy acp` 1.5.15's `ask_question` tool does: one `elicitation/create` with the generic message
// "The agent has 3 questions.", one field per question titled with the question (a single select is a
// string with `oneOf`, a multi-select an array whose `items` have `anyOf`), and a `<id>_other`
// free-text field for each. The request is the one of a live capture (lab
// `RE-antigravity-ask-question/captures/run1/elicitations.json`). It logs the client's reply.
import { logEntry, serveFakeAcpAgent } from "../acp-agent";

const MODELS = { availableModels: [{ modelId: "gemini-fake", name: "Gemini Fake" }], currentModelId: "gemini-fake" };
let count = 0;

const other = (question: string) => ({
  type: "string",
  title: "Other",
  description: `Optional free-form answer to: ${question}`,
});

const choices = (...titles: string[]) => titles.map((title, index) => ({ const: String(index + 1), title }));

const REQUESTED_SCHEMA = {
  type: "object",
  properties: {
    q1: { type: "string", title: "Which color?", oneOf: choices("Red", "Green", "Blue") },
    q1_other: other("Which color?"),
    q2: {
      type: "array",
      title: "Which fruits do you like?",
      items: { anyOf: choices("Apple", "Banana", "Cherry", "Durian") },
    },
    q2_other: other("Which fruits do you like?"),
    q3: { type: "string", title: "What is your name?", oneOf: choices("Anonymous", "Prefer not to say") },
    q3_other: other("What is your name?"),
  },
};

serveFakeAcpAgent({
  initialize: (request, peer) =>
    peer.reply(request, {
      protocolVersion: 1,
      agentInfo: { name: "antigravity", version: "1.5.15" },
      agentCapabilities: { loadSession: true },
      authMethods: [],
    }),
  "session/new": (request, peer) => {
    count += 1;
    peer.reply(request, { sessionId: `agy-${process.pid}-${count}`, models: MODELS });
  },
  "session/prompt": (request, peer) => {
    const sessionId = request.params.sessionId ?? "";
    void peer
      .ask("elicitation/create", {
        sessionId,
        toolCallId: `call_${count}`,
        mode: "form",
        message: "The agent has 3 questions.",
        requestedSchema: REQUESTED_SCHEMA,
      })
      .then((reply) => {
        logEntry({ event: "reply", sessionId, text: JSON.stringify(reply) });
        peer.say(sessionId, "answered");
        peer.reply(request, { stopReason: "end_turn" });
      });
  },
});
