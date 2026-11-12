// Fork (docs/fork/FEATURES.md #76): where the WhatsApp "Message yourself" chat, with the watched chats'
// turns, shows in OpenBot. The placement decision, the stored default, and a guard on the real
// messaging threads and database: in "Main chat" mode a watched turn runs in the orchestrator's own chat,
// whose events reach the app. The whole path (fake WhatsApp, fake provider) is
// `bun scripts/fork-whatsapp-watch-main-chat-e2e.ts`.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_WHATSAPP_WATCH_PLACEMENT } from "@openbot/contracts/ipc";
import { Effect, Scope } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { runCauseEffect } from "./effect-boundary";
import { MailboxStore } from "./mailbox-store";
import { type MessagingPlacement, MessagingThreads, placementMove } from "./messaging/messaging-threads";
import { watchPlacementOf } from "./messaging/whatsapp/whatsapp-connect";
import {
  isSelfChat,
  selfChatPlacement,
  selfChatTitle,
  watchThreadTitle,
} from "./messaging/whatsapp/whatsapp-placement";
import { watchedTurnText } from "./messaging/whatsapp/whatsapp-watch-text";
import { OpenBotDatabase } from "./openbot-database";

const OWNER = "48600100200";
const SELF_CHAT = `${OWNER}@s.whatsapp.net`;
const ICHIRO = "819012345678";

describe("WhatsApp watch placement: the setting", () => {
  it("defaults to the main chat, also for a number that never chose", () => {
    expect(DEFAULT_WHATSAPP_WATCH_PLACEMENT).toBe("main");
    expect(watchPlacementOf(undefined)).toBe("main");
    expect(watchPlacementOf("bogus")).toBe("main");
    expect(watchPlacementOf("thread")).toBe("thread");
    expect(watchPlacementOf("phone")).toBe("phone");
  });

  it("applies to the self chat only; every other conversation keeps its own thread", () => {
    expect(isSelfChat("whatsapp", OWNER, SELF_CHAT)).toBe(true);
    expect(isSelfChat("whatsapp", OWNER, `${ICHIRO}@s.whatsapp.net`)).toBe(false);
    expect(isSelfChat("telegram", OWNER, SELF_CHAT)).toBe(false);
    expect(selfChatPlacement({ selfChat: false, placement: "main", watchedNames: [] })).toBeUndefined();
    expect(selfChatPlacement({ selfChat: true, placement: "main", watchedNames: ["Ichiro"] })).toEqual({
      kind: "main",
    });
    expect(selfChatPlacement({ selfChat: true, placement: "phone", watchedNames: [] })).toEqual({ kind: "phone" });
    expect(selfChatPlacement({ selfChat: true, placement: "thread", watchedNames: ["Ichiro"] })).toEqual({
      kind: "thread",
      title: "👁️ Ichiro",
    });
  });

  it('names the self chat "Message yourself", not its first watched sender', () => {
    expect(selfChatTitle()).toBe("Message yourself");
    expect(watchThreadTitle([])).toBe("👁️ Message yourself");
    expect(watchThreadTitle(["Ichiro", "Ana"])).toBe("👁️ Ichiro, Ana");
  });
});

describe("WhatsApp watch placement: the move", () => {
  const main: MessagingPlacement = { kind: "main" };
  const thread: MessagingPlacement = { kind: "thread", title: "👁️ Ichiro" };
  const phone: MessagingPlacement = { kind: "phone" };

  it("moves a conversation that waits for nothing", () => {
    expect(placementMove("phone", main, false)).toBe("main");
    expect(placementMove("phone", thread, false)).toBe("thread");
    expect(placementMove("main", phone, false)).toBe("phone");
    expect(placementMove("thread", main, false)).toBe("main");
    expect(placementMove("main", main, false)).toBe("stay");
    expect(placementMove("phone", phone, false)).toBe("stay");
    // An archived side thread opens again.
    expect(placementMove("thread", thread, false)).toBe("reopen");
  });

  it("never moves a conversation whose request waits or runs: its turn's end must find it", () => {
    for (const now of ["main", "thread", "phone"] as const)
      for (const placement of [main, thread, phone]) expect(placementMove(now, placement, true)).toBe("stay");
  });
});

// Guard: in "Main chat" mode a watched turn runs in the orchestrator's own chat, and its events are not
// kept out of the app. Fails when watched turns stop reaching the main chat.
describe("WhatsApp watch placement: guard on the real messaging threads", () => {
  const roots: string[] = [];
  afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  });

  async function setup() {
    const root = await mkdtemp(join(tmpdir(), "openbot-watch-placement-"));
    roots.push(root);
    const database = new OpenBotDatabase(root);
    await runCauseEffect(database.initialize());
    const mailbox = new MailboxStore(root, join(root, "shared"), database);
    await runCauseEffect(mailbox.initialize());
    const mainThreadId = "openbot-thread-main-desk";
    const now = new Date().toISOString();
    database.connection
      .prepare("INSERT INTO projection_threads VALUES (?, ?, ?, NULL, ?, ?, 0)")
      .run(mainThreadId, "agent-desk", "Desk", now, now);
    const sideThreads = new Set<string>();
    const threads = new MessagingThreads(database, mailbox, {
      schedule: () => {},
      queueChanged: () => {},
      busy: () => false,
      interrupt: () => Effect.void,
      forgetThread: () => Effect.void,
      ownChat: (threadId) => threadId === mainThreadId || sideThreads.has(threadId),
      contextSession: () => null,
      progressUpdates: () => null,
      placement: {
        mainThread: () => mainThreadId,
        isMainThread: (threadId) => threadId === mainThreadId,
        isSideThread: (threadId) => sideThreads.has(threadId),
        sideThread: (_agentId, threadId) => {
          if (!threadId) return null;
          sideThreads.add(threadId);
          return threadId;
        },
        keepThread: (_agentId, threadId) => {
          sideThreads.add(threadId);
        },
      },
    });
    const connection = threads.store.ensureConnection("whatsapp", OWNER, "Elias");
    return { database, threads, connection, mainThreadId, sideThreads };
  }

  function watched(connectionId: string, id: string, placement: MessagingPlacement) {
    return {
      connectionId,
      agentId: "agent-desk",
      platformChannelId: SELF_CHAT,
      threadKey: "dm",
      isDirect: true,
      title: "Ichiro Akiyama",
      text: watchedTurnText("Ichiro", [{ author: "Ichiro", text: "new review is up", sentAt: now() }]),
      sourcePaths: [],
      origin: { authorId: ICHIRO, authorName: "Ichiro", platformMessageId: `watch:${id}` },
      idempotencyKey: `messaging:${connectionId}:${id}`,
      placement,
    };
  }

  it('puts a watched turn in the orchestrator\'s own chat, named "Message yourself", and keeps its events in the app', async () => {
    const { threads, connection, mainThreadId, sideThreads } = await setup();
    const result = await runCauseEffect(
      threads.receive({ ...watched(connection.connectionId, "W1", { kind: "main" }), title: selfChatTitle() }),
    );
    expect(result.status).toBe("queued");
    if (result.status !== "queued") return;
    expect(result.link.threadId).toBe(mainThreadId);
    expect(result.link.title).toBe("Message yourself");
    expect(threads.threadForDelivery(result.deliveryId)).toBe(mainThreadId);
    // The hidden thread that the new link got first stays, claimed, so no restart adopts it.
    expect(sideThreads.size).toBe(1);
    // The turn's events reach the app (not taken), and its end still goes to WhatsApp.
    const scope = Effect.runSync(Scope.make());
    const finished: string[] = [];
    threads.onActivity((activity) => finished.push(activity.type));
    const started = threads.event(
      { type: "turn-started", agentId: "agent-desk", threadId: mainThreadId, turnId: "T1" },
      scope,
    );
    expect(started).toBe(false);
    expect(finished).toContain("started");
  });

  it('moves the conversation back to a hidden thread in "Phone only" mode, and not while its turn waits', async () => {
    const { threads, connection, mainThreadId } = await setup();
    const first = await runCauseEffect(threads.receive(watched(connection.connectionId, "W1", { kind: "main" })));
    expect(first.status === "queued" && first.link.threadId).toBe(mainThreadId);
    // W1 still waits, so W2 stays in the main chat.
    const second = await runCauseEffect(threads.receive(watched(connection.connectionId, "W2", { kind: "phone" })));
    expect(second.status === "queued" && second.link.threadId).toBe(mainThreadId);
  });
});

function now(): string {
  return new Date().toISOString();
}
