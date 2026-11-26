// @vitest-environment node
// Fork (docs/fork/FEATURES.md, "Replies stay in a long turn"): what the host's pages hold after a turn
// of more than one page. The chat (src/renderer/src/fork-long-turn-replies.test.ts) must keep the turn's
// replies when a page holds only its end, or holds none of it.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSummary, ConversationMessage, ConversationPage } from "@openbot/contracts/ipc";
import { afterEach, describe, expect, it } from "vitest";
import { ORDER_KEY_COLUMNS, ORDERED_THREAD_MESSAGES } from "./database/conversation-queries";
import { runCauseEffect } from "./effect-boundary";
import { OpenBotDatabase } from "./openbot-database";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const agent: AgentSummary = {
  id: "vega",
  provider: "antigravity",
  name: "Vega",
  title: "",
  description: "",
  notifications: true,
  model: "gemini",
  reasoningEffort: "high",
  threadId: "openbot-thread-vega",
  workspacePath: "/tmp/openbot-vega",
  preview: "",
  updatedAt: "2026-11-23T09:00:00.000Z",
  avatarSeed: "vega",
  avatarHue: null,
  avatarUrl: null,
};

describe("pages of a long running turn", () => {
  it("hold the end of the turn, also with a message after it, and the user's steers in it", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-long-turn-"));
    roots.push(root);
    const database = new OpenBotDatabase(root);
    await runCauseEffect(database.initialize());
    database.replaceAgents("seed", [agent], "agents.imported");
    let clock = Date.parse("2026-11-23T09:45:00.000Z");
    const at = () => {
      clock += 5_000;
      return new Date(clock).toISOString();
    };
    const turnId = "long-turn";
    const messages: ConversationMessage[] = [
      { id: "ask", turnId, author: "user", text: "Build it", status: "completed", createdAt: at() },
    ];
    for (let n = 1; n <= 150; n += 1)
      messages.push(
        n % 10 === 0
          ? {
              id: `steer-${n}`,
              turnId,
              author: "user",
              text: "More",
              status: "completed",
              steered: true,
              createdAt: at(),
            }
          : {
              id: `${turnId}:assistant:${n}`,
              turnId,
              author: "assistant",
              text: `Reply ${n}`,
              status: "completed",
              itemType: "commentary",
              createdAt: at(),
            },
      );
    database.persistConversation(
      { agentId: agent.id, threadId: agent.threadId, activeTurnId: turnId, revision: 0, messages },
      "conversation.saved",
    );
    const end = database.readConversationPage(agent.id, agent.threadId, { type: "latest" }, 50);
    expect(end.messages).toHaveLength(100);
    expect(end.messages[0]?.id).toBe(`${turnId}:assistant:51`);
    expect(end.pageInfo.hasOlder).toBe(true);

    // A teammate's reply waits after the turn: the latest page holds only that reply.
    messages.push({
      id: "teammate-reply",
      author: "agent",
      text: "Status: done",
      status: "completed",
      createdAt: at(),
      delivery: { id: "teammate-reply", status: "queued", position: 1 },
    });
    database.persistConversation(
      { agentId: agent.id, threadId: agent.threadId, activeTurnId: turnId, revision: 0, messages },
      "conversation.saved",
    );
    const latest = database.readConversationPage(agent.id, agent.threadId, { type: "latest" }, 50);
    const latestIds = latest.messages.map((message) => message.id);
    expect(latestIds).toHaveLength(100);
    expect(latestIds.at(-1)).toBe("teammate-reply");
    expect(latestIds[0]).toBe(`${turnId}:assistant:52`);
    expect(latestIds.filter((id) => id.startsWith("steer-"))).toEqual(
      Array.from({ length: 10 }, (_, index) => `steer-${60 + index * 10}`),
    );
    expect(latest.pageInfo.hasOlder).toBe(true);

    // Fork #119: scrolling back reads the rest of the turn once, with the user's first message and early steers.
    const seen = new Set(latestIds);
    let cursor = latest.pageInfo.olderCursor;
    while (cursor) {
      const older = database.readConversationPage(agent.id, agent.threadId, { type: "before", cursor }, 50);
      for (const message of older.messages) {
        expect(seen.has(message.id)).toBe(false);
        seen.add(message.id);
      }
      cursor = older.pageInfo.hasOlder ? older.pageInfo.olderCursor : null;
    }
    expect(seen.size).toBe(messages.length);
    expect(seen.has("ask")).toBe(true);
    expect(seen.has("steer-10")).toBe(true);
    database.close();
  });

  it("keep a turn that fits one page whole instead of splitting it", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-long-turn-"));
    roots.push(root);
    const database = new OpenBotDatabase(root);
    await runCauseEffect(database.initialize());
    database.replaceAgents("seed", [agent], "agents.imported");
    let clock = Date.parse("2026-11-23T09:45:00.000Z");
    const at = () => {
      clock += 5_000;
      return new Date(clock).toISOString();
    };
    const messages: ConversationMessage[] = [];
    for (let turn = 1; turn <= 3; turn += 1) {
      const turnId = `turn-${turn}`;
      messages.push({ id: `${turnId}:ask`, turnId, author: "user", text: "Go", status: "completed", createdAt: at() });
      for (let n = 1; n <= 39; n += 1)
        messages.push({
          id: `${turnId}:assistant:${n}`,
          turnId,
          author: "assistant",
          text: `Reply ${n}`,
          status: "completed",
          itemType: "commentary",
          createdAt: at(),
        });
    }
    database.persistConversation(
      { agentId: agent.id, threadId: agent.threadId, activeTurnId: null, revision: 0, messages },
      "conversation.saved",
    );
    const latest = database.readConversationPage(agent.id, agent.threadId, { type: "latest" }, 50);
    expect(latest.messages).toHaveLength(80);
    expect(latest.messages[0]?.id).toBe("turn-2:ask");
    database.close();
  });

  // Fork #121: the open turn reaches the newest page also when it fits one page on its own (99 or 100
  // rows) but not after the rows that came after it. The chat shows the open turn's messages from its
  // live state only from the first loaded row of the turn, so a newest page of only the later rows hid
  // the user's steers in the turn, as in #119.
  for (const [turnRows, after] of [
    [100, 1],
    [99, 2],
    [100, 5],
  ] as const)
    it(`hold the open turn of ${turnRows} rows with ${after} later message(s) on the newest page`, async () => {
      const database = await openDatabase();
      const { messages, turnId } = steeredTurn(turnRows);
      for (let n = 0; n < after; n += 1)
        messages.push({
          id: `note-${n}`,
          author: "assistant",
          text: "Health check",
          status: "completed",
          createdAt: at(),
        });
      seed(database, messages, turnId);
      const latest = database.readConversationPage(agent.id, agent.threadId, { type: "latest" }, 50);
      const ids = latest.messages.map((message) => message.id);
      expect(ids).toHaveLength(100);
      expect(ids.slice(-after)).toEqual(Array.from({ length: after }, (_, n) => `note-${n}`));
      expect(ids.filter((id) => id.startsWith("steer-")).length).toBeGreaterThan(0);
      expect(ids).toContain(`steer-${turnRows - 1 - ((turnRows - 1) % 10)}`);
      expect(readBack(database, latest)).toEqual(shownOrder(database));

      // The same turn once it has ended keeps the whole-turn rule: the newest page stops before it.
      seed(database, messages, null);
      const ended = database.readConversationPage(agent.id, agent.threadId, { type: "latest" }, 50);
      expect(ended.messages.map((message) => message.id)).toEqual(ids.slice(-after));
      expect(readBack(database, ended)).toEqual(shownOrder(database));
      database.close();
    });

  it("read every row once, in order, back from the newest page and from any anchor, across oversized turns", async () => {
    const database = await openDatabase();
    // Finished turns of 101, 100, 1, 150 and 99 rows, two lone messages, a 250-row turn, then an open
    // 120-row turn with two messages after it.
    const messages: ConversationMessage[] = [];
    for (const [index, size] of [101, 100, 1, 150, 99].entries()) messages.push(...turnRowsOf(`done-${index}`, size));
    messages.push(lone("lone-a"), lone("lone-b"));
    messages.push(...turnRowsOf("big", 250));
    messages.push(...turnRowsOf("open", 120), lone("lone-c"), lone("lone-d"));
    seed(database, messages, "open");
    const order = shownOrder(database);
    expect(order).toHaveLength(messages.length);
    expect(readBack(database, database.readConversationPage(agent.id, agent.threadId, { type: "latest" }, 50))).toEqual(
      order,
    );
    for (let index = 0; index < order.length; index += 13) {
      const messageId = order[index] ?? "";
      const page = database.readConversationPage(agent.id, agent.threadId, { type: "around", messageId }, 50);
      const ids = page.messages.map((message) => message.id);
      expect(ids, messageId).toContain(messageId);
      expect(ids.length, messageId).toBeLessThanOrEqual(100);
      const start = order.indexOf(ids[0] ?? "");
      expect(ids, `${messageId}: one run of the shown order`).toEqual(order.slice(start, start + ids.length));
      expect(readBack(database, page), messageId).toEqual(order.slice(0, start + ids.length));
    }
    database.close();
  });

  it("count a turn's rows with the same marker filter as the page", async () => {
    const database = await openDatabase();
    // 100 shown rows and 3 routine notes in one finished turn: 103 rows, 100 without routine events.
    const messages = turnRowsOf("routine-turn", 100);
    for (let n = 0; n < 3; n += 1)
      messages.push({
        id: `routine-${n}`,
        turnId: "routine-turn",
        author: "assistant",
        text: "Routine ran",
        status: "completed",
        itemType: `routine-event:run-${n}`,
        createdAt: at(),
      });
    messages.push(lone("after"));
    seed(database, messages, null);
    const all = database.readConversationPage(agent.id, agent.threadId, { type: "latest" }, 50);
    expect(all.messages).toHaveLength(100);
    const filtered = database.readConversationPage(agent.id, agent.threadId, { type: "latest" }, 50, {
      excludeRoutineEvents: true,
    });
    expect(filtered.messages.map((message) => message.id)).toEqual(["after"]);
    const cursor = filtered.pageInfo.olderCursor ?? "";
    const older = database.readConversationPage(agent.id, agent.threadId, { type: "before", cursor }, 50, {
      excludeRoutineEvents: true,
    });
    expect(older.messages).toHaveLength(100);
    expect(older.messages.some((message) => /^routine-\d$/.test(message.id))).toBe(false);
    database.close();
  });
});

let clock = Date.parse("2026-11-23T09:45:00.000Z");
function at(): string {
  clock += 5_000;
  return new Date(clock).toISOString();
}

async function openDatabase(): Promise<OpenBotDatabase> {
  const root = await mkdtemp(join(tmpdir(), "openbot-long-turn-"));
  roots.push(root);
  const database = new OpenBotDatabase(root);
  await runCauseEffect(database.initialize());
  database.replaceAgents("seed", [agent], "agents.imported");
  return database;
}

function seed(database: OpenBotDatabase, messages: ConversationMessage[], activeTurnId: string | null): void {
  database.persistConversation(
    { agentId: agent.id, threadId: agent.threadId, activeTurnId, revision: 0, messages },
    "conversation.saved",
  );
}

/** A turn of `size` rows: the ask, commentary, and a steer every tenth row. */
function steeredTurn(size: number): { messages: ConversationMessage[]; turnId: string } {
  const turnId = `turn-${size}`;
  const messages: ConversationMessage[] = [
    { id: "ask", turnId, author: "user", text: "Build it", status: "completed", createdAt: at() },
  ];
  for (let n = 1; n < size; n += 1)
    messages.push(
      n % 10 === 0
        ? {
            id: `steer-${n}`,
            turnId,
            author: "user",
            text: "More",
            status: "completed",
            steered: true,
            createdAt: at(),
          }
        : {
            id: `${turnId}:assistant:${n}`,
            turnId,
            author: "assistant",
            text: `Reply ${n}`,
            status: "completed",
            itemType: "commentary",
            createdAt: at(),
          },
    );
  return { messages, turnId };
}

function turnRowsOf(turnId: string, size: number): ConversationMessage[] {
  return steeredTurn(size).messages.map((message) => ({ ...message, id: `${turnId}:${message.id}`, turnId }));
}

function lone(id: string): ConversationMessage {
  return { id, author: "assistant", text: "Note", status: "completed", createdAt: at() };
}

/** Every message id of the thread in the shown order. */
function shownOrder(database: OpenBotDatabase): string[] {
  return database.connection
    .prepare(`${ORDERED_THREAD_MESSAGES} SELECT message_id FROM ordered ORDER BY ${ORDER_KEY_COLUMNS}`)
    .all(agent.threadId)
    .map((row) => String(row.message_id));
}

/** The page and every older page after it, in the shown order; fails on a row read twice. */
function readBack(database: OpenBotDatabase, page: ConversationPage): string[] {
  const pages = [page.messages.map((message) => message.id)];
  let cursor = page.pageInfo.hasOlder ? page.pageInfo.olderCursor : null;
  while (cursor) {
    const older = database.readConversationPage(agent.id, agent.threadId, { type: "before", cursor }, 50);
    expect(older.messages.length).toBeGreaterThan(0);
    pages.unshift(older.messages.map((message) => message.id));
    cursor = older.pageInfo.hasOlder ? older.pageInfo.olderCursor : null;
  }
  const ids = pages.flat();
  expect(new Set(ids).size).toBe(ids.length);
  return ids;
}
