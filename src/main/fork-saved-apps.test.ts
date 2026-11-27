// Fork (docs/fork/FEATURES.md #123): saved apps store, saved page data limits, deep links.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cleanSavedAppName,
  PAGE_STATE_KEYS_MAX,
  parsePageStateRequest,
  parseSavedAppLink,
  SAVED_APP_ID,
  SAVED_APP_VERSIONS,
  SAVED_APPS_MAX,
  savedAppLink,
} from "@openbot/contracts/fork-saved-apps";
import { afterEach, describe, expect, it } from "vitest";
import { parseDeepLink } from "./deep-link-router";
import {
  createSavedApps,
  PageStateStore,
  pageStateScope,
  readSavedAppWindowSize,
  SavedAppsFull,
  SavedAppsStore,
  writeSavedAppWindowSize,
} from "./fork-saved-apps";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "openbot-saved-apps-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const html = (text: string) => new TextEncoder().encode(`<p>${text}</p>`);
const page = { serverId: "local", agentId: "agent-1", threadId: "thread-1", title: "Counter" };
const version = (n: number, text = `v${n}`) => ({ messageId: `m${n}`, attachmentId: `a${n}`, html: html(text) });

describe("saved apps store", () => {
  it("saves a page with an id of the strict shape, a 0600 file and the page copy", () => {
    const dir = tempDir();
    const store = new SavedAppsStore(dir, { now: () => 1_000 });
    const { record, created } = store.save({ ...page, page: version(1) });
    expect(created).toBe(true);
    expect(record.id).toMatch(SAVED_APP_ID);
    expect(record.name).toBe("Counter");
    expect(record.versions).toEqual([
      expect.objectContaining({ rev: 1, messageId: "m1", attachmentId: "a1", at: 1_000 }),
    ]);
    expect(statSync(join(dir, "apps.json")).mode & 0o777).toBe(0o600);
    expect(new TextDecoder().decode(store.page(record.id) ?? undefined)).toBe("<p>v1</p>");
    expect(new SavedAppsStore(dir).list()).toEqual([record]);
  });

  it("returns the existing app when the same page is saved again, adding a new version only once", () => {
    const store = new SavedAppsStore(tempDir());
    const first = store.save({ ...page, page: version(1) }).record;
    const again = store.save({ ...page, page: version(1) });
    expect(again.created).toBe(false);
    expect(again.record.id).toBe(first.id);
    expect(again.record.versions).toHaveLength(1);
    const newer = store.save({ ...page, page: version(2) });
    expect(newer.created).toBe(false);
    expect(newer.record.versions.map((one) => one.rev)).toEqual([1, 2]);
    expect(store.list()).toHaveLength(1);
    expect(store.save({ ...page, title: "Other", page: version(3) }).created).toBe(true);
    expect(store.save({ ...page, threadId: "thread-2", page: version(4) }).created).toBe(true);
    expect(store.list()).toHaveLength(3);
  });

  it("follows the newest version, skipping a message it has and a page equal to the newest", () => {
    const store = new SavedAppsStore(tempDir());
    const { record } = store.save({ ...page, page: version(1) });
    store.addVersion(record.id, version(2));
    store.addVersion(record.id, version(2));
    store.addVersion(record.id, { ...version(3), html: html("v2") });
    const shown = store.addVersion(record.id, version(4));
    expect(shown?.versions.map((one) => one.rev)).toEqual([1, 2, 3]);
    expect(new TextDecoder().decode(store.page(record.id) ?? undefined)).toBe("<p>v4</p>");
    expect(new TextDecoder().decode(store.page(record.id, 1) ?? undefined)).toBe("<p>v1</p>");
    expect(store.page(record.id, 99)).toBeNull();
  });

  it("keeps the newest 20 versions and the pinned one, and removes page copies no one keeps", () => {
    const dir = tempDir();
    const store = new SavedAppsStore(dir);
    const { record } = store.save({ ...page, page: version(1) });
    store.addVersion(record.id, version(2));
    store.pin(record.id, 2);
    for (let n = 3; n <= 30; n += 1) store.addVersion(record.id, version(n));
    const kept = store.get(record.id);
    expect(kept?.versions).toHaveLength(SAVED_APP_VERSIONS);
    expect(kept?.versions[0]?.rev).toBe(2);
    expect(kept?.versions.at(-1)?.rev).toBe(30);
    expect(kept?.pinnedRev).toBe(2);
    expect(new TextDecoder().decode(store.page(record.id) ?? undefined)).toBe("<p>v2</p>");
    expect(readdirSync(join(dir, "pages"))).toHaveLength(SAVED_APP_VERSIONS);
    store.pin(record.id, null);
    store.addVersion(record.id, version(31));
    expect(store.get(record.id)?.versions[0]?.rev).toBe(12);
    expect(store.get(record.id)?.pinnedRev).toBeUndefined();
  });

  it("pins a kept version, refuses one it does not keep, and follows newest again", () => {
    const store = new SavedAppsStore(tempDir());
    const { record } = store.save({ ...page, page: version(1) });
    store.addVersion(record.id, version(2));
    expect(store.pin(record.id, 1)?.pinnedRev).toBe(1);
    expect(store.pin(record.id, 7)).toBeNull();
    expect(store.get(record.id)?.pinnedRev).toBe(1);
    store.addVersion(record.id, version(3));
    expect(new TextDecoder().decode(store.page(record.id) ?? undefined)).toBe("<p>v1</p>");
    expect(store.pin(record.id, null)?.pinnedRev).toBeUndefined();
    expect(new TextDecoder().decode(store.page(record.id) ?? undefined)).toBe("<p>v3</p>");
  });

  it("cleans a new name to one line of at most 80 characters and keeps the old name for an empty one", () => {
    const store = new SavedAppsStore(tempDir());
    const { record } = store.save({ ...page, page: version(1) });
    expect(store.rename(record.id, "  My\n\tcounter​ app  ")?.name).toBe("My counter app");
    expect(store.rename(record.id, "   \n ")?.name).toBe("My counter app");
    expect(store.rename(record.id, "x".repeat(200))?.name).toBe("x".repeat(80));
    expect(store.rename("app_AAAAAAAAAAAAAAAA", "Nope")).toBeNull();
    expect(cleanSavedAppName("a b")).toBe("a b");
  });

  it("removes an app and its page copies, and keeps the page data", () => {
    const dir = tempDir();
    const store = new SavedAppsStore(dir);
    const { record } = store.save({ ...page, page: version(1) });
    const state = new PageStateStore(dir);
    state.set(pageStateScope(record), "count", 3);
    expect(store.remove(record.id)).toBe(true);
    expect(store.remove(record.id)).toBe(false);
    expect(store.get(record.id)).toBeNull();
    expect(readdirSync(join(dir, "pages"))).toEqual([]);
    expect(new PageStateStore(dir).get(pageStateScope(page), "count")).toBe(3);
  });

  it("drops invalid rows on read and keeps the valid ones", () => {
    const dir = tempDir();
    const store = new SavedAppsStore(dir);
    const { record } = store.save({ ...page, page: version(1) });
    const file = JSON.parse(readFileSync(join(dir, "apps.json"), "utf8"));
    const doc = record.versions[0]?.doc;
    file.apps.push(
      { ...record, id: "la_wrongshape" },
      { ...record, id: "app_BBBBBBBBBBBBBBBB", versions: [] },
      { ...record, id: "app_CCCCCCCCCCCCCCCC", versions: [{ rev: 1, messageId: "m", attachmentId: "a", doc: "../x" }] },
      { ...record, id: "app_DDDDDDDDDDDDDDDD", agentId: 7 },
      record,
      "nonsense",
      {
        ...record,
        id: "app_EEEEEEEEEEEEEEEE",
        name: "\n",
        pinnedRev: 9,
        versions: [{ rev: 1, messageId: "m", attachmentId: "a", doc }],
      },
    );
    writeFileSync(join(dir, "apps.json"), JSON.stringify(file));
    const read = new SavedAppsStore(dir).list();
    expect(read.map((one) => one.id)).toEqual([record.id, "app_EEEEEEEEEEEEEEEE"]);
    expect(read[1]?.name).toBe("Counter");
    expect(read[1]?.pinnedRev).toBeUndefined();
    writeFileSync(join(dir, "apps.json"), "{not json");
    expect(new SavedAppsStore(dir).list()).toEqual([]);
    writeFileSync(join(dir, "apps.json"), JSON.stringify({ version: 2, apps: [record] }));
    expect(new SavedAppsStore(dir).list()).toEqual([]);
  });

  it("refuses a new app over 200 but still answers a saved page", () => {
    const dir = tempDir();
    const store = new SavedAppsStore(dir);
    for (let n = 0; n < SAVED_APPS_MAX; n += 1) store.save({ ...page, title: `Page ${n}`, page: version(1) });
    expect(() => store.save({ ...page, title: "One more", page: version(1) })).toThrow(SavedAppsFull);
    expect(store.save({ ...page, title: "Page 5", page: version(2) }).created).toBe(false);
    expect(readdirSync(join(dir, "pages"))).toHaveLength(2);
  });

  it("keeps each app window's size, and drops sizes of removed apps", () => {
    const dir = tempDir();
    writeSavedAppWindowSize(dir, "app_AAAAAAAAAAAAAAAA", { width: 900.4, height: 600 }, new Set());
    writeSavedAppWindowSize(dir, "app_BBBBBBBBBBBBBBBB", { width: 500, height: 400 }, new Set());
    expect(readSavedAppWindowSize(dir, "app_AAAAAAAAAAAAAAAA")).toBeNull();
    expect(readSavedAppWindowSize(dir, "app_BBBBBBBBBBBBBBBB")).toEqual({ width: 500, height: 400 });
    writeSavedAppWindowSize(
      dir,
      "app_AAAAAAAAAAAAAAAA",
      { width: 900.4, height: 600 },
      new Set(["app_BBBBBBBBBBBBBBBB"]),
    );
    expect(readSavedAppWindowSize(dir, "app_AAAAAAAAAAAAAAAA")).toEqual({ width: 900, height: 600 });
    expect(readSavedAppWindowSize(dir, "app_BBBBBBBBBBBBBBBB")).toEqual({ width: 500, height: 400 });
  });
});

describe("saved page data", () => {
  const scope = pageStateScope(page);

  it("gets, sets, lists and deletes JSON values, and keeps them across reads", () => {
    const dir = tempDir();
    const state = new PageStateStore(dir);
    expect(state.get(scope, "count")).toBeNull();
    state.set(scope, "count", 2);
    state.set(scope, "list", [{ done: true }]);
    expect(new PageStateStore(dir).get(scope, "count")).toBe(2);
    expect(new PageStateStore(dir).keys(scope)).toEqual(["count", "list"]);
    state.set(scope, "count", null);
    expect(new PageStateStore(dir).keys(scope)).toEqual(["list"]);
    expect(statSync(join(dir, "state", `${scope}.json`)).mode & 0o777).toBe(0o600);
    state.set(scope, "__proto__", { polluted: true });
    expect(new PageStateStore(dir).get(scope, "__proto__")).toEqual({ polluted: true });
    expect(new PageStateStore(dir).keys(scope)).toEqual(["list", "__proto__"]);
  });

  it("enforces the key, value, total and key-count limits", () => {
    const state = new PageStateStore(tempDir());
    expect(() => state.set(scope, "", 1)).toThrow("1 to 200");
    expect(() => state.set(scope, "k".repeat(201), 1)).toThrow("1 to 200");
    state.set(scope, "k".repeat(200), 1);
    expect(() => state.set(scope, "big", "x".repeat(64 * 1024))).toThrow("64 KB");
    state.set(scope, "fits", "x".repeat(64 * 1024 - 2));
    for (let n = 0; n < 3; n += 1) state.set(scope, `more-${n}`, "x".repeat(60 * 1024));
    expect(() => state.set(scope, "over", "x".repeat(60 * 1024))).toThrow("256 KB");
    const counted = new PageStateStore(tempDir());
    for (let n = 0; n < PAGE_STATE_KEYS_MAX; n += 1) counted.set(scope, `key-${n}`, n);
    expect(() => counted.set(scope, "one-more", 1)).toThrow("200 keys");
    counted.set(scope, "key-3", "changed");
    expect(counted.get(scope, "key-3")).toBe("changed");
  });

  it("answers the page through the app or the chat page of the same agent, thread and title", async () => {
    const dir = tempDir();
    const local: Record<string, { agentIds: string[]; threadId: string; html: Uint8Array } | undefined> = {
      a1: { agentIds: ["agent-1"], threadId: "thread-1", html: html("v1") },
      a2: { agentIds: ["agent-1"], threadId: "thread-1", html: html("v2") },
    };
    const changes: number[] = [];
    const apps = createSavedApps({
      dir,
      localServerId: "local",
      readLocalPage: async (id) => local[id] ?? null,
      localPageThread: (id) => local[id] ?? null,
      readRemotePage: async () => html("remote"),
      agentName: () => "Builder",
      changed: (list) => changes.push(list.length),
    });
    const target = { serverId: "local", agentId: "agent-1", attachmentId: "a1", title: "Counter" };
    expect(await apps.state({ op: "set", key: "count", value: 4, target })).toEqual({ ok: true, value: null });
    const saved = await apps.save({ ...target, messageId: "m1" });
    expect(saved.app).toMatchObject({ name: "Counter", agentName: "Builder", rev: 1, threadId: "thread-1" });
    expect(await apps.state({ op: "get", key: "count", target: { appId: saved.app.id } })).toEqual({
      ok: true,
      value: 4,
    });
    expect(await apps.state({ op: "keys", target: { ...target, attachmentId: "a2" } })).toEqual({
      ok: true,
      value: ["count"],
    });
    expect(await apps.state({ op: "get", key: "count", target: { ...target, agentId: "agent-2" } })).toEqual({
      ok: false,
      error: "This page cannot save data.",
    });
    expect(await apps.state({ op: "set", key: "big", value: "x".repeat(70_000), target })).toEqual({
      ok: false,
      error: "A saved value can be at most 64 KB.",
    });
    await apps.pageAdded({
      agentId: "agent-1",
      threadId: "thread-1",
      messageId: "m2",
      attachmentId: "a2",
      title: "Counter",
    });
    await apps.pageAdded({
      agentId: "agent-1",
      threadId: "thread-1",
      messageId: "m2",
      attachmentId: "a2",
      title: "Counter",
    });
    await apps.pageAdded({
      agentId: "agent-1",
      threadId: "thread-1",
      messageId: "m9",
      attachmentId: "a2",
      title: "Other",
    });
    expect(apps.get(saved.app.id)).toMatchObject({ rev: 2, messageId: "m2", versions: [{ rev: 1 }, { rev: 2 }] });
    expect(changes).toEqual([1, 1]);
    await expect(apps.save({ ...target, agentId: "agent-2", messageId: "m1" })).rejects.toThrow("not in the chat");
    const remote = await apps.save({ ...target, serverId: "server-2", messageId: "m1" });
    expect(remote.app.threadId).toBe("");
    expect(existsSync(join(dir, "state"))).toBe(true);
  });
});

describe("saved app links", () => {
  const id = "app_Abc-_012345678xy";

  it("parses openbot://app/<id> and ?window=1", () => {
    expect(parseSavedAppLink(`openbot://app/${id}`)).toEqual({ id, window: false });
    expect(parseSavedAppLink(`openbot://app/${id}/`)).toEqual({ id, window: false });
    expect(parseSavedAppLink(`openbot://app/${id}?window=1`)).toEqual({ id, window: true });
    expect(parseSavedAppLink(`  OPENBOT://APP/${id}?window=1 `)).toEqual({ id, window: true });
    expect(savedAppLink(id, true)).toBe(`openbot://app/${id}?window=1`);
    expect(parseDeepLink(`openbot://app/${id}?window=1`)).toEqual({ kind: "app", id, window: true });
  });

  it("rejects other shapes", () => {
    for (const link of [
      "openbot://app/",
      "openbot://app/la_Abc-_012345678xy",
      `openbot://app/${id}x`,
      `openbot://app/${id}?window=2`,
      `openbot://app/${id}?window=1&x=1`,
      `openbot://app/${id}#frag`,
      `openbot://app/${id}/more`,
      `openbot://app/${id.slice(0, 10)}%2e%2e`,
      `openbot://app/../${id}`,
      `https://app/${id}`,
      `openbot://apps/${id}`,
      `openbot://app/${id}?${"x".repeat(300)}`,
    ]) {
      expect(parseSavedAppLink(link), link).toBeNull();
      expect(parseDeepLink(link)?.kind, link).not.toBe("app");
    }
    expect(parseSavedAppLink(42)).toBeNull();
    expect(() => savedAppLink("../etc")).toThrow();
  });

  it("parses a page's saved data request from the renderer strictly", () => {
    const target = { appId: id };
    expect(parsePageStateRequest({ op: "get", key: "a", target })).toEqual({ op: "get", key: "a", target });
    expect(parsePageStateRequest({ op: "set", key: "a", target })).toEqual({
      op: "set",
      key: "a",
      value: null,
      target,
    });
    expect(() => parsePageStateRequest({ op: "get", key: "", target })).toThrow();
    expect(() => parsePageStateRequest({ op: "drop", key: "a", target })).toThrow();
    expect(() => parsePageStateRequest({ op: "keys", target: { appId: "app_x" } })).toThrow();
  });
});
