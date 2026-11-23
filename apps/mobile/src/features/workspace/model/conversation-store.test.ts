// Fork (docs/fork/FEATURES.md, "Replies stay in a long turn"): a latest page that holds only a new
// message after a long turn joins the phone's loaded window, and the turn stays in the chat.
import type { ConversationMessage, ConversationPage } from "@openbot/contracts/ipc";
import { describe, expect, it } from "vitest";
import { MobileConversationStore } from "./conversation-store";

const reply = (n: number): ConversationMessage => ({
  id: `long-turn:assistant:${n}`,
  turnId: "long-turn",
  author: "assistant",
  text: `Reply ${n}`,
  status: "completed",
  itemType: "commentary",
  createdAt: new Date(Date.parse("2026-11-23T09:45:00.000Z") + n * 1000).toISOString(),
});

const page = (messages: ConversationMessage[], revision: number, olderCursor: string | null): ConversationPage => ({
  agentId: "vega",
  threadId: "thread",
  activeTurnId: "long-turn",
  revision,
  messages,
  references: {},
  pageInfo: { hasOlder: olderCursor !== null, olderCursor },
});

describe("phone chat after a long turn", () => {
  it("keeps the loaded turn when the latest page holds only a new message", async () => {
    const store = new MobileConversationStore(() => () => undefined);
    store.subscribe("vega", () => undefined);
    const turn = Array.from({ length: 100 }, (_, index) => reply(index + 51));
    await store.loadLatest(
      "vega",
      async () => page(turn, 1, "before-51"),
      () => true,
    );
    expect(store.get("vega")?.messages).toHaveLength(100);

    const queued: ConversationMessage = {
      id: "teammate-reply",
      author: "agent",
      text: "Status: done",
      status: "completed",
      createdAt: "2026-11-23T11:01:28.000Z",
      delivery: { id: "teammate-reply", status: "queued", position: 1 },
    };
    const reads: (string | undefined)[] = [];
    await store.loadLatest(
      "vega",
      async (cursor) => {
        reads.push(cursor);
        return cursor === "before-teammate" ? page(turn, 2, "before-51") : page([queued], 2, "before-teammate");
      },
      () => true,
      true,
    );
    expect(reads).toEqual([undefined, "before-teammate"]);
    const ids = store.get("vega")?.messages.map((message) => message.id) ?? [];
    expect(ids).toHaveLength(101);
    expect(ids[0]).toBe("long-turn:assistant:51");
    expect(ids.at(-1)).toBe("teammate-reply");
    expect(store.get("vega")?.pageInfo.olderCursor).toBe("before-51");
  });

  it("replaces a window that the older pages do not reach, so the chat shows no gap", async () => {
    const store = new MobileConversationStore(() => () => undefined);
    store.subscribe("vega", () => undefined);
    await store.loadLatest(
      "vega",
      async () => page([reply(1)], 1, null),
      () => true,
    );
    let reads = 0;
    await store.loadLatest(
      "vega",
      async (cursor) => {
        reads += 1;
        return page([reply(1000 + reads)], 2, cursor === undefined || reads < 10 ? `before-${reads}` : null);
      },
      () => true,
      true,
    );
    expect(reads).toBe(4);
    expect(store.get("vega")?.messages.map((message) => message.id)).not.toContain("long-turn:assistant:1");
  });
});
