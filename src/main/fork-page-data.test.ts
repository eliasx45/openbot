// Fork (docs/fork/FEATURES.md #123): openbotPage.data: who may read, the call budget, and the caps.
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import {
  CHAT_VISUAL_DATA_TOO_MANY,
  CHAT_VISUAL_DATA_UNDECLARED,
  parseChatVisualMessage,
} from "@openbot/contracts/chat-visual";
import {
  PAGE_DATA_PARAMS_MAX,
  PAGE_DATA_SQL_MAX,
  type PageDataRequest,
  type PageStateTarget,
  pageDataOperation,
  parsePageDataRequest,
} from "@openbot/contracts/fork-saved-apps";
import { Effect } from "effect";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { AgentDatabaseHostMessage, AgentDatabaseHostProcess } from "../backend/agent-data/agent-database-protocol";
import { AgentDatabaseSupervisor } from "../backend/agent-data/agent-database-supervisor";
import { AgentTables } from "../backend/agent-data/agent-tables";
import {
  createPageData,
  PAGE_DATA_ANSWER_BYTES,
  PAGE_DATA_NO_PAGE,
  PAGE_DATA_NOT_LOCAL,
  type PageDataDependencies,
  type PageDataQueryResult,
  PageUsesStore,
  pageDataRows,
} from "./fork-page-data";
import { createSavedApps } from "./fork-saved-apps";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "openbot-page-data-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const LOCAL = "local";
const chatPage = (attachmentId: string, agentId = "agent-1", serverId = LOCAL): PageStateTarget => ({
  serverId,
  agentId,
  attachmentId,
  title: "Tasks",
});
const query = (
  target: PageStateTarget,
  sql = "SELECT 1",
  params: (string | number | null)[] = [],
): PageDataRequest => ({
  op: "query",
  sql,
  params,
  target,
});
const ROWS: PageDataQueryResult = { columns: ["id", "body"], rows: [[1, "first"]], truncated: false };

function world(extra: Partial<PageDataDependencies> = {}) {
  const dir = tempDir();
  const uses = new PageUsesStore(dir);
  // a1: declared data (agent-1); a2: made here, declared nothing; a3: declared data by agent-2.
  uses.record("a1", "agent-1", ["data"]);
  uses.record("a2", "agent-1", []);
  uses.record("a3", "agent-2", ["data", "state"]);
  const pages = new Map([
    ["a1", ["agent-1"]],
    ["a2", ["agent-1"]],
    ["a3", ["agent-2"]],
    ["a4", ["agent-1"]],
  ]);
  const html = (text: string) => new TextEncoder().encode(`<p>${text}</p>`);
  const savedApps = createSavedApps({
    dir,
    localServerId: LOCAL,
    localPageThread: (id) => (pages.has(id) ? { agentIds: pages.get(id) ?? [], threadId: "t1" } : null),
    readLocalPage: async (id) =>
      pages.has(id) ? { agentIds: pages.get(id) ?? [], threadId: "t1", html: html(id) } : null,
    readRemotePage: async (_server, id) => html(`remote ${id}`),
    agentName: () => null,
    pageUses: (id, agent) => uses.uses(id, agent),
  });
  const queries: string[] = [];
  const data = createPageData({
    localServerId: LOCAL,
    uses,
    localPage: (id) => (pages.has(id) ? { agentIds: pages.get(id) ?? [] } : null),
    appUses: (id) => savedApps.appUses(id),
    query: async (sql) => {
      queries.push(sql);
      return { ok: true, value: ROWS };
    },
    tables: async () => ["tasks"],
    ...extra,
  });
  return { dir, uses, savedApps, data, queries };
}

describe("who may read data", () => {
  it("answers a page made here that declared data, and refuses every other page", async () => {
    const { data, queries } = world();
    expect(await data.handle("1", query(chatPage("a1")))).toEqual({
      ok: true,
      value: { columns: ["id", "body"], rows: [{ id: 1, body: "first" }], truncated: false },
    });
    expect(await data.handle("1", { op: "tables", target: chatPage("a1") })).toEqual({ ok: true, value: ["tasks"] });
    // Made here, declared nothing.
    expect(await data.handle("1", query(chatPage("a2")))).toEqual({ ok: false, error: CHAT_VISUAL_DATA_UNDECLARED });
    // In the chat, but no html_render call here declared anything for it (another person's page in a channel).
    expect(await data.handle("1", query(chatPage("a4")))).toEqual({ ok: false, error: CHAT_VISUAL_DATA_UNDECLARED });
    // Declared by another agent: the host cannot borrow it by naming a different agent.
    expect(await data.handle("1", query(chatPage("a3", "agent-1")))).toEqual({ ok: false, error: PAGE_DATA_NO_PAGE });
    expect(await data.handle("1", query(chatPage("a1", "agent-2")))).toEqual({ ok: false, error: PAGE_DATA_NO_PAGE });
    // A joined server's page, even with the same attachment id.
    expect(await data.handle("1", query(chatPage("a1", "agent-1", "srv_1")))).toEqual({
      ok: false,
      error: PAGE_DATA_NOT_LOCAL,
    });
    // Not in the chat.
    expect(await data.handle("1", query(chatPage("gone")))).toEqual({ ok: false, error: PAGE_DATA_NO_PAGE });
    expect(queries).toEqual(["SELECT 1"]);
  });

  it("lets a saved app read with the declaration of the version it shows", async () => {
    const { data, savedApps } = world();
    const declared = await savedApps.save({
      serverId: LOCAL,
      agentId: "agent-1",
      messageId: "m1",
      attachmentId: "a1",
      title: "Tasks",
    });
    const app = { appId: declared.app.id };
    expect(await data.handle("1", query(app))).toMatchObject({ ok: true });
    // A newer version without the declaration: the app follows it and loses data.
    await savedApps.pageAdded({
      agentId: "agent-1",
      threadId: "t1",
      messageId: "m2",
      attachmentId: "a2",
      title: "Tasks",
    });
    expect(savedApps.get(declared.app.id)?.rev).toBe(2);
    expect(await data.handle("1", query(app))).toEqual({ ok: false, error: CHAT_VISUAL_DATA_UNDECLARED });
    // Pinned back to the declared version: data again.
    savedApps.pin(declared.app.id, 1);
    expect(await data.handle("1", query(app))).toMatchObject({ ok: true });
    // An app saved from a page made nowhere here, and an app that is gone.
    const remote = await savedApps.save({
      serverId: "srv_1",
      agentId: "agent-1",
      messageId: "m9",
      attachmentId: "a1",
      title: "Remote",
    });
    expect(await data.handle("1", query({ appId: remote.app.id }))).toEqual({ ok: false, error: PAGE_DATA_NOT_LOCAL });
    expect(await data.handle("1", query({ appId: "app_AAAAAAAAAAAAAAAA" }))).toEqual({
      ok: false,
      error: "This app is not here any more.",
    });
  });

  it("keeps declarations on disk, only declared ones, the newest ones", () => {
    const { dir } = world();
    const again = new PageUsesStore(dir);
    expect(again.uses("a1", "agent-1")).toEqual(["data"]);
    expect(again.uses("a2", "agent-1")).toEqual([]);
    expect(again.uses("a3", "agent-2")).toEqual(["data", "state"]);
    const file = JSON.parse(readFileSync(join(dir, "page-uses.json"), "utf8"));
    expect(Object.keys(file.pages).sort()).toEqual(["a1", "a3"]);
    const few = new PageUsesStore(dir, 3);
    for (let n = 0; n < 3; n += 1) few.record(`b${n}`, "agent-1", ["data"], n);
    const kept = new PageUsesStore(dir);
    expect(kept.uses("a1", "agent-1")).toEqual([]);
    expect(kept.uses("a3", "agent-2")).toEqual([]);
    expect(kept.uses("b0", "agent-1")).toEqual(["data"]);
    expect(kept.uses("b2", "agent-1")).toEqual(["data"]);
  });
});

describe("the call budget", () => {
  it("answers 10 calls in 10 seconds per window and page, then refuses until time passes", async () => {
    let now = 1_000_000;
    const { data } = world({ now: () => now });
    for (let n = 0; n < 10; n += 1) expect(await data.handle("1", query(chatPage("a1")))).toMatchObject({ ok: true });
    expect(await data.handle("1", query(chatPage("a1")))).toEqual({ ok: false, error: CHAT_VISUAL_DATA_TOO_MANY });
    // Another window has its own budget.
    expect(await data.handle("2", query(chatPage("a1")))).toMatchObject({ ok: true });
    now += 10_000;
    expect(await data.handle("1", query(chatPage("a1")))).toMatchObject({ ok: true });
  });
});

describe("what a page may send and get back", () => {
  it("parses only one SELECT text and plain parameters", () => {
    expect(pageDataOperation({ op: "query", sql: "SELECT ?", params: [1, "x", null, true] })).toEqual({
      op: "query",
      sql: "SELECT ?",
      params: [1, "x", null, 1],
    });
    expect(pageDataOperation({ op: "query", sql: "SELECT 1" })).toEqual({ op: "query", sql: "SELECT 1", params: [] });
    expect(pageDataOperation({ op: "query", sql: " " })).toBeNull();
    expect(pageDataOperation({ op: "query", sql: "x".repeat(PAGE_DATA_SQL_MAX + 1) })).toBeNull();
    expect(pageDataOperation({ op: "query", sql: "SELECT 1", params: [{}] })).toBeNull();
    expect(pageDataOperation({ op: "query", sql: "SELECT 1", params: { a: 1 } })).toBeNull();
    expect(pageDataOperation({ op: "query", sql: "SELECT 1", params: Array(PAGE_DATA_PARAMS_MAX + 1).fill(1) })).toBe(
      null,
    );
    expect(pageDataOperation({ op: "drop" })).toBeNull();
    expect(() => parsePageDataRequest({ op: "tables", target: { appId: "../x" } })).toThrow();
    expect(
      parseChatVisualMessage({ jsonrpc: "2.0", id: 4, method: "openbot/page-data", params: { op: "tables" } }),
    ).toEqual({ type: "data", id: 4, request: { op: "tables" } });
  });

  it("names repeated columns apart and caps an answer at 1 MB of JSON", async () => {
    expect(pageDataRows({ columns: ["a", "a", "b"], rows: [[1, 2, { blobBytes: 3 }]], truncated: false })).toEqual({
      columns: ["a", "a_2", "b"],
      rows: [{ a: 1, a_2: 2, b: { blobBytes: 3 } }],
    });
    const cell = "x".repeat(2_000);
    const big: PageDataQueryResult = {
      columns: ["body"],
      rows: Array.from({ length: 1_000 }, () => [cell]),
      truncated: false,
    };
    const { data } = world({ query: async () => ({ ok: true, value: big }) });
    const reply = await data.handle("1", query(chatPage("a1")));
    if (!reply.ok || reply.value === null || typeof reply.value !== "object" || Array.isArray(reply.value))
      throw new Error("expected rows");
    const rows = reply.value.rows;
    expect(Array.isArray(rows) && rows.length < 1_000).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(rows))).toBeLessThanOrEqual(PAGE_DATA_ANSWER_BYTES);
    expect(reply.value.truncated).toBe(true);
    const failing = world({ query: async () => ({ ok: false, message: "Only one SELECT." }) }).data;
    expect(await failing.handle("1", query(chatPage("a1")))).toEqual({ ok: false, error: "Only one SELECT." });
  });
});

// The real shared tables: their read-only checks and limits hold for pages.
const HOST = resolve(import.meta.dirname, "../backend/agent-data/agent-database-host.ts");
const children: ChildProcess[] = [];
afterAll(() => {
  for (const child of children) child.kill("SIGKILL");
});

function stdioHost(): AgentDatabaseHostProcess {
  const child = spawn(
    process.platform === "win32" ? "node.exe" : "node",
    ["--disable-warning=ExperimentalWarning", HOST],
    {
      stdio: ["pipe", "pipe", "inherit"],
    },
  );
  children.push(child);
  const listeners: ((message: AgentDatabaseHostMessage) => void)[] = [];
  createInterface({ input: child.stdout }).on("line", (line) => {
    const message: AgentDatabaseHostMessage = JSON.parse(line);
    for (const listener of listeners) listener(message);
  });
  return {
    send: (request) => child.stdin.write(`${JSON.stringify(request)}\n`),
    onMessage: (listener) => listeners.push(listener),
    onExit: (listener) => child.once("exit", (code) => listener(code)),
    kill: () => child.kill("SIGKILL"),
  };
}

describe("reading the shared tables", () => {
  it("reads rows, refuses writes and more than one statement, and stops at 500 rows", async () => {
    const sharedRoot = tempDir();
    mkdirSync(join(sharedRoot, "Data"), { recursive: true });
    const file = new DatabaseSync(join(sharedRoot, "Data", "agent-data.db"));
    file.exec("CREATE TABLE tasks (id INTEGER PRIMARY KEY, title TEXT NOT NULL)");
    file.exec("CREATE TABLE many (n INTEGER)");
    file.exec("INSERT INTO tasks (title) VALUES ('Buy milk'), ('Call Ana')");
    file.exec(
      "WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < 600) INSERT INTO many SELECT n FROM c",
    );
    file.close();
    const tables = new AgentTables({ sharedRoot, supervisor: new AgentDatabaseSupervisor({ spawnHost: stdioHost }) });
    try {
      const { data } = world({
        query: (sql, params) => Effect.runPromise(tables.query(sql, params)),
        tables: async () => (await Effect.runPromise(tables.listShared())).map((table) => table.name),
      });
      const page = chatPage("a1");
      expect(await data.handle("1", query(page, "SELECT title FROM tasks WHERE id > ? ORDER BY id", [0]))).toEqual({
        ok: true,
        value: { columns: ["title"], rows: [{ title: "Buy milk" }, { title: "Call Ana" }], truncated: false },
      });
      expect(await data.handle("1", { op: "tables", target: page })).toEqual({ ok: true, value: ["many", "tasks"] });
      const write = await data.handle("1", query(page, "DELETE FROM tasks"));
      expect(write.ok).toBe(false);
      const two = await data.handle("1", query(page, "SELECT 1; DELETE FROM tasks"));
      expect(two.ok).toBe(false);
      const many = await data.handle("2", query(page, "SELECT n FROM many"));
      expect(many).toMatchObject({ ok: true, value: { truncated: true } });
      if (many.ok && many.value && typeof many.value === "object" && !Array.isArray(many.value))
        expect(Array.isArray(many.value.rows) ? many.value.rows.length : 0).toBe(500);
      const check = new DatabaseSync(join(sharedRoot, "Data", "agent-data.db"), { readOnly: true });
      expect(check.prepare("SELECT COUNT(*) AS n FROM tasks").get()?.n).toBe(2);
      check.close();
    } finally {
      tables.dispose();
    }
  });
});
