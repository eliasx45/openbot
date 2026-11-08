// Fork (docs/fork/FEATURES.md entry 32): import the sign-ins of Google Chrome on this Mac into named
// browser profiles, and keep each imported profile linked to its Chrome profile for a re-sync.
//
// Chrome keeps its cookies in `<profile>/Cookies`, a SQLite file. On macOS each value is encrypted
// with AES-128-CBC. The key comes from the "Chrome Safe Storage" password in the login Keychain
// (PBKDF2-SHA1, salt "saltysalt", 1003 rounds). A database at version 24 or later puts the SHA-256
// of the host before each value. macOS asks the user once before it gives the password.
//
// Newest wins: a re-sync copies a Chrome cookie only when it is newer than the copy in OpenBot. The
// time of a change in OpenBot is not on an Electron cookie, so this module notes it from the
// session's `changed` events. Chrome removals are never copied: a sign-out in Chrome never signs an
// agent out. Cookie values are user secrets: they are never logged.

import { execFile } from "node:child_process";
import { createDecipheriv, createHash, pbkdf2Sync } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  AgentBrowserProfileChoices,
  ChromeImportResult,
  ChromeLink,
  ChromeProfileList,
  ChromeSignInResult,
  ChromeSite,
  ChromeSyncCounts,
  ImportChromeProfilesInput,
} from "@openbot/contracts/ipc";
import { sourceText } from "@openbot/i18n/source";
import type { Cookie, Cookies, CookiesSetDetails } from "electron";

const APP_SUPPORT = join(homedir(), "Library", "Application Support");

interface ChromiumBrowser {
  id: string;
  name: string;
  /** The user data folder under ~/Library/Application Support. */
  folder: string[];
  /** The Keychain item that holds the cookie key. */
  service: string;
}

/** The browsers that keep Chrome's cookie format and key, most used first. */
const BROWSERS: readonly ChromiumBrowser[] = [
  { id: "chrome", name: "Google Chrome", folder: ["Google", "Chrome"], service: "Chrome Safe Storage" },
  { id: "brave", name: "Brave", folder: ["BraveSoftware", "Brave-Browser"], service: "Brave Safe Storage" },
  { id: "arc", name: "Arc", folder: ["Arc", "User Data"], service: "Arc Safe Storage" },
  { id: "edge", name: "Microsoft Edge", folder: ["Microsoft Edge"], service: "Microsoft Edge Safe Storage" },
  { id: "chromium", name: "Chromium", folder: ["Chromium"], service: "Chromium Safe Storage" },
  { id: "vivaldi", name: "Vivaldi", folder: ["Vivaldi"], service: "Vivaldi Safe Storage" },
];

/** `chrome:Profile 12` → the browser and the profile folder. */
function splitDir(dir: string): { browser: ChromiumBrowser; profileDir: string } | null {
  const colon = dir.indexOf(":");
  const browser = BROWSERS.find((entry) => entry.id === dir.slice(0, colon));
  const profileDir = dir.slice(colon + 1);
  if (colon < 0 || !browser || !profileDir || profileDir.includes("/") || profileDir.startsWith(".")) return null;
  return { browser, profileDir };
}
/** Seconds between 1601-01-01 (Chrome's epoch) and 1970-01-01. */
const CHROME_EPOCH_OFFSET_S = 11_644_473_600;
/** A changed-event note older than a sync is saved at most this often. */
const SAVE_DELAY_MS = 2_000;

interface ChromeCookie {
  key: string;
  host: string;
  name: string;
  value: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: CookiesSetDetails["sameSite"];
  /** Unix seconds; undefined for a session cookie. */
  expires: number | undefined;
  /** Unix ms of the last change in Chrome. */
  updatedAt: number;
}

interface CookieNote {
  /** Unix ms of the Chrome copy last written into OpenBot. */
  chrome: number;
  /** Unix ms of the last change made in OpenBot (a page, a sign-in, a sign-out). */
  local?: number;
}

interface LinkFile {
  chromeDir: string;
  chromeName: string;
  /** The browser's name, such as "Google Chrome". */
  browser: string;
  email: string;
  sites: string[] | null;
  lastSyncAt: number | null;
  cookies: Record<string, CookieNote>;
}

export interface ChromeImportDependencies {
  /** The fork data folder, `<userData>/fork-chrome-import`. */
  dataDir: string;
  /** The cookie store of a named profile. Opening it creates and configures the session. */
  profileCookies: (profileId: string) => Cookies;
  createProfile: (name: string) => Promise<{ id: string; name: string }>;
  /** The current name of a profile, which the user may have changed since the import. */
  profileName?: (profileId: string) => string | undefined;
  /** Removes a profile that an import made and could not fill. */
  deleteProfile: (profileId: string) => Promise<void>;
  profileExists: (profileId: string) => boolean;
  /** The open tab, its URL, its named profile and its agent, or undefined. */
  tab: (tabId: string) => { url: string; profileId: string | undefined; agentId: string | null } | undefined;
  /** The cookie store of an open tab, whatever its session. */
  tabCookies: (tabId: string) => Cookies | undefined;
  /** The named profiles an agent may use: its default first, then its extra profiles. */
  agentProfileIds: (agentId: string) => string[];
  reloadTab: (tabId: string) => Promise<void>;
  /** The "… Safe Storage" password of a browser. Tests replace it. */
  readSafeStoragePassword?: (service: string) => Promise<string>;
  /** Asks the user to confirm an import, with Touch ID where the Mac has it. Rejects when refused. */
  confirmUser?: () => Promise<void>;
  /** ~/Library/Application Support. Tests replace it. */
  appSupport?: string;
}

export interface ChromeImportService {
  listProfiles(): ChromeProfileList;
  listSites(chromeDir: string): ChromeSite[];
  importProfiles(input: ImportChromeProfilesInput): Promise<ChromeImportResult>;
  links(): ChromeLink[];
  resync(profileId: string): Promise<ChromeSyncCounts>;
  /** Copies Chrome's cookies of the site of a tab into its profile, then reloads the tab. */
  signInTab(tabId: string): Promise<ChromeSignInResult>;
  /**
   * The site a tab could take from Chrome, or null. The tab's profile is linked, or one profile of
   * its agent is linked and holds an imported sign-in of that site.
   */
  signInSite(tabId: string): string | null;
  /** The first of these profiles that is linked and holds imported cookies of the URL's site. */
  profileWithSite(profileIds: readonly string[], url: string): string | undefined;
  agentChoices(agentId: string): string[];
  setAgentChoices(input: AgentBrowserProfileChoices): AgentBrowserProfileChoices;
  /** Stops following the profiles and writes the pending notes. */
  dispose(): void;
}

/** The registrable part of a host, close enough for cookie hosts: `accounts.google.com` → `google.com`. */
export function siteOfHost(host: string): string {
  const labels = host.replace(/^\./u, "").toLowerCase().split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");
  const second = labels[labels.length - 2] ?? "";
  const top = labels[labels.length - 1] ?? "";
  // co.uk, com.au, org.br …: a short second label under a two-letter country code.
  const countrySecond =
    top.length === 2 && ["co", "com", "org", "net", "ac", "gov", "edu", "ne", "or"].includes(second);
  return labels.slice(countrySecond ? -3 : -2).join(".");
}

function chromeTimeToMs(value: number | bigint): number {
  const micros = Number(value);
  if (!micros) return 0;
  return Math.round(micros / 1000 - CHROME_EPOCH_OFFSET_S * 1000);
}

function cookieKey(host: string, name: string, path: string): string {
  return `${host}\t${name}\t${path}`;
}

function sameSiteOf(value: number): CookiesSetDetails["sameSite"] {
  if (value === 0) return "no_restriction";
  if (value === 1) return "lax";
  if (value === 2) return "strict";
  return "unspecified";
}

function defaultSafeStoragePassword(service: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // macOS shows its Keychain question while this waits, so it gets two minutes.
    execFile(
      "/usr/bin/security",
      ["find-generic-password", "-w", "-s", service],
      { timeout: 120_000 },
      (error, stdout) => {
        if (error) reject(new Error(sourceText("error.backend.chromeImportKeychain")));
        else resolve(stdout.trim());
      },
    );
  });
}

type CookieChangedListener = Parameters<Cookies["on"]>[1];

function isRecord(value: unknown): value is { [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rowText(value: unknown): string {
  if (typeof value === "string") return value;
  return typeof value === "number" || typeof value === "bigint" ? String(value) : "";
}

function rowNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") return Number(value) || 0;
  return 0;
}

/** A link file as this module writes it, or undefined for anything else. */
function decodeLinkFile(value: unknown): LinkFile | undefined {
  if (!isRecord(value) || typeof value.chromeDir !== "string" || !isRecord(value.cookies)) return undefined;
  const cookies: LinkFile["cookies"] = {};
  for (const [key, note] of Object.entries(value.cookies)) {
    if (!isRecord(note)) continue;
    cookies[key] = {
      chrome: rowNumber(note.chrome),
      ...(note.local === undefined ? {} : { local: rowNumber(note.local) }),
    };
  }
  return {
    chromeDir: value.chromeDir,
    chromeName: rowText(value.chromeName),
    browser: rowText(value.browser) || "Google Chrome",
    email: rowText(value.email),
    sites: Array.isArray(value.sites) ? value.sites.filter((site): site is string => typeof site === "string") : null,
    lastSyncAt: typeof value.lastSyncAt === "number" ? value.lastSyncAt : null,
    cookies,
  };
}

/** The profiles in Chrome's `Local State`, with the time each was last used. */
function decodeLocalStateProfiles(value: unknown): { dir: string; name: string; email: string; active: number }[] {
  const profile = isRecord(value) ? value.profile : undefined;
  const cache = isRecord(profile) && isRecord(profile.info_cache) ? profile.info_cache : {};
  return Object.entries(cache).map(([dir, info]) => ({
    dir,
    name: (isRecord(info) && rowText(info.name)) || dir,
    email: isRecord(info) ? rowText(info.user_name) : "",
    active: isRecord(info) ? rowNumber(info.active_time) : 0,
  }));
}

function decodeChoicesFile(value: unknown): Map<string, string[]> {
  const choices = new Map<string, string[]>();
  if (!isRecord(value)) return choices;
  for (const [agentId, ids] of Object.entries(value)) {
    if (Array.isArray(ids))
      choices.set(
        agentId,
        ids.filter((id): id is string => typeof id === "string"),
      );
  }
  return choices;
}

function emptyCounts(): ChromeSyncCounts {
  return { added: 0, updated: 0, kept: 0, unchanged: 0, skipped: 0 };
}

export function createChromeImportService(deps: ChromeImportDependencies): ChromeImportService {
  const appSupport = deps.appSupport ?? APP_SUPPORT;
  const browserRoot = (browser: ChromiumBrowser) => join(appSupport, ...browser.folder);
  const linksDir = join(deps.dataDir, "links");
  const choicesFile = join(deps.dataDir, "agent-profiles.json");
  mkdirSync(linksDir, { recursive: true });
  const keys = new Map<string, Buffer>();
  const loaded = new Map<string, LinkFile>();
  const dirty = new Set<string>();
  let saveTimer: NodeJS.Timeout | undefined;
  /** Cookies this module writes now, by profile and key: their changed events are not OpenBot changes. */
  const writing = new Map<string, Set<string>>();
  const followed = new Map<string, { cookies: Cookies; listener: CookieChangedListener }>();
  /** One sync per profile at a time. */
  const running = new Map<string, Promise<unknown>>();

  const linkPath = (profileId: string) => join(linksDir, `${profileId.replace(/[^0-9a-z]/giu, "")}.json`);

  function readLink(profileId: string): LinkFile | undefined {
    const cached = loaded.get(profileId);
    if (cached) return cached;
    const path = linkPath(profileId);
    if (!existsSync(path)) return undefined;
    try {
      const link = decodeLinkFile(JSON.parse(readFileSync(path, "utf8")));
      if (link) loaded.set(profileId, link);
      return link;
    } catch {
      return undefined;
    }
  }

  function saveNow(): void {
    clearTimeout(saveTimer);
    saveTimer = undefined;
    for (const profileId of dirty) {
      const link = loaded.get(profileId);
      if (link) writeFileSync(linkPath(profileId), JSON.stringify(link), { mode: 0o600 });
    }
    dirty.clear();
  }

  function markDirty(profileId: string): void {
    dirty.add(profileId);
    saveTimer ??= setTimeout(saveNow, SAVE_DELAY_MS);
  }

  function linkedProfileIds(): string[] {
    try {
      return readdirSync(linksDir)
        .filter((file) => file.endsWith(".json"))
        .map((file) => file.slice(0, -5));
    } catch {
      return [];
    }
  }

  /** Notes each change that a page or a sign-in makes in a linked profile, with its time. */
  function follow(profileId: string): void {
    if (followed.has(profileId) || !deps.profileExists(profileId)) return;
    const cookies = deps.profileCookies(profileId);
    const listener: CookieChangedListener = (_event, cookie, cause, removed) => {
      const link = readLink(profileId);
      if (!link || !cookie.domain) return;
      const key = cookieKey(cookie.domain, cookie.name, cookie.path ?? "/");
      if (!removed && writing.get(profileId)?.has(key)) return;
      // An overwrite is the first half of a set, an expiry is not a user's act.
      if (removed && cause !== "explicit") return;
      const note = link.cookies[key] ?? { chrome: 0 };
      note.local = Date.now();
      link.cookies[key] = note;
      markDirty(profileId);
    };
    cookies.on("changed", listener);
    followed.set(profileId, { cookies, listener });
  }

  for (const profileId of linkedProfileIds()) {
    if (deps.profileExists(profileId)) follow(profileId);
  }

  async function chromeKey(chromeDir: string): Promise<Buffer> {
    const parts = splitDir(chromeDir);
    if (!parts) throw new Error(sourceText("error.backend.chromeImportProfileMissing"));
    const known = keys.get(parts.browser.service);
    if (known) return known;
    const password = await (deps.readSafeStoragePassword ?? defaultSafeStoragePassword)(parts.browser.service);
    const derived = pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
    keys.set(parts.browser.service, derived);
    return derived;
  }

  function cookieFile(chromeDir: string): string | null {
    const parts = splitDir(chromeDir);
    if (!parts) return null;
    const profileDir = join(browserRoot(parts.browser), parts.profileDir);
    for (const candidate of [join(profileDir, "Network", "Cookies"), join(profileDir, "Cookies")]) {
      if (existsSync(candidate)) return candidate;
    }
    return null;
  }

  /** Runs `read` on a copy of a Chrome cookie file: Chrome may hold the original open. */
  function withCookieCopy<T>(chromeDir: string, read: (db: DatabaseSync) => T): T | null {
    const source = cookieFile(chromeDir);
    if (!source) return null;
    const folder = mkdtempSync(join(tmpdir(), "openbot-chrome-"));
    try {
      const copy = join(folder, "Cookies");
      copyFileSync(source, copy);
      for (const suffix of ["-wal", "-journal"]) {
        if (existsSync(source + suffix)) copyFileSync(source + suffix, copy + suffix);
      }
      // Chrome times are microseconds since 1601: larger than a safe JavaScript number.
      const db = new DatabaseSync(copy, { readOnly: true, readBigInts: true });
      try {
        return read(db);
      } finally {
        db.close();
      }
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  }

  function chromeProfiles(): { dir: string; browser: string; name: string; email: string }[] {
    return BROWSERS.flatMap((browser) => {
      const statePath = join(browserRoot(browser), "Local State");
      if (!existsSync(statePath)) return [];
      try {
        return decodeLocalStateProfiles(JSON.parse(readFileSync(statePath, "utf8")))
          .sort((left, right) => right.active - left.active)
          .map(({ dir, name, email }) => ({ dir: `${browser.id}:${dir}`, browser: browser.name, name, email }));
      } catch {
        return [];
      }
    });
  }

  function listProfiles(): ChromeProfileList {
    const profiles = chromeProfiles();
    return {
      available: profiles.length > 0,
      profiles: profiles.map((profile) => ({
        ...profile,
        cookies:
          withCookieCopy(profile.dir, (db) => {
            return rowNumber(db.prepare("SELECT count(*) AS count FROM cookies").get()?.count);
          }) ?? 0,
      })),
    };
  }

  function listSites(chromeDir: string): ChromeSite[] {
    const counts = new Map<string, number>();
    withCookieCopy(chromeDir, (db) => {
      const rows = db.prepare("SELECT host_key AS host, count(*) AS count FROM cookies GROUP BY host_key").all();
      for (const row of rows) {
        const site = siteOfHost(rowText(row.host));
        counts.set(site, (counts.get(site) ?? 0) + rowNumber(row.count));
      }
    });
    return [...counts.entries()]
      .map(([site, cookies]) => ({ site, cookies }))
      .sort((left, right) => right.cookies - left.cookies || left.site.localeCompare(right.site));
  }

  async function readChromeCookies(chromeDir: string, accept: (site: string) => boolean): Promise<ChromeCookie[]> {
    const aesKey = await chromeKey(chromeDir);
    const nowS = Date.now() / 1000;
    const rows = withCookieCopy(chromeDir, (db) => {
      const version = rowNumber(db.prepare("SELECT value FROM meta WHERE key = 'version'").get()?.value);
      const columns = new Set(
        db
          .prepare("PRAGMA table_info(cookies)")
          .all()
          .map((column) => rowText(column.name)),
      );
      const updated = columns.has("last_update_utc") ? "last_update_utc" : "creation_utc";
      const partition = columns.has("top_frame_site_key") ? "top_frame_site_key" : "''";
      const all = db
        .prepare(
          `SELECT host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, has_expires,
                  samesite, ${updated} AS updated, ${partition} AS partition_key FROM cookies`,
        )
        .all();
      return { version, all };
    });
    if (!rows) throw new Error(sourceText("error.backend.chromeImportProfileMissing"));
    const result: ChromeCookie[] = [];
    for (const row of rows.all) {
      const host = rowText(row.host_key);
      // A partitioned cookie belongs to one top site; Electron cannot set it.
      if (row.partition_key) continue;
      if (!accept(siteOfHost(host))) continue;
      const expires = rowNumber(row.has_expires) ? chromeTimeToMs(rowNumber(row.expires_utc)) / 1000 : undefined;
      if (expires !== undefined && expires <= nowS) continue;
      let value = rowText(row.value);
      const encrypted = row.encrypted_value instanceof Uint8Array ? row.encrypted_value : null;
      if (encrypted && encrypted.length > 3) {
        const prefix = Buffer.from(encrypted.subarray(0, 3)).toString("latin1");
        if (prefix !== "v10") continue;
        try {
          const decipher = createDecipheriv("aes-128-cbc", aesKey, Buffer.alloc(16, 0x20));
          let plain = Buffer.concat([decipher.update(encrypted.subarray(3)), decipher.final()]);
          if (rows.version >= 24) {
            const hash = createHash("sha256").update(host).digest();
            if (plain.subarray(0, 32).equals(hash)) plain = plain.subarray(32);
          }
          value = plain.toString("utf8");
        } catch {
          continue;
        }
      }
      const name = rowText(row.name);
      const path = rowText(row.path) || "/";
      result.push({
        key: cookieKey(host, name, path),
        host,
        name,
        value,
        path,
        secure: rowNumber(row.is_secure) !== 0,
        httpOnly: rowNumber(row.is_httponly) !== 0,
        sameSite: sameSiteOf(rowNumber(row.samesite)),
        expires,
        updatedAt: chromeTimeToMs(rowNumber(row.updated)),
      });
    }
    return result;
  }

  function setDetails(cookie: ChromeCookie): CookiesSetDetails {
    const bareHost = cookie.host.replace(/^\./u, "");
    const details: CookiesSetDetails = {
      url: `${cookie.secure ? "https" : "http"}://${bareHost}${cookie.path}`,
      name: cookie.name,
      value: cookie.value,
      path: cookie.path,
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
      sameSite: cookie.sameSite,
    };
    // A host with a leading dot is a domain cookie; without it the cookie stays on its host.
    if (cookie.host.startsWith(".")) details.domain = cookie.host;
    if (cookie.expires !== undefined) details.expirationDate = cookie.expires;
    return details;
  }

  async function syncProfile(profileId: string, onlySite: string | null): Promise<ChromeSyncCounts> {
    const previous = running.get(profileId);
    const next = (previous ?? Promise.resolve()).catch(() => undefined).then(() => syncNow(profileId, onlySite));
    running.set(profileId, next);
    try {
      return await next;
    } finally {
      if (running.get(profileId) === next) running.delete(profileId);
    }
  }

  async function syncNow(profileId: string, onlySite: string | null): Promise<ChromeSyncCounts> {
    const link = readLink(profileId);
    if (!link) throw new Error(sourceText("error.backend.chromeImportNotLinked"));
    if (!deps.profileExists(profileId)) throw new Error(sourceText("error.backend.browserProfileNotFound"));
    if (!cookieFile(link.chromeDir)) throw new Error(sourceText("error.backend.chromeImportProfileMissing"));
    const sites = link.sites ? new Set(link.sites) : null;
    const chrome = await readChromeCookies(
      link.chromeDir,
      (site) => (onlySite === null || site === onlySite) && (sites === null || sites.has(site) || onlySite !== null),
    );
    follow(profileId);
    const cookies = deps.profileCookies(profileId);
    const local = new Map<string, Cookie>();
    for (const cookie of await cookies.get({})) {
      if (cookie.domain) local.set(cookieKey(cookie.domain, cookie.name, cookie.path ?? "/"), cookie);
    }
    const counts = emptyCounts();
    const pending = new Set<string>();
    writing.set(profileId, pending);
    try {
      for (const cookie of chrome) {
        const note = link.cookies[cookie.key];
        const mine = local.get(cookie.key);
        const localChange = note?.local ?? 0;
        if (mine && mine.value === cookie.value) {
          counts.unchanged += 1;
          link.cookies[cookie.key] = { ...note, chrome: Math.max(note?.chrome ?? 0, cookie.updatedAt) };
          continue;
        }
        // OpenBot changed (or removed) it after Chrome's last change: OpenBot's copy is newer.
        if (localChange > cookie.updatedAt) {
          counts.kept += 1;
          continue;
        }
        pending.add(cookie.key);
        try {
          await cookies.set(setDetails(cookie));
          link.cookies[cookie.key] = { chrome: cookie.updatedAt };
          if (mine) counts.updated += 1;
          else counts.added += 1;
        } catch {
          counts.skipped += 1;
        }
      }
      await cookies.flushStore();
    } finally {
      // The changed events of the writes arrive after `set`; keep the guard for them a moment.
      setTimeout(() => {
        if (writing.get(profileId) === pending) writing.delete(profileId);
      }, 1_000);
    }
    link.lastSyncAt = Date.now();
    loaded.set(profileId, link);
    dirty.add(profileId);
    saveNow();
    return counts;
  }

  async function importProfiles(input: ImportChromeProfilesInput): Promise<ChromeImportResult> {
    const known = new Map(chromeProfiles().map((profile) => [profile.dir, profile]));
    // The user confirms first, then each browser's Keychain key is read before any profile is made,
    // so a refusal leaves nothing behind.
    await deps.confirmUser?.();
    for (const wanted of input.profiles) await chromeKey(wanted.dir);
    const profiles: ChromeImportResult["profiles"] = [];
    for (const wanted of input.profiles) {
      const chrome = known.get(wanted.dir);
      if (!chrome) throw new Error(sourceText("error.backend.chromeImportProfileMissing"));
      // A browser profile imported before is synced again, with the sites chosen now: no duplicate.
      const linkedId = links().find((link) => link.chromeDir === wanted.dir)?.profileId;
      const existing = linkedId ? readLink(linkedId) : undefined;
      if (linkedId && existing) {
        existing.sites = wanted.sites ? [...new Set(wanted.sites)] : null;
        dirty.add(linkedId);
        saveNow();
        const counts = await syncProfile(linkedId, null);
        profiles.push({ profileId: linkedId, name: deps.profileName?.(linkedId) ?? chrome.name, counts });
        continue;
      }
      const created = await deps.createProfile(chrome.name.trim().slice(0, 60) || chrome.dir);
      const link: LinkFile = {
        chromeDir: chrome.dir,
        chromeName: chrome.name,
        browser: chrome.browser,
        email: chrome.email,
        sites: wanted.sites ? [...new Set(wanted.sites)] : null,
        lastSyncAt: null,
        cookies: {},
      };
      loaded.set(created.id, link);
      dirty.add(created.id);
      saveNow();
      try {
        const counts = await syncProfile(created.id, null);
        profiles.push({ profileId: created.id, name: created.name, counts });
      } catch (error) {
        // An empty profile that is not linked helps nobody: remove it, then report the failure.
        forget(created.id);
        await deps.deleteProfile(created.id).catch(() => undefined);
        throw error;
      }
    }
    return { profiles };
  }

  /** Drops the link of a profile, for example one deleted in the settings. */
  function forget(profileId: string): void {
    loaded.delete(profileId);
    dirty.delete(profileId);
    const listened = followed.get(profileId);
    if (listened) listened.cookies.removeListener("changed", listened.listener);
    followed.delete(profileId);
    rmSync(linkPath(profileId), { force: true });
  }

  function links(): ChromeLink[] {
    return linkedProfileIds().flatMap((profileId) => {
      if (!deps.profileExists(profileId)) {
        forget(profileId);
        return [];
      }
      const link = readLink(profileId);
      if (!link) return [];
      return [
        {
          profileId,
          chromeDir: link.chromeDir,
          chromeName: link.chromeName,
          browser: link.browser,
          email: link.email,
          sites: link.sites,
          lastSyncAt: link.lastSyncAt,
          chromeMissing: cookieFile(link.chromeDir) === null,
        },
      ];
    });
  }

  function siteOfUrl(url: string): string | null {
    try {
      const host = new URL(url).hostname;
      return host ? siteOfHost(host) : null;
    } catch {
      return null;
    }
  }

  /** True when an import wrote a cookie of this site into the linked profile. */
  function linkHasSite(link: LinkFile, site: string): boolean {
    return Object.keys(link.cookies).some((key) => siteOfHost(key.slice(0, key.indexOf("\t"))) === site);
  }

  function profileWithSite(profileIds: readonly string[], url: string): string | undefined {
    const site = siteOfUrl(url);
    if (!site) return undefined;
    return profileIds.find((profileId) => {
      const link = deps.profileExists(profileId) ? readLink(profileId) : undefined;
      return link !== undefined && linkHasSite(link, site);
    });
  }

  /**
   * The linked profile whose Chrome a tab takes its sign-in from: the tab's own profile, else a profile
   * of its agent that holds that site (the tab is then in a session that is not linked).
   */
  function signInSource(tabId: string): { site: string; profileId: string; own: boolean } | null {
    const tab = deps.tab(tabId);
    const site = tab ? siteOfUrl(tab.url) : null;
    if (!tab || !site) return null;
    if (tab.profileId && readLink(tab.profileId)) return { site, profileId: tab.profileId, own: true };
    const profileId = tab.agentId ? profileWithSite(deps.agentProfileIds(tab.agentId), tab.url) : undefined;
    return profileId ? { site, profileId, own: false } : null;
  }

  function signInSite(tabId: string): string | null {
    return signInSource(tabId)?.site ?? null;
  }

  /** Copies Chrome's cookies of one site into the session of a tab that no Chrome profile links. */
  async function copySiteToTab(profileId: string, site: string, tabId: string): Promise<ChromeSyncCounts> {
    const link = readLink(profileId);
    if (!link) throw new Error(sourceText("error.backend.chromeImportNotLinked"));
    if (!cookieFile(link.chromeDir)) throw new Error(sourceText("error.backend.chromeImportProfileMissing"));
    const target = deps.tabCookies(tabId);
    if (!target) throw new Error(sourceText("error.backend.chromeImportNotLinked"));
    const chrome = await readChromeCookies(link.chromeDir, (candidate) => candidate === site);
    const local = new Map<string, string>();
    for (const cookie of await target.get({})) {
      if (cookie.domain) local.set(cookieKey(cookie.domain, cookie.name, cookie.path ?? "/"), cookie.value);
    }
    const counts = emptyCounts();
    for (const cookie of chrome) {
      const mine = local.get(cookie.key);
      if (mine === cookie.value) {
        counts.unchanged += 1;
        continue;
      }
      try {
        await target.set(setDetails(cookie));
        if (mine === undefined) counts.added += 1;
        else counts.updated += 1;
      } catch {
        counts.skipped += 1;
      }
    }
    await target.flushStore();
    return counts;
  }

  async function signInTab(tabId: string): Promise<ChromeSignInResult> {
    const source = signInSource(tabId);
    if (!source) throw new Error(sourceText("error.backend.chromeImportNotLinked"));
    const { site, profileId } = source;
    const counts = source.own ? await syncProfile(profileId, site) : await copySiteToTab(profileId, site, tabId);
    if (counts.added + counts.updated + counts.unchanged === 0)
      throw new Error(sourceText("error.backend.chromeImportNoSignIn", { site }));
    await deps.reloadTab(tabId);
    return { site, counts };
  }

  function readChoices(): Map<string, string[]> {
    try {
      return decodeChoicesFile(JSON.parse(readFileSync(choicesFile, "utf8")));
    } catch {
      // No file yet: no agent has other profiles.
      return new Map();
    }
  }

  function agentChoices(agentId: string): string[] {
    return (readChoices().get(agentId) ?? []).filter((profileId) => deps.profileExists(profileId));
  }

  function setAgentChoices(input: AgentBrowserProfileChoices): AgentBrowserProfileChoices {
    const all = readChoices();
    const profileIds = [...new Set(input.profileIds)].filter((profileId) => deps.profileExists(profileId));
    if (profileIds.length) all.set(input.agentId, profileIds);
    else all.delete(input.agentId);
    writeFileSync(choicesFile, JSON.stringify(Object.fromEntries(all)), { mode: 0o600 });
    return { agentId: input.agentId, profileIds };
  }

  return {
    listProfiles,
    listSites,
    importProfiles,
    links,
    resync: (profileId) => syncProfile(profileId, null),
    signInTab,
    signInSite,
    profileWithSite,
    agentChoices,
    setAgentChoices,
    dispose() {
      for (const { cookies, listener } of followed.values()) cookies.removeListener("changed", listener);
      followed.clear();
      saveNow();
    },
  };
}
