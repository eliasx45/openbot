// Fork (docs/fork/FEATURES.md, "A message closes the open card"): the card must also close in a routine run.
// 13 Nov 2026: two `ask_ui` cards of routine runs stayed "pending" in the chat forever. The user wrote,
// the agent got the skip and answered, but the stored card was never closed. The event log showed
// `prompt.resolved` (closed), then 10 ms later a whole-chat write from an older copy of the chat that
// put the card back as pending. The run's move from needs-attention back to running replaced the chat
// object that the send still held.

import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSummary, ConversationMessage } from "@openbot/contracts/ipc";
import {
  normalizeConversationUiBlock,
  normalizeUiBlockSpec,
  UI_BLOCK_VERSION,
  type UiBlockSpec,
} from "@openbot/contracts/ui-blocks";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { AttentionRegistry } from "./agent/attention-registry";
import { ConversationRuntime } from "./agent/conversation-runtime";
import { AgentStore } from "./agent-store";
import { CodexAppServerClient } from "./app-server-client";
import { runCauseEffect } from "./effect-boundary";
import { OpenBotDatabase } from "./openbot-database";
import type { RequestId } from "./protocol";

const AGENT_ID = "agent-recall";
const THREAD_ID = "openbot-thread-agent-recall";
/** The routine run's own provider session, bound to the agent's own chat. */
const ROUTINE_SESSION = "routine-session-1";
const ROUTINE_TURN = "routine-turn-1";

const roots: string[] = [];
const databases: OpenBotDatabase[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** Records what OpenBot answers to the agent. The process never starts. */
class RecordingClient extends CodexAppServerClient {
  readonly answers = new Map<RequestId, unknown>();

  override get running(): boolean {
    return true;
  }

  override respond(id: RequestId, result: unknown): void {
    this.answers.set(id, result);
  }
}

/** The real store, with one agent whose chat already exists. Nothing is read from or written to disk. */
class OneAgentStore extends AgentStore {
  readonly #agent: AgentSummary;

  constructor(root: string, database: OpenBotDatabase, agent: AgentSummary) {
    super(root, root, database);
    this.#agent = agent;
  }

  override list(): AgentSummary[] {
    return [this.#agent];
  }

  override ensureThreadIdNow(): string {
    return THREAD_ID;
  }

  override ownsThread(): boolean {
    return false;
  }
}

function agentSummary(): AgentSummary {
  return {
    id: AGENT_ID,
    provider: "codex",
    name: "Recall",
    title: "Tutor",
    description: "",
    notifications: true,
    model: "gpt-5.6-luna",
    reasoningEffort: "medium",
    threadId: THREAD_ID,
    workspacePath: "/tmp/openbot-recall",
    preview: "",
    updatedAt: "2026-11-13T12:00:00.000Z",
    avatarSeed: "recall",
    avatarHue: null,
    avatarUrl: null,
  };
}

function specOf(block: unknown): UiBlockSpec {
  const spec = normalizeUiBlockSpec(block);
  if (!spec) throw new Error("invalid block");
  return spec;
}

const RECALL_CARD = specOf({
  type: "quick_replies",
  title: "Alternating series test: condition + remainder bound?",
  options: [
    { id: "know", label: "I know it" },
    { id: "show", label: "Show me" },
  ],
});

/**
 * The real chat runtime on a real database, and the real registry. The routine side does what
 * `RoutineScheduler` does for a run status change: one conversation transaction that adds the run
 * event to the chat.
 */
async function setUp() {
  const root = await mkdtemp(join(tmpdir(), "openbot-card-routine-"));
  roots.push(root);
  const database = new OpenBotDatabase(root);
  databases.push(database);
  await runCauseEffect(database.initialize());
  const agent = agentSummary();
  database.replaceAgents("seed-card-routine", [agent], "agents.imported");
  const store = new OneAgentStore(root, database, agent);
  const conversation = new ConversationRuntime(
    store,
    () => {},
    () => [agent],
  );
  conversation.bindThread(ROUTINE_SESSION, AGENT_ID, THREAD_ID);

  // The run, as `RoutineScheduler.markNeedsAttention` and `markRunningForTurn` change it.
  let runStatus: "running" | "needs-attention" = "running";
  const transition = (status: typeof runStatus) => {
    runStatus = status;
    conversation.withConversationTransaction(AGENT_ID, ({ threadId, snapshot }) => {
      const message: ConversationMessage = {
        id: randomUUID(),
        author: "system",
        source: "system",
        text: "Formula recall",
        createdAt: new Date().toISOString(),
        status: "completed",
        itemType: `routine-run-event:${status}:routine-1:run-1`,
      };
      snapshot.messages.push(message);
      snapshot.revision = database.appendConversationMessage({
        agentId: AGENT_ID,
        threadId,
        activeTurnId: snapshot.activeTurnId,
        message,
        eventType: `routine.run-${status}`,
      });
      return { result: undefined, snapshot };
    });
  };
  const errors: string[] = [];
  const registry = new AttentionRegistry({
    conversation,
    browser: {
      listTabs: () => [],
      toolCanUseTab: () => false,
      beginTakeover: () => Effect.void,
      endTakeover: () => {},
    },
    hostedSites: { prepareApproval: () => Effect.succeed(null), resolveApproval: () => Effect.void },
    routines: {
      markNeedsAttention: (turnId) => {
        if (turnId === ROUTINE_TURN && runStatus === "running") transition("needs-attention");
      },
      markRunningForTurn: (turnId) => {
        if (turnId === ROUTINE_TURN && runStatus === "needs-attention") transition("running");
      },
    },
    emit: () => {},
    emitError: (code) => {
      errors.push(code);
    },
    emitRuntimeSnapshot: () => {},
  });

  // The routine run's turn starts in the agent's own chat.
  const started = conversation.ensureSnapshot(AGENT_ID, THREAD_ID);
  started.activeTurnId = ROUTINE_TURN;
  started.messages.push({
    id: ROUTINE_TURN,
    turnId: ROUTINE_TURN,
    author: "user",
    source: "routine",
    text: "Formula recall drill",
    createdAt: new Date().toISOString(),
    status: "completed",
  });
  conversation.emitConversation(started, "turn.started");

  const client = new RecordingClient("/nonexistent/codex");
  let nextRequest = 1;
  /** Shows a card as the `ask_ui` router does, in the routine session. */
  const ask = (spec: UiBlockSpec, extra: { apiKey?: { name: string } } = {}) => {
    const id = nextRequest++;
    registry.surfaceUiBlock(
      client,
      { id, method: "item/tool/call", params: { threadId: ROUTINE_SESSION, turnId: ROUTINE_TURN } },
      { blockId: `block-${id}`, spec, ...extra },
    );
    return { id, messageId: `question-prompt:${ROUTINE_TURN}:${id}` };
  };
  /** The card as SQLite holds it now: what the chat shows after a restart. */
  const stored = (messageId: string) =>
    database
      .readConversationPage(AGENT_ID, THREAD_ID, { type: "latest" }, 100)
      .messages.find((message) => message.id === messageId);
  return { conversation, registry, client, ask, stored, errors, runStatus: () => runStatus };
}

describe("a user message closes the card of a routine run", () => {
  it("stores the card closed after the queued message path (agent-service sendMessage)", async () => {
    const { conversation, registry, client, ask, stored, errors, runStatus } = await setUp();
    const card = ask(RECALL_CARD);
    expect(runStatus()).toBe("needs-attention");
    expect(stored(card.messageId)?.uiBlock?.state.status).toBe("pending");

    // What `AgentService.sendMessage` does: it holds the chat, releases the waiting turn, then writes the chat.
    const snapshot = conversation.ensureSnapshot(AGENT_ID, THREAD_ID);
    const waitingTurnId = snapshot.activeTurnId;
    expect(waitingTurnId).toBe(ROUTINE_TURN);
    registry.releaseForUserMessage(AGENT_ID, THREAD_ID, ROUTINE_TURN);
    conversation.emitConversation(snapshot);

    expect(runStatus()).toBe("running");
    expect(client.answers.has(card.id)).toBe(true);
    const message = stored(card.messageId);
    expect(message?.questionPrompt?.resolution).toEqual({ status: "cancelled" });
    expect(message?.uiBlock?.state.status).toBe("closed");
    // The chat in memory agrees, so the next turn's write does not put the card back.
    const live = conversation.ensureSnapshot(AGENT_ID, THREAD_ID).messages.find((m) => m.id === card.messageId);
    expect(live?.uiBlock?.state.status).toBe("closed");
    expect(errors).toEqual([]);
  });

  it("stores the card closed after the steered message path (queue-controls)", async () => {
    const { conversation, registry, client, ask, stored, runStatus } = await setUp();
    const card = ask(RECALL_CARD);

    // What `QueueControls` does on a steer: it holds the chat, calls the hook, then writes the chat.
    const snapshot = conversation.ensureSnapshot(AGENT_ID, THREAD_ID);
    registry.skipUiBlocksForUserMessage(AGENT_ID, ROUTINE_TURN);
    conversation.emitConversation(snapshot, "queue.message-steered");

    expect(runStatus()).toBe("running");
    expect(client.answers.has(card.id)).toBe(true);
    const message = stored(card.messageId);
    expect(message?.questionPrompt?.resolution).toEqual({ status: "cancelled" });
    expect(message?.uiBlock?.state.status).toBe("closed");
  });

  it("closes a stored card that no live request holds, and leaves live cards and other questions open", async () => {
    const { conversation, registry, ask, stored } = await setUp();
    const live = ask(RECALL_CARD);
    // Cards of an older turn that the chat still shows as waiting, with no live request: as after a lost close.
    const orphan = (id: string, spec: UiBlockSpec | null): ConversationMessage => {
      const uiBlock = spec
        ? normalizeConversationUiBlock({ version: UI_BLOCK_VERSION, blockId: id, spec, state: { status: "pending" } })
        : null;
      if (spec && !uiBlock) throw new Error("invalid stored block");
      return {
        id: `question-prompt:old-turn:${id}`,
        turnId: "old-turn",
        author: "assistant",
        source: "assistant",
        text: "Question",
        createdAt: new Date().toISOString(),
        status: "completed",
        itemType: "question_prompt",
        questionPrompt: {
          requestId: id,
          questions: [{ id: "q", header: "Q", question: "Which?", isSecret: false, options: null }],
          resolution: null,
        },
        ...(uiBlock ? { uiBlock } : {}),
      };
    };
    const card = orphan("card", RECALL_CARD);
    const keyForm = orphan(
      "key-form",
      specOf({
        type: "form",
        title: "Paste your key",
        fields: [{ id: "key", kind: "text", label: "OPENAI_API_KEY", required: true, secret: true }],
      }),
    );
    // A question with no block can be an MCP elicitation: it stays.
    const question = orphan("question", null);
    const snapshot = conversation.ensureSnapshot(AGENT_ID, THREAD_ID);
    snapshot.messages.push(card, keyForm, question);
    conversation.emitConversation(snapshot);
    expect(stored(card.id)?.uiBlock?.state.status).toBe("pending");

    registry.closeStaleCardsForUserMessage(AGENT_ID, THREAD_ID);

    expect(stored(card.id)?.questionPrompt?.resolution).toEqual({ status: "cancelled" });
    expect(stored(card.id)?.uiBlock?.state.status).toBe("closed");
    expect(stored(keyForm.id)?.uiBlock?.state.status).toBe("pending");
    expect(stored(question.id)?.questionPrompt?.resolution).toBeNull();
    // The live card of the waiting turn is the release's to close, with an answer to the agent.
    expect(stored(live.messageId)?.uiBlock?.state.status).toBe("pending");
  });
});
