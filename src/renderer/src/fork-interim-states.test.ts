// @vitest-environment node
// Fork (docs/fork/FEATURES.md #132): no interim states. A message goes straight to where it belongs
// (chat or queue panel) and moves only when its state really changes.
import type { ConversationMessage, QueueDelivery, QueueSnapshot } from "@openbot/contracts/ipc";
import { deliveryWaitsForProvider } from "@openbot/contracts/ipc";
import type { AgentMessage } from "@openbot/ui/data";
import { describe, expect, it } from "vitest";
import { toAgentMessage, toAgentMessages } from "./app-message-projection";
import { agentAwaitingReplies } from "./awaiting-replies";
import { createRetryNotices, laterTurnRunning } from "./features/agents/agent-error-text";
import type { PendingSend } from "./features/conversation/stores/pending-send-store";
import { queueSendingRows } from "./features/conversation/stores/queue-store";
import { presentQueueDeliveries, runningTurnTakesMessages } from "./queue-reconciliation";

function delivery(id: string, overrides: Partial<QueueDelivery> = {}): QueueDelivery {
  return {
    id,
    messageId: id,
    recipientAgentId: "vegapunk",
    sender: { kind: "user" },
    text: `Note ${id}`,
    attachments: [],
    replyToMessageId: null,
    status: "queued",
    position: 1,
    turnId: null,
    error: null,
    createdAt: "2026-11-27T15:31:00.000Z",
    ...overrides,
  };
}

const routine = (turnId: string) =>
  delivery("health", {
    sender: { kind: "routine", routineId: "r1", runId: "run1", routineName: "Health", scheduledFor: "x" },
    status: "running",
    position: null,
    turnId,
  });

const snapshot = (deliveries: QueueDelivery[], hold?: QueueSnapshot["hold"]): QueueSnapshot => ({
  agentId: "vegapunk",
  deliveries,
  ...(hold ? { hold } : {}),
});

function userMessage(id: string, status: NonNullable<ConversationMessage["delivery"]>["status"]): ConversationMessage {
  return {
    id,
    author: "user",
    source: "user",
    text: `Message ${id}`,
    createdAt: "2026-11-27T15:31:00.000Z",
    status: "completed",
    delivery: { id, status, position: null },
  };
}

describe("a message sent while the agent works", () => {
  it("joins the running turn only when that turn takes messages", () => {
    expect(runningTurnTakesMessages(snapshot([]), "turn-1")).toBe(true);
    // The trigger: a routine run holds the turn, so the host keeps the message in the queue.
    expect(runningTurnTakesMessages(snapshot([routine("turn-1")]), "turn-1")).toBe(false);
    expect(runningTurnTakesMessages(snapshot([routine("turn-0")]), "turn-1")).toBe(true);
    expect(runningTurnTakesMessages(snapshot([delivery("a")]), null)).toBe(false);
    expect(
      runningTurnTakesMessages(snapshot([delivery("a")], { reason: "sign-in", provider: "antigravity" }), "turn-1"),
    ).toBe(false);
  });
});

describe("a delivery the provider has not taken yet", () => {
  it("stays in the queue panel while the host starts or steers it", () => {
    const starting = delivery("start", { status: "starting", position: null });
    const steering = delivery("steer", { status: "starting", position: null, turnId: "turn-1" });
    const reply = delivery("reply", {
      sender: { kind: "agent", agentId: "chopper" },
      status: "starting",
      replyToMessageId: "ask",
      expectsReply: false,
    });
    const routineStart = delivery("routine", {
      sender: { kind: "routine", routineId: "r1", runId: "run1", routineName: "Health", scheduledFor: "x" },
      status: "starting",
    });
    const shown = presentQueueDeliveries({
      snapshot: snapshot([delivery("queued"), starting, steering, reply, routineStart]),
      activeTurnId: "turn-1",
      renderedMessageIds: new Set(),
    }).map((item) => item.id);
    expect(shown).toEqual(["queued", "start", "steer"]);
    expect(deliveryWaitsForProvider(reply)).toBe(false);
    expect(deliveryWaitsForProvider(routineStart)).toBe(false);
  });

  it("is not drawn in the agent chat until it runs", () => {
    const messages = [userMessage("start", "starting"), userMessage("run", "running")];
    expect(toAgentMessages(messages, "vegapunk", undefined, { holdStarting: true }).map((item) => item.id)).toEqual([
      "run",
    ]);
    // Other views (a task thread) keep their rows.
    expect(toAgentMessages(messages, "vegapunk").map((item) => item.id)).toEqual(["start", "run"]);
  });

  it("keeps the sender's chip queued until the teammate's turn takes it", () => {
    const outgoing = (status: QueueDelivery["status"]): ConversationMessage => ({
      id: "outbox-ask",
      author: "system",
      source: "system",
      text: "Please check",
      createdAt: "2026-11-27T15:31:00.000Z",
      status: "completed",
      itemType: "agent_exchange",
      exchange: {
        direction: "outgoing",
        messageId: "ask",
        senderAgentId: "vegapunk",
        recipientAgentIds: ["chopper"],
        replyToMessageId: null,
        deliveries: [{ id: "d1", recipientAgentId: "chopper", status, position: null, error: null }],
      },
    });
    const marker = (status: QueueDelivery["status"]) => {
      const shown = toAgentMessage(outgoing(status), "vegapunk").actionMarker;
      return shown?.kind === "agent-message" ? shown.status : undefined;
    };
    expect(marker("queued")).toBe("queued");
    expect(marker("starting")).toBe("queued");
    expect(marker("running")).toBe("in-progress");
  });
});

describe("a queued send", () => {
  const send = (overrides: Partial<PendingSend>): PendingSend => ({
    clientMessageId: "c1",
    draft: { text: "still not working", attachments: [], replyToMessageId: null },
    text: "still not working",
    createdAt: "2026-11-27T15:35:17.000Z",
    state: "sending",
    messageId: null,
    error: null,
    errorReference: null,
    retrySafe: true,
    voiceRecordingDraftId: null,
    queued: true,
    starting: false,
    ...overrides,
  });
  const rows = (sends: PendingSend[], deliveries: QueueDelivery[], matched = new Map<string, string>()) =>
    queueSendingRows({ agentId: "vegapunk", sends, deliveries, messageIds: new Set(), matched });

  it("shows in the queue panel before the host lists it", () => {
    const result = rows([send({})], []);
    expect(result.rows.map((row) => [row.id, row.text, row.status])).toEqual([
      ["pending:c1", "still not working", "queued"],
    ]);
  });

  it("hands its panel row to the host's row, matched before or after the reply", () => {
    const listed = delivery("302ff842", { text: "still not working" });
    expect(rows([send({})], [listed], new Map([["c1", "302ff842"]]))).toEqual({
      rows: [],
      handoffs: new Map([["302ff842", "pending:c1"]]),
    });
    expect(rows([send({ state: "sent", messageId: "302ff842" })], [listed]).handoffs.get("302ff842")).toBe(
      "pending:c1",
    );
  });

  it("leaves a failed send to the chat, where retry lives", () => {
    expect(rows([send({ state: "failed" })], []).rows).toEqual([]);
  });
});

describe("the error banner", () => {
  it("ends when a later turn starts, but a live retry notice stays", () => {
    const notices = createRetryNotices();
    let errors: Record<string, string> = { "local:vegapunk": "Gemini did not answer in time" };
    let runs: Record<string, { message: string }> = { "local:vegapunk": { message: "Gemini did not answer in time" } };
    const setErrors = (update: (current: Record<string, string>) => Record<string, string>) => {
      errors = update(errors);
    };
    const setRuns = (update: (current: Record<string, { message: string }>) => Record<string, { message: string }>) => {
      runs = update(runs);
    };
    notices.noteError("local:vegapunk", "Gemini did not answer in time", "Gemini did not answer in time");
    notices.clearAtTurnStart("local:vegapunk", setErrors, setRuns);
    expect(errors).toEqual({});
    expect(runs).toEqual({});
  });

  it("is not cleared by the late end of an older turn while a newer one runs", () => {
    expect(laterTurnRunning("turn-2", "turn-1")).toBe(true);
    expect(laterTurnRunning("turn-1", "turn-1")).toBe(false);
    expect(laterTurnRunning(null, "turn-1")).toBe(false);
  });
});

describe("the waiting-for-replies card", () => {
  const ask: AgentMessage = {
    id: "outbox-ask",
    author: "agent",
    body: "",
    time: "15:19",
    exchange: {
      direction: "outgoing",
      messageId: "ask",
      senderAgentId: "vegapunk",
      recipientAgentIds: ["chopper", "pacer"],
      replyToMessageId: null,
      deliveries: [
        { id: "d-chopper", recipientAgentId: "chopper", status: "running", position: null, error: null },
        { id: "d-pacer", recipientAgentId: "pacer", status: "running", position: null, error: null },
      ],
    },
  };
  const readReply: AgentMessage = {
    id: "ccb581ba",
    author: "agent",
    body: "Result: done",
    time: "15:19",
    exchange: {
      direction: "incoming",
      messageId: "reply",
      senderAgentId: "chopper",
      recipientAgentIds: ["vegapunk"],
      replyToMessageId: "ask",
      deliveries: [{ id: "ccb581ba", recipientAgentId: "vegapunk", status: "running", position: null, error: null }],
    },
  };
  const states = (messages: AgentMessage[]) =>
    agentAwaitingReplies({ messages, queue: undefined, agents: [], self: undefined }).map((row) => [row.id, row.state]);

  it("keeps a teammate whose reply was read as replied while others still work", () => {
    expect(states([ask, readReply])).toEqual([
      ["ask:chopper", "replied"],
      ["ask:pacer", "working"],
    ]);
  });

  it("closes the request's rows together once every teammate is done", () => {
    const done: AgentMessage = {
      ...ask,
      exchange: {
        direction: "outgoing",
        messageId: "ask",
        senderAgentId: "vegapunk",
        recipientAgentIds: ["chopper"],
        replyToMessageId: null,
        deliveries: [
          { id: "d-chopper", recipientAgentId: "chopper", status: "completed", position: null, error: null },
        ],
      },
    };
    expect(states([done, readReply])).toEqual([]);
  });
});
