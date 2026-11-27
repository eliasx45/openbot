// Fork (docs/fork/FEATURES.md #123): saved apps. An agent's chat page saved as an app: one small JSON
// file of records, a copy of each kept version's page by content hash, and each page's saved data
// (openbotPage.state) in a file of its own. No Electron here, so the node tests can run it.

import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CHAT_VISUAL_PAGE_LIMIT } from "@openbot/contracts/chat-visual";
import {
  cleanSavedAppName,
  isPageStateKey,
  isSavedAppId,
  PAGE_STATE_KEYS_MAX,
  PAGE_STATE_TOTAL_MAX,
  PAGE_STATE_VALUE_MAX,
  type PageStateReply,
  type PageStateRequest,
  type PageStateTarget,
  type PageStateValue,
  pageStateValue,
  SAVED_APP_TITLE_MAX,
  SAVED_APP_VERSIONS,
  SAVED_APPS_MAX,
  type SaveAppPageInput,
  type SavedApp,
} from "@openbot/contracts/fork-saved-apps";
import { type DynamicRecord, isDynamicRecord, isNumber, isString } from "@openbot/contracts/runtime-values";

const DOC = /^[0-9a-f]{64}$/u;
const APPS_FILE = "apps.json";
const WINDOWS_FILE = "windows.json";

export interface SavedAppVersionRecord {
  rev: number;
  messageId: string;
  attachmentId: string;
  /** sha256 of the page, stored as pages/<doc>.html. */
  doc: string;
  at: number;
}

export interface SavedAppRecord {
  id: string;
  name: string;
  serverId: string;
  agentId: string;
  threadId: string;
  /** The source page's title: newer pages of the same agent and thread with this title are new versions. */
  title: string;
  versions: SavedAppVersionRecord[];
  pinnedRev?: number;
  createdAt: number;
  updatedAt: number;
}

export class SavedAppsFull extends Error {
  constructor() {
    super("There are too many saved apps. Remove one first.");
  }
}

function writeAtomic(path: string, content: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(temporary, content, { mode: 0o600 });
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function readJson(path: string): DynamicRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return isDynamicRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const text = (value: unknown, max = 512): value is string => isString(value) && value.length > 0 && value.length <= max;
const count = (value: unknown): value is number => isNumber(value) && Number.isInteger(value) && value >= 0;

function readVersion(value: unknown): SavedAppVersionRecord | null {
  if (!isDynamicRecord(value)) return null;
  const { rev, messageId, attachmentId, doc, at } = value;
  if (!count(rev) || rev < 1 || !text(messageId) || !text(attachmentId) || !isString(doc) || !DOC.test(doc))
    return null;
  return { rev, messageId, attachmentId, doc, at: count(at) ? at : 0 };
}

function readRecord(value: unknown): SavedAppRecord | null {
  if (!isDynamicRecord(value)) return null;
  const { id, name, serverId, agentId, threadId, title, pinnedRev, createdAt, updatedAt } = value;
  if (!isSavedAppId(id) || !isString(name) || !text(serverId) || !text(agentId) || !isString(threadId)) return null;
  if (!text(title, SAVED_APP_TITLE_MAX) || !Array.isArray(value.versions)) return null;
  const versions = value.versions.map(readVersion);
  if (versions.length === 0 || versions.some((version) => version === null)) return null;
  const kept = versions.filter((version) => version !== null).sort((a, b) => a.rev - b.rev);
  const shown = cleanSavedAppName(name) || cleanSavedAppName(title) || "App";
  return {
    id,
    name: shown,
    serverId,
    agentId,
    threadId,
    title,
    versions: kept,
    ...(count(pinnedRev) && kept.some((version) => version.rev === pinnedRev) ? { pinnedRev } : {}),
    createdAt: count(createdAt) ? createdAt : 0,
    updatedAt: count(updatedAt) ? updatedAt : 0,
  };
}

/** The newest versions, the pinned one always among them. */
export function keptVersions(
  versions: readonly SavedAppVersionRecord[],
  pinnedRev?: number,
  limit = SAVED_APP_VERSIONS,
): SavedAppVersionRecord[] {
  const sorted = [...versions].sort((a, b) => a.rev - b.rev);
  const newest = sorted.slice(-limit);
  const pinned = pinnedRev === undefined ? undefined : sorted.find((version) => version.rev === pinnedRev);
  return pinned && !newest.includes(pinned) ? [pinned, ...newest.slice(1)] : newest;
}

export function shownRev(record: SavedAppRecord): number {
  return record.pinnedRev ?? record.versions.at(-1)?.rev ?? 1;
}

export function pageDigest(html: Uint8Array): string {
  return createHash("sha256").update(html).digest("hex");
}

/** The key of a page's saved data: the same for the chat page and its app, across versions. */
export function pageStateScope(page: { serverId: string; agentId: string; threadId: string; title: string }): string {
  return createHash("sha256")
    .update([page.serverId, page.agentId, page.threadId, page.title].join("\u0000"))
    .digest("hex");
}

export interface SavedAppPage {
  messageId: string;
  attachmentId: string;
  html: Uint8Array;
}

/** The apps saved on this computer: `<dir>/apps.json` and `<dir>/pages/<sha256>.html`. */
export class SavedAppsStore {
  readonly #dir: string;
  readonly #now: () => number;
  #records: SavedAppRecord[];

  constructor(dir: string, options: { now?: () => number } = {}) {
    this.#dir = dir;
    this.#now = options.now ?? Date.now;
    this.#records = this.#read();
  }

  #read(): SavedAppRecord[] {
    const parsed = readJson(join(this.#dir, APPS_FILE));
    if (!isDynamicRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.apps)) return [];
    const seen = new Set<string>();
    const records: SavedAppRecord[] = [];
    for (const value of parsed.apps) {
      const record = readRecord(value);
      if (!record || seen.has(record.id) || records.length >= SAVED_APPS_MAX) continue;
      seen.add(record.id);
      records.push(record);
    }
    return records;
  }

  #write(): void {
    writeAtomic(join(this.#dir, APPS_FILE), `${JSON.stringify({ version: 1, apps: this.#records })}\n`);
    this.#sweepPages();
  }

  #pagePath(doc: string): string {
    return join(this.#dir, "pages", `${doc}.html`);
  }

  #storePage(html: Uint8Array): string {
    const doc = pageDigest(html);
    const path = this.#pagePath(doc);
    try {
      if (readFileSync(path).byteLength === html.byteLength) return doc;
    } catch {}
    writeAtomic(path, html);
    return doc;
  }

  /** Remove the page copies no app keeps any more. */
  #sweepPages(): void {
    const kept = new Set(this.#records.flatMap((record) => record.versions.map((version) => `${version.doc}.html`)));
    let files: string[];
    try {
      files = readdirSync(join(this.#dir, "pages"));
    } catch {
      return;
    }
    for (const file of files) if (!kept.has(file)) rmSync(join(this.#dir, "pages", file), { force: true });
  }

  list(): readonly SavedAppRecord[] {
    return this.#records;
  }

  get(id: string): SavedAppRecord | null {
    return this.#records.find((record) => record.id === id) ?? null;
  }

  /** The app saved from this page (same server, agent, thread and title), if any. */
  findPage(page: { serverId: string; agentId: string; threadId: string; title: string }): SavedAppRecord | null {
    return (
      this.#records.find(
        (record) =>
          record.serverId === page.serverId &&
          record.agentId === page.agentId &&
          record.threadId === page.threadId &&
          record.title === page.title,
      ) ?? null
    );
  }

  /** Save a page as an app. Saving the same page again returns the existing app, with this version added if new. */
  save(input: { serverId: string; agentId: string; threadId: string; title: string; page: SavedAppPage }): {
    record: SavedAppRecord;
    created: boolean;
  } {
    const existing = this.findPage(input);
    if (existing) return { record: this.addVersion(existing.id, input.page) ?? existing, created: false };
    if (this.#records.length >= SAVED_APPS_MAX) throw new SavedAppsFull();
    const now = this.#now();
    const doc = this.#storePage(input.page.html);
    const record: SavedAppRecord = {
      id: `app_${randomBytes(12).toString("base64url")}`,
      name: cleanSavedAppName(input.title) || "App",
      serverId: input.serverId,
      agentId: input.agentId,
      threadId: input.threadId,
      title: input.title,
      versions: [{ rev: 1, messageId: input.page.messageId, attachmentId: input.page.attachmentId, doc, at: now }],
      createdAt: now,
      updatedAt: now,
    };
    this.#records = [record, ...this.#records];
    this.#write();
    return { record, created: true };
  }

  /** A newer version of the page. A message already kept, or the same page as the newest, adds nothing. */
  addVersion(id: string, page: SavedAppPage): SavedAppRecord | null {
    const record = this.get(id);
    if (!record) return null;
    const doc = pageDigest(page.html);
    const newest = record.versions.at(-1);
    if (record.versions.some((version) => version.messageId === page.messageId) || newest?.doc === doc) return record;
    this.#storePage(page.html);
    const rev = Math.max(0, ...record.versions.map((version) => version.rev)) + 1;
    return this.#update(id, (was) => ({
      ...was,
      versions: [
        ...was.versions,
        { rev, messageId: page.messageId, attachmentId: page.attachmentId, doc, at: this.#now() },
      ],
    }));
  }

  #update(id: string, change: (record: SavedAppRecord) => SavedAppRecord): SavedAppRecord | null {
    const index = this.#records.findIndex((record) => record.id === id);
    const was = this.#records[index];
    if (!was) return null;
    const changed = change(was);
    const versions = keptVersions(changed.versions, changed.pinnedRev);
    const { pinnedRev, ...rest } = changed;
    const pinned =
      pinnedRev !== undefined && versions.some((version) => version.rev === pinnedRev) ? { pinnedRev } : {};
    const record: SavedAppRecord = { ...rest, ...pinned, versions, updatedAt: this.#now() };
    this.#records = this.#records.map((one, at) => (at === index ? record : one));
    this.#write();
    return record;
  }

  /** A name of one line, at most 80 characters. An empty name keeps the old one. */
  rename(id: string, name: string): SavedAppRecord | null {
    const cleaned = cleanSavedAppName(name);
    const record = this.get(id);
    if (!record || !cleaned || cleaned === record.name) return record;
    return this.#update(id, (was) => ({ ...was, name: cleaned }));
  }

  /** Keep showing one version (rev), or follow the newest again (null). */
  pin(id: string, rev: number | null): SavedAppRecord | null {
    const record = this.get(id);
    if (!record || (rev !== null && !record.versions.some((version) => version.rev === rev))) return null;
    return this.#update(id, ({ pinnedRev: _was, ...rest }) => ({
      ...rest,
      ...(rev === null ? {} : { pinnedRev: rev }),
    }));
  }

  remove(id: string): boolean {
    const before = this.#records.length;
    this.#records = this.#records.filter((record) => record.id !== id);
    if (this.#records.length === before) return false;
    this.#write();
    return true;
  }

  /** The stored page of a version the app keeps (the shown one without rev). */
  page(id: string, rev?: number): Uint8Array | null {
    const record = this.get(id);
    const version = record?.versions.find((one) => one.rev === (rev ?? shownRev(record)));
    if (!version) return null;
    try {
      const bytes = readFileSync(this.#pagePath(version.doc));
      return bytes.byteLength <= CHAT_VISUAL_PAGE_LIMIT ? new Uint8Array(bytes) : null;
    } catch {
      return null;
    }
  }
}

type StateValues = Map<string, PageStateValue>;

export class PageStateLimit extends Error {}

/** Each page's saved data (openbotPage.state): `<dir>/state/<scope>.json`. Kept when an app is removed. */
export class PageStateStore {
  readonly #dir: string;
  readonly #cache = new Map<string, StateValues>();

  constructor(dir: string) {
    this.#dir = dir;
  }

  #path(scope: string): string {
    if (!DOC.test(scope)) throw new Error("Invalid saved data scope.");
    return join(this.#dir, "state", `${scope}.json`);
  }

  #values(scope: string): StateValues {
    const cached = this.#cache.get(scope);
    if (cached) return cached;
    const parsed = readJson(this.#path(scope));
    const values: StateValues = new Map();
    if (isDynamicRecord(parsed) && parsed.version === 1 && isDynamicRecord(parsed.values))
      for (const [key, value] of Object.entries(parsed.values)) {
        const kept = pageStateValue(value);
        if (isPageStateKey(key) && kept !== undefined && kept !== null && values.size < PAGE_STATE_KEYS_MAX)
          values.set(key, kept);
      }
    this.#cache.set(scope, values);
    return values;
  }

  get(scope: string, key: string): PageStateValue {
    return this.#values(scope).get(key) ?? null;
  }

  keys(scope: string): string[] {
    return [...this.#values(scope).keys()];
  }

  /** null deletes the key. Throws PageStateLimit with a page-readable reason when a limit is hit. */
  set(scope: string, key: string, value: PageStateValue): void {
    if (!isPageStateKey(key)) throw new PageStateLimit("A saved data key must have 1 to 200 characters.");
    const values = new Map(this.#values(scope));
    if (value === null) {
      if (!values.delete(key)) return;
    } else {
      if (new TextEncoder().encode(JSON.stringify(value)).byteLength > PAGE_STATE_VALUE_MAX)
        throw new PageStateLimit("A saved value can be at most 64 KB.");
      if (!values.has(key) && values.size >= PAGE_STATE_KEYS_MAX)
        throw new PageStateLimit("A page can save at most 200 keys.");
      values.set(key, value);
    }
    const json = JSON.stringify(Object.fromEntries(values));
    if (new TextEncoder().encode(json).byteLength > PAGE_STATE_TOTAL_MAX)
      throw new PageStateLimit("A page can save at most 256 KB of data.");
    writeAtomic(this.#path(scope), `{"version":1,"values":${json}}\n`);
    this.#cache.set(scope, values);
  }
}

export interface SavedAppWindowSize {
  width: number;
  height: number;
}

/** The size each app's own window had when it was last closed: `<dir>/windows.json`. */
export function readSavedAppWindowSize(dir: string, id: string): SavedAppWindowSize | null {
  const parsed = readJson(join(dir, WINDOWS_FILE));
  const size = isDynamicRecord(parsed) && isDynamicRecord(parsed.windows) ? parsed.windows[id] : undefined;
  if (!isDynamicRecord(size) || !count(size.width) || !count(size.height)) return null;
  return { width: size.width, height: size.height };
}

export function writeSavedAppWindowSize(dir: string, id: string, size: SavedAppWindowSize, keep: ReadonlySet<string>) {
  const parsed = readJson(join(dir, WINDOWS_FILE));
  const windows: Record<string, SavedAppWindowSize> = {};
  if (isDynamicRecord(parsed) && isDynamicRecord(parsed.windows))
    for (const [key, value] of Object.entries(parsed.windows))
      if (keep.has(key) && isDynamicRecord(value) && count(value.width) && count(value.height))
        windows[key] = { width: value.width, height: value.height };
  windows[id] = { width: Math.round(size.width), height: Math.round(size.height) };
  writeAtomic(join(dir, WINDOWS_FILE), `${JSON.stringify({ version: 1, windows })}\n`);
}

/** Where a chat page lives and what it holds, as the main process reads it. */
export interface SavedAppSourcePage {
  html: Uint8Array;
  /** The agents the page belongs to (its author among them). */
  agentIds: readonly string[];
  /** The thread it was shown in; "" when unknown (a page of another server). */
  threadId: string;
}

export interface SavedAppsDependencies {
  dir: string;
  /** A page of this computer by attachment id, or null. */
  readLocalPage: (attachmentId: string) => Promise<SavedAppSourcePage | null>;
  /** A page of a joined server; its thread is not known here. */
  readRemotePage: (serverId: string, attachmentId: string) => Promise<Uint8Array | null>;
  /** The thread of a page of this computer, without reading the page. */
  localPageThread: (attachmentId: string) => { agentIds: readonly string[]; threadId: string } | null;
  agentName: (serverId: string, agentId: string) => string | null;
  localServerId: string;
  changed?: (apps: SavedApp[]) => void;
  now?: () => number;
}

export type SavedApps = ReturnType<typeof createSavedApps>;

export function createSavedApps(deps: SavedAppsDependencies) {
  const store = new SavedAppsStore(deps.dir, deps.now ? { now: deps.now } : {});
  const state = new PageStateStore(deps.dir);

  const view = (record: SavedAppRecord): SavedApp => {
    const shown = shownRev(record);
    const version = record.versions.find((one) => one.rev === shown) ?? record.versions.at(-1);
    return {
      id: record.id,
      name: record.name,
      agentName: deps.agentName(record.serverId, record.agentId),
      agentId: record.agentId,
      serverId: record.serverId,
      threadId: record.threadId,
      messageId: version?.messageId ?? "",
      title: record.title,
      versions: record.versions.map(({ rev, at }) => ({ rev, at })),
      rev: shown,
      ...(record.pinnedRev === undefined ? {} : { pinnedRev: record.pinnedRev }),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  };
  const list = () => store.list().map(view);
  const announce = () => deps.changed?.(list());

  const local = (serverId: string) => serverId === deps.localServerId;

  async function scopeOf(target: PageStateTarget): Promise<string | null> {
    if ("appId" in target) {
      const record = store.get(target.appId);
      return record ? pageStateScope(record) : null;
    }
    if (!local(target.serverId)) return pageStateScope({ ...target, threadId: "" });
    const page = deps.localPageThread(target.attachmentId);
    if (!page?.agentIds.includes(target.agentId)) return null;
    return pageStateScope({ ...target, threadId: page.threadId });
  }

  return {
    list,
    get: (id: string) => {
      const record = store.get(id);
      return record ? view(record) : null;
    },
    record: (id: string) => store.get(id),
    page: (id: string, rev?: number) => store.page(id, rev),

    async save(input: SaveAppPageInput): Promise<{ app: SavedApp; created: boolean }> {
      let html: Uint8Array | null;
      let threadId = "";
      if (local(input.serverId)) {
        const page = await deps.readLocalPage(input.attachmentId);
        if (!page?.agentIds.includes(input.agentId)) throw new Error("This page is not in the chat any more.");
        html = page.html;
        threadId = page.threadId;
      } else {
        html = await deps.readRemotePage(input.serverId, input.attachmentId);
      }
      if (!html) throw new Error("This page could not be read.");
      if (html.byteLength > CHAT_VISUAL_PAGE_LIMIT) throw new Error("This page is too big to save as an app.");
      const saved = store.save({
        serverId: input.serverId,
        agentId: input.agentId,
        threadId,
        title: input.title,
        page: { messageId: input.messageId, attachmentId: input.attachmentId, html },
      });
      announce();
      return { app: view(saved.record), created: saved.created };
    },

    /** Follow newest: a new page of an agent on this computer becomes a version of each app saved from that page. */
    async pageAdded(page: {
      agentId: string;
      threadId: string;
      messageId: string;
      attachmentId: string;
      title: string;
    }) {
      const record = store.findPage({ serverId: deps.localServerId, ...page });
      if (!record) return;
      const source = await deps.readLocalPage(page.attachmentId);
      if (!source || source.html.byteLength > CHAT_VISUAL_PAGE_LIMIT) return;
      const after = store.addVersion(record.id, { ...page, html: source.html });
      if (after && after !== record) announce();
    },

    rename(id: string, name: string) {
      const record = store.rename(id, name);
      if (record) announce();
      return record ? view(record) : null;
    },
    pin(id: string, rev: number | null) {
      const record = store.pin(id, rev);
      if (record) announce();
      return record ? view(record) : null;
    },
    remove(id: string) {
      const removed = store.remove(id);
      if (removed) announce();
      return removed;
    },

    async state(request: PageStateRequest): Promise<PageStateReply> {
      const scope = await scopeOf(request.target);
      if (!scope) return { ok: false, error: "This page cannot save data." };
      try {
        if (request.op === "keys") return { ok: true, value: state.keys(scope) };
        if (request.op === "get") return { ok: true, value: state.get(scope, request.key) };
        state.set(scope, request.key, request.value);
        return { ok: true, value: null };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof PageStateLimit ? error.message : "The data could not be saved.",
        };
      }
    },
  };
}
