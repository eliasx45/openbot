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
  it("hold only the end of the turn, or only the queued message after it", async () => {
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
    expect(latest.messages.map((message) => message.id)).toEqual(["teammate-reply"]);
    expect(latest.pageInfo.hasOlder).toBe(true);
    database.close();
  });
});
