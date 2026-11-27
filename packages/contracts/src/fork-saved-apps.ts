// Fork (docs/fork/FEATURES.md #123): saved apps. An agent's chat page (html_render) saved as an app
// that follows the agent's newer versions of the same page and keeps its own data (openbotPage.state).

import { isBoundedString, isIdentifier, isNullableBoundedString } from "./ipc-bounded-values";
import { isDynamicRecord, isNumber, isString } from "./runtime-values";

/** Security invariant: an id reaches file names, window keys and deep links, so only this shape passes. */
export const SAVED_APP_ID = /^app_[A-Za-z0-9_-]{16}$/u;
export const SAVED_APP_NAME_MAX = 80;
export const SAVED_APP_VERSIONS = 20;
export const SAVED_APPS_MAX = 200;
export const SAVED_APP_TITLE_MAX = 200;

export const PAGE_STATE_KEY_MAX = 200;
export const PAGE_STATE_VALUE_MAX = 64 * 1024;
export const PAGE_STATE_TOTAL_MAX = 256 * 1024;
export const PAGE_STATE_KEYS_MAX = 200;

export const SAVED_APP_LINK_PREFIX = "openbot://app/";
const SAVED_APP_LINK_MAX = 256;

export function isSavedAppId(value: unknown): value is string {
  return isString(value) && SAVED_APP_ID.test(value);
}

export interface SavedAppVersion {
  rev: number;
  at: number;
}

export interface SavedApp {
  id: string;
  name: string;
  /** null when the agent is gone or unknown. */
  agentName: string | null;
  agentId: string;
  serverId: string;
  threadId: string;
  /** The chat message of the shown version, for "Go to chat". */
  messageId: string;
  title: string;
  versions: SavedAppVersion[];
  /** The version the app shows: the pinned one, else the newest. */
  rev: number;
  pinnedRev?: number;
  createdAt: number;
  updatedAt: number;
}

export interface SaveAppPageInput {
  serverId: string;
  agentId: string;
  messageId: string;
  attachmentId: string;
  title: string;
}

export interface SaveAppPageResult {
  app: SavedApp;
  created: boolean;
}

export interface RenameSavedAppInput {
  id: string;
  name: string;
}

export interface PinSavedAppInput {
  id: string;
  /** null follows the newest version again. */
  rev: number | null;
}

/** Which page's saved data a frame reads: a saved app, or a chat page (its app's data when it is saved). */
export type PageStateTarget =
  | { appId: string }
  | { serverId: string; agentId: string; attachmentId: string; title: string };

/** A JSON value a page saves. */
export type PageStateValue = string | number | boolean | null | PageStateValue[] | { [key: string]: PageStateValue };

const JSON_DEPTH_MAX = 64;

/** The value as JSON keeps it, or undefined when it is not plain JSON (or nests too deep). */
export function pageStateValue(value: unknown, depth = 0): PageStateValue | undefined {
  if (value === null || isString(value) || typeof value === "boolean") return value;
  if (isNumber(value)) return Number.isFinite(value) ? value : null;
  if (depth >= JSON_DEPTH_MAX) return undefined;
  if (Array.isArray(value)) {
    const list: PageStateValue[] = [];
    for (const item of value) {
      const kept = pageStateValue(item, depth + 1);
      if (kept === undefined) return undefined;
      list.push(kept);
    }
    return list;
  }
  if (!isDynamicRecord(value)) return undefined;
  const object: { [key: string]: PageStateValue } = {};
  for (const [key, item] of Object.entries(value)) {
    const kept = pageStateValue(item, depth + 1);
    if (kept === undefined) return undefined;
    Object.defineProperty(object, key, { value: kept, enumerable: true, writable: true, configurable: true });
  }
  return object;
}

export type PageStateOperation =
  | { op: "get"; key: string }
  | { op: "set"; key: string; value: PageStateValue }
  | { op: "keys" };

export type PageStateRequest = PageStateOperation & { target: PageStateTarget };

/** Where "Go to chat" of an app leads: the chat message of its shown version. */
export interface SavedAppChatTarget {
  serverId: string;
  agentId: string;
  messageId: string;
}

export function decodeSavedAppChatTarget(value: unknown): SavedAppChatTarget {
  const target = record(value, "chat");
  const { serverId, agentId, messageId } = target;
  return isIdentifier(serverId) && isIdentifier(agentId) && isString(messageId)
    ? { serverId, agentId, messageId }
    : fail("chat");
}

export function decodeBooleanReply(value: unknown): boolean {
  return typeof value === "boolean" ? value : fail("answer");
}

export type PageStateReply = { ok: true; value: PageStateValue } | { ok: false; error: string };

export function savedAppUrl(id: string, rev?: number): string {
  return `openbot-visual://app/${id}${rev === undefined ? "" : `?rev=${rev}`}`;
}

/** One line, at most 80 characters; empty when nothing is left. */
export function cleanSavedAppName(value: string): string {
  return value
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, SAVED_APP_NAME_MAX)
    .trim();
}

export function savedAppLink(id: string, window = false): string {
  if (!isSavedAppId(id)) throw new Error("Invalid app id.");
  return `${SAVED_APP_LINK_PREFIX}${id}${window ? "?window=1" : ""}`;
}

/** `{ id, window }` for openbot://app/<id>, a trailing slash allowed, `?window=1` the only query; null otherwise. */
export function parseSavedAppLink(value: unknown): { id: string; window: boolean } | null {
  if (!isString(value) || value.length > SAVED_APP_LINK_MAX) return null;
  const link = value.trim();
  if (link.slice(0, SAVED_APP_LINK_PREFIX.length).toLowerCase() !== SAVED_APP_LINK_PREFIX) return null;
  const match = /^([^/?#]+)\/?(\?window=1)?$/u.exec(link.slice(SAVED_APP_LINK_PREFIX.length));
  const id = match?.[1];
  return match && isSavedAppId(id) ? { id, window: Boolean(match[2]) } : null;
}

const fail = (what: string): never => {
  throw new Error(`Invalid ${what}.`);
};

function record(value: unknown, what: string) {
  return isDynamicRecord(value) ? value : fail(what);
}

function appId(value: unknown): string {
  return isSavedAppId(value) ? value : fail("app id");
}

function title(value: unknown): string {
  return isBoundedString(value, SAVED_APP_TITLE_MAX) && value.trim() ? value : fail("page title");
}

export function parseSavedAppId(value: unknown): string {
  return appId(isDynamicRecord(value) ? value.id : value);
}

export function parseSaveAppPageInput(value: unknown): SaveAppPageInput {
  const input = record(value, "page");
  const { serverId, agentId, messageId, attachmentId } = input;
  if (!isIdentifier(serverId) || !isIdentifier(agentId) || !isIdentifier(messageId) || !isIdentifier(attachmentId))
    return fail("page");
  return { serverId, agentId, messageId, attachmentId, title: title(input.title) };
}

export function parseRenameSavedAppInput(value: unknown): RenameSavedAppInput {
  const input = record(value, "name");
  if (!isBoundedString(input.name, 1_000)) return fail("name");
  return { id: appId(input.id), name: input.name };
}

export function parsePinSavedAppInput(value: unknown): PinSavedAppInput {
  const input = record(value, "version");
  const rev = input.rev;
  if (rev !== null && !(isNumber(rev) && Number.isInteger(rev) && rev >= 1)) return fail("version");
  return { id: appId(input.id), rev };
}

function parseTarget(value: unknown): PageStateTarget {
  const target = record(value, "page");
  if (target.appId !== undefined) return { appId: appId(target.appId) };
  const { serverId, agentId, attachmentId } = target;
  if (!isIdentifier(serverId) || !isIdentifier(agentId) || !isIdentifier(attachmentId)) return fail("page");
  return { serverId, agentId, attachmentId, title: title(target.title) };
}

export function isPageStateKey(value: unknown): value is string {
  return isString(value) && value.length > 0 && value.length <= PAGE_STATE_KEY_MAX;
}

export function parsePageStateRequest(value: unknown): PageStateRequest {
  const input = record(value, "saved data request");
  const target = parseTarget(input.target);
  if (input.op === "keys") return { op: "keys", target };
  if (input.op !== "get" && input.op !== "set") return fail("saved data request");
  if (!isPageStateKey(input.key)) return fail("saved data key");
  if (input.op === "get") return { op: "get", key: input.key, target };
  const stored = pageStateValue(input.value ?? null);
  return stored === undefined ? fail("saved value") : { op: "set", key: input.key, value: stored, target };
}

function decodeVersion(value: unknown): SavedAppVersion {
  const version = record(value, "app version");
  return isNumber(version.rev) && isNumber(version.at) ? { rev: version.rev, at: version.at } : fail("app version");
}

export function decodeSavedApp(value: unknown): SavedApp {
  const app = record(value, "app");
  const { id, name, agentName, agentId, serverId, threadId, messageId, rev, pinnedRev, createdAt, updatedAt } = app;
  if (
    !isSavedAppId(id) ||
    !isString(name) ||
    !isNullableBoundedString(agentName, 1_000) ||
    !isString(agentId) ||
    !isString(serverId) ||
    !isString(threadId) ||
    !isString(messageId) ||
    !isString(app.title) ||
    !Array.isArray(app.versions) ||
    !isNumber(rev) ||
    (pinnedRev !== undefined && !isNumber(pinnedRev)) ||
    !isNumber(createdAt) ||
    !isNumber(updatedAt)
  )
    return fail("app");
  return {
    id,
    name,
    agentName,
    agentId,
    serverId,
    threadId,
    messageId,
    title: app.title,
    versions: app.versions.map(decodeVersion),
    rev,
    ...(pinnedRev === undefined ? {} : { pinnedRev }),
    createdAt,
    updatedAt,
  };
}

export function decodeSavedApps(value: unknown): SavedApp[] {
  return Array.isArray(value) ? value.map(decodeSavedApp) : fail("apps");
}

export function decodeSavedAppOrNull(value: unknown): SavedApp | null {
  return value === null ? null : decodeSavedApp(value);
}

export function decodeSaveAppPageResult(value: unknown): SaveAppPageResult {
  const result = record(value, "saved app");
  if (typeof result.created !== "boolean") return fail("saved app");
  return { app: decodeSavedApp(result.app), created: result.created };
}

export function decodePageStateReply(value: unknown): PageStateReply {
  const reply = record(value, "saved data reply");
  const kept = pageStateValue(reply.value ?? null);
  if (reply.ok === true && kept !== undefined) return { ok: true, value: kept };
  return reply.ok === false && isString(reply.error) ? { ok: false, error: reply.error } : fail("saved data reply");
}

export function decodeSavedAppIdOrNull(value: unknown): string | null {
  return value === null ? null : appId(value);
}
