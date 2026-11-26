// @vitest-environment node
// Fork (docs/fork/FEATURES.md, "Replies stay in a long turn"): what the host's pages hold after a turn
// of more than one page. The chat (src/renderer/src/fork-long-turn-replies.test.ts) must keep the turn's
// replies when a page holds only its end, or holds none of it.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSummary, ConversationMessage } from "@openbot/contracts/ipc";
import { afterEach, describe, expect, it } from "vitest";
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
});
