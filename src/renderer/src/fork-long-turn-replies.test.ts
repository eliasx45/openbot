// @vitest-environment node
// Fork (docs/fork/FEATURES.md, "Replies stay in a long turn"): an agent's earlier replies in a long
// running turn never leave the chat, at any step of a stream, a page read or a scroll back.

import type { AgentProviderRef } from "@openbot/contracts/agent-providers";
import { sortConversationMessages } from "@openbot/contracts/conversation-order";
import type { ConversationMessage, ConversationPage } from "@openbot/contracts/ipc";
import type { AgentMessage } from "@openbot/ui/data";
import { describe, expect, it } from "vitest";
import { placeTurnStepRows, toAgentMessages } from "./app-message-projection";
import {
  type ConversationPageMerge,
  mergeConversationPage,
  pageMeetsLoaded,
  pageRows,
  pageWindow,
  snapshotRows,
  windowedSnapshotMessages,
} from "./features/conversation/conversation-merge";
import { narrationRows, placeUpdatesAfterSteers } from "./features/conversation/narration-rows";

const PAGE_CAP = 100;
const PAGE_TARGET = 50;
const SNAPSHOT_LIMIT = 100;
const START = Date.parse("2026-11-23T09:45:00.000Z");

/** The item ids that each provider gives a turn's narration and its thinking. */
interface ProviderIds {
  provider: AgentProviderRef;
  reply: (turn: string, n: number) => string;
  thought: (turn: string, n: number) => string;
}
const ANTIGRAVITY: ProviderIds = {
  provider: "antigravity",
  reply: (t, n) => `${t}:assistant:${n}`,
  thought: (t, n) => `${t}:thought:${n}`,
};
const PROVIDERS: Record<string, ProviderIds> = {
  antigravity: ANTIGRAVITY,
  opencode: { provider: "opencode", reply: (t, n) => `${t}:assistant:${n}`, thought: (t, n) => `${t}:thought:${n}` },
  claude: { provider: "claude", reply: (t, n) => `${t}:narration:${n}`, thought: (t, n) => `${t}:reasoning:${n}` },
  codex: {
    provider: "codex",
    reply: (_t, n) => `msg_${(0xa000 + n).toString(16)}`,
    thought: (_t, n) => `rs_${(0xb000 + n).toString(16)}`,
  },
};

/** The host: the thread in its shown order, its pages and its snapshots, as the backend cuts them. */
class Host {
  messages: ConversationMessage[] = [];
  activeTurnId: string | null = null;
  revision = 1;
  #clock = START;

  at(): string {
    this.#clock += 7_000;
    return new Date(this.#clock).toISOString();
  }

  add(message: Omit<ConversationMessage, "createdAt"> & { createdAt?: string }): ConversationMessage {
    const full: ConversationMessage = { createdAt: this.at(), ...message };
    this.messages.push(full);
    this.revision += 1;
    return full;
  }

  update(id: string, patch: Partial<ConversationMessage>): void {
    const index = this.messages.findIndex((message) => message.id === id);
    const current = this.messages[index];
    if (!current) throw new Error(`No message ${id}`);
    this.messages[index] = { ...current, ...patch };
    this.revision += 1;
  }

  sorted(): ConversationMessage[] {
    return sortConversationMessages([...this.messages]);
  }

  /** `boundedConversationSnapshot`: every message of the running turn and the last 100 others. */
  snapshot() {
    const sorted = this.sorted();
    const active = new Set(sorted.filter((message) => message.turnId === this.activeTurnId));
    const completed = sorted.filter((message) => !active.has(message)).slice(-SNAPSHOT_LIMIT);
    const kept = new Set([...completed, ...active]);
    return {
      messages: sorted.filter((message) => kept.has(message)),
      revision: this.revision,
      activeTurnId: this.activeTurnId,
    };
  }

  /**
   * Which turn a page may cut after other groups. Upstream: none. The fork (#119, #121): a turn of more
   * than a page, and the open turn.
   */
  constructor(readonly cutRule: "upstream" | "fork" = "upstream") {}

  #cuts(group: string, sorted: readonly ConversationMessage[]): boolean {
    if (this.cutRule === "upstream") return false;
    if (group === this.activeTurnId) return true;
    return sorted.filter((message) => message.turnId === group).length > PAGE_CAP;
  }

  /** `readConversationPage` with `wholeGroups`: whole turns, and a part of one turn larger than a page. */
  page(before?: string): ConversationPage {
    const sorted = this.sorted();
    const end = before ? sorted.findIndex((message) => message.id === before) : sorted.length;
    const rows = sorted
      .slice(0, end)
      .reverse()
      .slice(0, PAGE_CAP + 1);
    const group = (message: ConversationMessage | undefined) => message?.turnId ?? `message:${message?.id}`;
    const taken: ConversationMessage[] = [];
    let start = 0;
    while (start < rows.length && taken.length < PAGE_TARGET) {
      let stop = start + 1;
      while (stop < rows.length && group(rows[stop]) === group(rows[start])) stop += 1;
      if (stop > PAGE_CAP) {
        if (taken.length === 0 || this.#cuts(group(rows[start]), sorted)) taken.push(...rows.slice(start, PAGE_CAP));
        break;
      }
      taken.push(...rows.slice(start, stop));
      start = stop;
    }
    const messages = taken.reverse();
    const first = messages[0];
    const hasOlder = first !== undefined && sorted.indexOf(first) > 0;
    return {
      agentId: "agent",
      threadId: "thread",
      activeTurnId: this.activeTurnId,
      revision: this.revision,
      messages,
      references: {},
      pageInfo: { hasOlder, olderCursor: hasOlder && first ? first.id : null },
    };
  }
}

/** The desktop chat store, with the same steps as `conversation-context.tsx`. */
class Client {
  messages: AgentMessage[] = [];
  page: ConversationPage["pageInfo"] | undefined;
  windowMode: "latest" | "around" | undefined;
  revision: number | undefined;

  applySnapshot(snapshot: ReturnType<Host["snapshot"]>): void {
    if (this.revision !== undefined && snapshot.revision < this.revision) return;
    const capped = snapshot.messages.length >= SNAPSHOT_LIMIT || this.page?.hasOlder === true;
    this.messages = snapshotRows(this.messages, toAgentMessages(snapshot.messages, "agent"), snapshot.messages, {
      mode: this.windowMode ?? "latest",
      capped,
      whole: !capped,
      activeTurnId: snapshot.activeTurnId,
    });
    this.revision = snapshot.revision;
  }

  applyPage(page: ConversationPage, requestedMerge: ConversationPageMerge, windowMode?: "latest" | "around"): void {
    if (this.revision !== undefined && page.revision < this.revision) return;
    const rows = pageRows(this.messages, toAgentMessages(page.messages, "agent"), page.messages);
    const { messages, keepsWindow, keepsOlder } = pageWindow(this.messages, rows, page, {
      requestedMerge,
      windowMode,
      loadedWindowMode: this.windowMode,
      loadedRevision: this.revision,
      trimmed: !this.page || (this.page.hasOlder && !this.page.olderCursor),
    });
    this.messages = messages;
    if (!keepsOlder) this.page = page.pageInfo;
    if (windowMode && !keepsWindow) this.windowMode = windowMode;
    if (requestedMerge !== "older") this.revision = page.revision;
  }

  loadOlder(host: Host): void {
    const cursor = this.page?.olderCursor;
    if (!cursor) return;
    const page = host.page(cursor);
    const rows = pageRows(this.messages, toAgentMessages(page.messages, "agent"), page.messages);
    this.messages = pageWindow(this.messages, rows, page, {
      requestedMerge: "older",
      windowMode: undefined,
      loadedWindowMode: this.windowMode,
      loadedRevision: this.revision,
      trimmed: false,
    }).messages;
    this.page = page.pageInfo;
  }
}

/** The rows that an agent chat in Natural shows, as `scroll-store.ts` lists them. */
function shownRows(messages: readonly AgentMessage[], provider: AgentProviderRef, activeTurnId: string | null) {
  const turns: AgentMessage[][] = [];
  const listed = messages.flatMap((message) => {
    if (message.kind !== "thinking") return [message];
    const rows = narrationRows(message, provider);
    turns.push(rows);
    return rows;
  });
  return placeUpdatesAfterSteers(listed, turns).filter(
    (row) => !(row.author === "agent" && row.streaming && row.kind === "text" && row.turnId === activeTurnId),
  );
}

/** Watches every step: a reply or a message that showed once shows at each later step. */
function watcher(provider: AgentProviderRef) {
  const seen = new Set<string>();
  return (client: Client, host: Host, step: string) => {
    const shown = new Set(shownRows(client.messages, provider, host.activeTurnId).map((row) => row.id));
    const missing = [...seen].filter((id) => !shown.has(id));
    expect(missing, `${step}: ${missing.length} earlier rows left the chat`).toEqual([]);
    for (const id of shown) seen.add(id);
    return shown;
  };
}

/**
 * The chat of 23 Nov 2026: small finished turns, then one turn that runs for hours. The user steers
 * into it; the agent answers each steer with commentary, as Antigravity does, and attaches files. A
 * teammate's queued reply comes last, so the latest page holds only that reply.
 */
function longTurnChat(ids: ProviderIds, cycles = 60, cutRule: Host["cutRule"] = "upstream") {
  const host = new Host(cutRule);
  for (let turn = 0; turn < 3; turn += 1) {
    const turnId = `done-${turn}`;
    host.add({ id: `done-${turn}-ask`, turnId, author: "user", text: `Question ${turn}`, status: "completed" });
    host.add({
      id: ids.thought(turnId, 1),
      turnId,
      author: "assistant",
      text: "Thinking it over",
      status: "completed",
      itemType: "commentary",
    });
    host.add({
      id: `done-${turn}-answer`,
      turnId,
      author: "assistant",
      text: `Answer ${turn}`,
      status: "completed",
      itemType: "final_answer",
    });
  }
  const turnId = "long-turn";
  host.activeTurnId = turnId;
  host.add({ id: "long-ask", turnId, author: "user", text: "Build the depth demos", status: "completed" });
  let n = 0;
  const next = () => {
    n += 1;
    return n;
  };
  for (let cycle = 0; cycle < cycles; cycle += 1) {
    host.add({
      id: ids.thought(turnId, next()),
      turnId,
      author: "assistant",
      text: `Checking step ${cycle}`,
      status: "completed",
      itemType: "commentary",
    });
    host.add({
      id: ids.reply(turnId, next()),
      turnId,
      author: "assistant",
      text: `Reply ${cycle}: here is what I found`,
      status: "completed",
      itemType: "commentary",
    });
    if (cycle % 2 === 1)
      host.add({
        id: `steer-${cycle}`,
        turnId,
        author: "user",
        text: `Steer ${cycle}`,
        status: "completed",
        steered: true,
      });
    if (cycle % 5 === 4)
      host.add({
        id: `files-${cycle}`,
        turnId,
        author: "assistant",
        text: "",
        status: "completed",
        itemType: "agent_attachment",
        attachments: [
          {
            id: `file-${cycle}`,
            name: "demo.mp4",
            size: 1,
            kind: "file",
            mimeType: "video/mp4",
            previewKind: "none",
            previewUrl: null,
          },
        ],
      });
  }
  host.add({
    id: "explorer-reply",
    author: "agent",
    text: "Status: done",
    status: "completed",
    senderAgentId: "explorer",
    delivery: { id: "explorer-reply", status: "queued", position: 1 },
    exchange: {
      direction: "incoming",
      messageId: "exchange-1",
      senderAgentId: "explorer",
      recipientAgentIds: ["agent"],
      replyToMessageId: null,
      deliveries: [],
      expectsReply: false,
    },
  });
  return { host, turnId, next };
}

describe("replies in a long running turn", () => {
  for (const [name, ids] of Object.entries(PROVIDERS))
    for (const cutRule of ["upstream", "fork"] as const) {
      it(`${name}, ${cutRule} pages: no earlier reply leaves the chat while a reply streams, a page loads or the chat scrolls back`, () => {
        const { host, turnId, next } = longTurnChat(ids, 60, cutRule);
        const opening = host.page().messages.map((message) => message.id);
        if (cutRule === "upstream") expect(opening).toEqual(["explorer-reply"]);
        else expect([opening.length, opening.at(-1)]).toEqual([100, "explorer-reply"]);
        const client = new Client();
        const check = watcher(ids.provider);
        // Open: the latest page, then the snapshot that the host sends with each change.
        client.applyPage(host.page(), "replace", "latest");
        client.applySnapshot(host.snapshot());
        const opened = check(client, host, "open");
        expect(opened.has(ids.reply(turnId, 2))).toBe(true);

        // A new step and a new reply stream in. The provider sends the reply as the answer at first.
        const thought = ids.thought(turnId, next());
        host.add({
          id: thought,
          turnId,
          author: "assistant",
          text: "Looking at the frames",
          status: "streaming",
          itemType: "commentary",
        });
        client.applySnapshot(host.snapshot());
        check(client, host, "step streams");
        host.update(thought, { status: "completed" });
        const reply = ids.reply(turnId, next());
        host.add({
          id: reply,
          turnId,
          author: "assistant",
          text: "### 1. Hook 3",
          status: "streaming",
          itemType: "final_answer",
        });
        client.applySnapshot(host.snapshot());
        check(client, host, "reply streams as the answer");

        // The agent's state changes: the chat reads the latest page again.
        client.applyPage(host.page(), "replace", "latest");
        check(client, host, "latest page while the reply streams");

        // The reply ends, and the next step makes it commentary.
        host.update(reply, { status: "completed", itemType: "commentary" });
        host.add({
          id: ids.thought(turnId, next()),
          turnId,
          author: "assistant",
          text: "Next",
          status: "completed",
          itemType: "commentary",
        });
        client.applySnapshot(host.snapshot());
        expect(check(client, host, "reply becomes commentary").has(reply)).toBe(true);

        // The user scrolls back through the turn and older chats, page by page.
        for (let page = 0; page < 6 && client.page?.olderCursor; page += 1) {
          client.loadOlder(host);
          check(client, host, `older page ${page + 1}`);
          client.applySnapshot(host.snapshot());
          check(client, host, `snapshot after older page ${page + 1}`);
        }
        expect(check(client, host, "scrolled back").has("done-0-answer")).toBe(true);

        // A steer while the turn runs, and another state change.
        host.add({
          id: "steer-late",
          turnId,
          author: "user",
          text: "Also save both",
          status: "completed",
          steered: true,
        });
        client.applySnapshot(host.snapshot());
        client.applyPage(host.page(), "replace", "latest");
        check(client, host, "steer and latest page");

        // A joined server sends the latest page as an event, merged at the end.
        client.applyPage(host.page(), "latest", "latest");
        check(client, host, "conversation-page event");

        // The turn ends with an answer.
        host.add({
          id: "long-answer",
          turnId,
          author: "assistant",
          text: "All done",
          status: "completed",
          itemType: "final_answer",
        });
        host.activeTurnId = null;
        client.applySnapshot(host.snapshot());
        client.applyPage(host.page(), "replace", "latest");
        expect(check(client, host, "turn ends").has("long-answer")).toBe(true);
      });

      it(`${name}, ${cutRule} pages: the steps row keeps the replies of the turn that a page or snapshot does not reach`, () => {
        const { host, turnId } = longTurnChat(ids, 60, cutRule);
        const client = new Client();
        client.applyPage(host.page(), "replace", "latest");
        client.applySnapshot(host.snapshot());
        const all = client.messages.find((message) => message.kind === "thinking" && message.turnId === turnId);
        // An older page that holds the last 100 rows of the turn.
        client.loadOlder(host);
        const steps = client.messages.find((message) => message.kind === "thinking" && message.turnId === turnId);
        expect(steps?.itemIds).toEqual(all?.itemIds);
        // The rows keep the shown order, and the steps row stays where the turn's first step is.
        const shown = shownRows(client.messages, ids.provider, host.activeTurnId).map((row) => row.id);
        const whole = shownRows(toAgentMessages(host.sorted(), "agent"), ids.provider, host.activeTurnId)
          .map((row) => row.id)
          .filter((id) => shown.includes(id));
        expect(shown).toEqual(whole);
      });

      it(`${name}, ${cutRule} pages: a chat that opens on the latest page and scrolls back keeps every reply in order`, () => {
        // The chat of a dev instance with the seeded thread: no snapshot comes, only pages.
        const { host } = longTurnChat(ids, 60, cutRule);
        host.activeTurnId = null;
        const client = new Client();
        const check = watcher(ids.provider);
        client.applyPage(host.page(), "replace", "latest");
        check(client, host, "open");
        const whole = shownRows(toAgentMessages(host.sorted(), "agent"), ids.provider, null).map((row) => row.id);
        for (let page = 1; client.page?.olderCursor; page += 1) {
          client.loadOlder(host);
          const shown = shownRows(client.messages, ids.provider, null).map((row) => row.id);
          check(client, host, `older page ${page}`);
          expect(shown, `older page ${page}`).toEqual(whole.filter((id) => shown.includes(id)));
        }
        expect(shownRows(client.messages, ids.provider, null).map((row) => row.id)).toEqual(whole);
        // Opening the chat again reads the latest page again.
        client.applyPage(host.page(), "replace", "latest");
        expect(shownRows(client.messages, ids.provider, null).map((row) => row.id)).toEqual(whole);
      });
    }

  // Fork #121: an open turn of exactly one page with messages after it. Pages that stop before the turn
  // (#119 cut only a turn of more than 100 rows) leave the chat without the user's steers in it.
  it("shows the user's steers of an open turn of 100 rows when messages come after it", () => {
    const { host, turnId, next } = longTurnChat(ANTIGRAVITY, 37, "fork");
    host.add({ id: "health-note", author: "assistant", text: "Health check", status: "completed" });
    const turnRows = host.messages.filter((message) => message.turnId === turnId).length;
    expect(turnRows).toBe(100);
    const steers = host.messages.filter((message) => message.steered).map((message) => message.id);
    const client = new Client();
    const check = watcher(ANTIGRAVITY.provider);
    client.applyPage(host.page(), "replace", "latest");
    client.applySnapshot(host.snapshot());
    const opened = check(client, host, "open");
    expect(steers.filter((id) => !opened.has(id))).toEqual([]);
    // New rows arrive in the open turn: a step, a page read on the state change, a steer.
    host.add({
      id: ANTIGRAVITY.thought(turnId, next()),
      turnId,
      author: "assistant",
      text: "Rendering",
      status: "completed",
      itemType: "commentary",
    });
    client.applySnapshot(host.snapshot());
    client.applyPage(host.page(), "replace", "latest");
    check(client, host, "a step and a latest page");
    host.add({ id: "steer-new", turnId, author: "user", text: "And the poster", status: "completed", steered: true });
    client.applySnapshot(host.snapshot());
    client.applyPage(host.page(), "latest", "latest");
    expect(check(client, host, "a new steer").has("steer-new")).toBe(true);
  });

  it("keeps a finished turn as it was: steps folded above the answer, the same order", () => {
    const { host } = longTurnChat(ANTIGRAVITY, 3);
    host.activeTurnId = null;
    host.add({
      id: "answer",
      turnId: "long-turn",
      author: "assistant",
      text: "Done",
      status: "completed",
      itemType: "final_answer",
    });
    const snapshot = host.snapshot();
    const mapped = toAgentMessages(snapshot.messages, "agent");
    const client = new Client();
    client.applySnapshot(snapshot);
    expect(client.messages).toEqual(mapped);
    expect(placeTurnStepRows(mapped)).toBe(mapped);
    const steps = client.messages.filter((message) => message.kind === "thinking").map((message) => message.turnId);
    expect(steps).toEqual(["done-0", "done-1", "done-2", "long-turn"]);
  });

  it("keeps the order of every turn of a whole thread", () => {
    for (const ids of Object.values(PROVIDERS)) {
      const mapped = toAgentMessages(longTurnChat(ids).host.sorted(), "agent");
      expect(placeTurnStepRows(mapped)).toBe(mapped);
    }
  });

  it("starts a capped snapshot window with the whole turn of its first shared message", () => {
    const row = (id: string, turnId?: string) => ({ id, ...(turnId ? { turnId } : {}) });
    const loaded = [row("b", "t"), row("c", "t"), row("d")];
    const snapshot = [row("x"), row("thinking:t", "t"), row("a", "t"), row("b", "t"), row("c", "t"), row("d")];
    expect(windowedSnapshotMessages(loaded, snapshot, { mode: "latest", capped: true }).map((r) => r.id)).toEqual([
      "thinking:t",
      "a",
      "b",
      "c",
      "d",
    ]);
  });

  // Fork #121: a latest page with only the end of a turn (#119) shares the turn's steps row, which stands at
  // the turn's first step. The page joins at its first other shared row; the steers before it stay.
  it("joins a latest page that holds the end of a turn after the steers before it", () => {
    const row = (id: string, kind?: string) => ({ id, ...(kind ? { kind } : {}) });
    const loaded = [
      row("older"),
      row("ask"),
      row("thinking:t", "thinking"),
      row("steer-1"),
      row("steer-2"),
      row("steer-3"),
    ];
    const page = [row("thinking:t", "thinking"), row("steer-3"), row("note")];
    expect(mergeConversationPage(loaded, page, "latest").map((message) => message.id)).toEqual([
      "older",
      "ask",
      "steer-1",
      "steer-2",
      "thinking:t",
      "steer-3",
      "note",
    ]);
    // A page that shares only the steps row adds its rows after the loaded ones.
    expect(
      mergeConversationPage(loaded, [row("thinking:t", "thinking"), row("note")], "latest").map((m) => m.id),
    ).toEqual(["older", "ask", "steer-1", "steer-2", "steer-3", "thinking:t", "note"]);
  });

  it("joins a latest page that shows nothing, shares a row or is not newer than the chat", () => {
    const loaded = [{ id: "a", createdAt: "2026-11-23T10:00:00.000Z" }];
    const page = (id: string, createdAt: string, revision: number) => {
      const message: ConversationMessage = { id, createdAt, author: "user", text: "", status: "completed" };
      return { messages: [message], revision };
    };
    expect(pageMeetsLoaded(loaded, page("q", "2026-11-23T11:00:00.000Z", 9), [], 5)).toBe(true);
    expect(pageMeetsLoaded(loaded, page("a", "2026-11-23T10:00:00.000Z", 9), [{ id: "a" }], 5)).toBe(true);
    expect(pageMeetsLoaded(loaded, page("n", "2026-11-23T11:00:00.000Z", 5), [{ id: "n" }], 5)).toBe(true);
    // A page after a long time with no connection does not meet the chat: it replaces it, as before.
    expect(pageMeetsLoaded(loaded, page("n", "2026-11-23T11:00:00.000Z", 9), [{ id: "n" }], 5)).toBe(false);
    expect(pageMeetsLoaded([], page("n", "2026-11-23T11:00:00.000Z", 9), [{ id: "n" }], 5)).toBe(false);
  });
});
