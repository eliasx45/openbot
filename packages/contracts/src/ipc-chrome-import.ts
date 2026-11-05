/**
 * Fork (docs/fork/FEATURES.md entry 32): the sign-ins of Google Chrome on this computer, imported into
 * named browser profiles. Only this computer's own server has these calls: Chrome runs here.
 */

import { isIdentifier } from "./ipc-bounded-values";
import { type DynamicRecord, isDynamicRecord, isString } from "./runtime-values";

export interface ChromeProfileSummary {
  /** The browser and the folder of its profile, such as `chrome:Default` or `brave:Profile 1`. */
  dir: string;
  /** The browser's name, such as "Google Chrome". */
  browser: string;
  name: string;
  /** The Google account of the profile, or "". */
  email: string;
  cookies: number;
}

export interface ChromeProfileList {
  /** False when Chrome is not on this computer. */
  available: boolean;
  profiles: ChromeProfileSummary[];
}

export interface ChromeSite {
  /** The registrable domain, such as `google.com`. */
  site: string;
  cookies: number;
}

export interface ImportChromeProfilesInput {
  /** `sites` null: all sites. */
  profiles: { dir: string; sites: string[] | null }[];
}

export interface ChromeSyncCounts {
  /** New in OpenBot. */
  added: number;
  /** Newer in Chrome, so copied. */
  updated: number;
  /** Newer in OpenBot, so kept. */
  kept: number;
  unchanged: number;
  /** Electron refused them. */
  skipped: number;
}

export interface ChromeImportResult {
  profiles: { profileId: string; name: string; counts: ChromeSyncCounts }[];
}

export interface ChromeLink {
  profileId: string;
  chromeDir: string;
  chromeName: string;
  browser: string;
  email: string;
  sites: string[] | null;
  lastSyncAt: number | null;
  /** The Chrome profile is gone; the OpenBot profile keeps its cookies. */
  chromeMissing: boolean;
}

export interface ChromeSignInResult {
  site: string;
  counts: ChromeSyncCounts;
}

/** The named profiles an agent can also open tabs in, next to its own profile. */
export interface AgentBrowserProfileChoices {
  agentId: string;
  profileIds: string[];
}

function record(value: unknown, what: string): DynamicRecord {
  if (!isDynamicRecord(value)) throw new Error(`Invalid ${what}.`);
  return value;
}

function text(value: unknown, what: string): string {
  if (!isString(value)) throw new Error(`Invalid ${what}.`);
  return value;
}

function count(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`Invalid ${what}.`);
  return value;
}

function sites(value: unknown): string[] | null {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length > 10_000) throw new Error("Invalid Chrome sites.");
  return value.map((site) => text(site, "Chrome site"));
}

function profileIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error("Invalid browser profiles.");
  return value.map((id) => {
    if (!isIdentifier(id)) throw new Error("Invalid browser profile.");
    return id;
  });
}

export function decodeChromeProfileList(value: unknown): ChromeProfileList {
  const list = record(value, "Chrome profiles");
  if (typeof list.available !== "boolean" || !Array.isArray(list.profiles)) throw new Error("Invalid Chrome profiles.");
  return {
    available: list.available,
    profiles: list.profiles.map((entry) => {
      const profile = record(entry, "Chrome profile");
      return {
        dir: text(profile.dir, "Chrome profile"),
        browser: text(profile.browser, "Chrome profile"),
        name: text(profile.name, "Chrome profile"),
        email: text(profile.email, "Chrome profile"),
        cookies: count(profile.cookies, "Chrome profile"),
      };
    }),
  };
}

export function decodeChromeSites(value: unknown): ChromeSite[] {
  if (!Array.isArray(value)) throw new Error("Invalid Chrome sites.");
  return value.map((entry) => {
    const site = record(entry, "Chrome site");
    return { site: text(site.site, "Chrome site"), cookies: count(site.cookies, "Chrome site") };
  });
}

export function decodeChromeSyncCounts(value: unknown): ChromeSyncCounts {
  const counts = record(value, "Chrome sync");
  return {
    added: count(counts.added, "Chrome sync"),
    updated: count(counts.updated, "Chrome sync"),
    kept: count(counts.kept, "Chrome sync"),
    unchanged: count(counts.unchanged, "Chrome sync"),
    skipped: count(counts.skipped, "Chrome sync"),
  };
}

export function decodeChromeImportResult(value: unknown): ChromeImportResult {
  const result = record(value, "Chrome import");
  if (!Array.isArray(result.profiles)) throw new Error("Invalid Chrome import.");
  return {
    profiles: result.profiles.map((entry) => {
      const profile = record(entry, "Chrome import");
      if (!isIdentifier(profile.profileId)) throw new Error("Invalid Chrome import.");
      return {
        profileId: profile.profileId,
        name: text(profile.name, "Chrome import"),
        counts: decodeChromeSyncCounts(profile.counts),
      };
    }),
  };
}

export function decodeChromeLinks(value: unknown): ChromeLink[] {
  if (!Array.isArray(value)) throw new Error("Invalid Chrome links.");
  return value.map((entry) => {
    const link = record(entry, "Chrome link");
    if (!isIdentifier(link.profileId) || typeof link.chromeMissing !== "boolean")
      throw new Error("Invalid Chrome link.");
    return {
      profileId: link.profileId,
      chromeDir: text(link.chromeDir, "Chrome link"),
      chromeName: text(link.chromeName, "Chrome link"),
      browser: text(link.browser, "Chrome link"),
      email: text(link.email, "Chrome link"),
      sites: sites(link.sites),
      lastSyncAt: link.lastSyncAt === null ? null : count(link.lastSyncAt, "Chrome link"),
      chromeMissing: link.chromeMissing,
    };
  });
}

export function decodeChromeSignInResult(value: unknown): ChromeSignInResult {
  const result = record(value, "Chrome sign-in");
  return { site: text(result.site, "Chrome sign-in"), counts: decodeChromeSyncCounts(result.counts) };
}

export function decodeChromeSignInSite(value: unknown): string | null {
  return value === null ? null : text(value, "Chrome sign-in site");
}

export function decodeAgentBrowserProfileChoices(value: unknown): AgentBrowserProfileChoices {
  const choices = record(value, "agent browser profiles");
  if (!isIdentifier(choices.agentId)) throw new Error("Invalid agent browser profiles.");
  return { agentId: choices.agentId, profileIds: profileIds(choices.profileIds) };
}

export function parseImportChromeProfilesInput(value: unknown): ImportChromeProfilesInput {
  const input = record(value, "Chrome import");
  if (!Array.isArray(input.profiles) || input.profiles.length === 0 || input.profiles.length > 50)
    throw new Error("Invalid Chrome import.");
  return {
    profiles: input.profiles.map((entry) => {
      const profile = record(entry, "Chrome import");
      const dir = text(profile.dir, "Chrome profile");
      // A profile folder name, never a path.
      if (!dir || dir.includes("/") || dir.includes("\\") || dir.startsWith("."))
        throw new Error("Invalid Chrome profile.");
      return { dir, sites: sites(profile.sites) };
    }),
  };
}

export function parseChromeDir(value: unknown): string {
  const dir = text(value, "Chrome profile");
  if (!dir || dir.includes("/") || dir.includes("\\") || dir.startsWith("."))
    throw new Error("Invalid Chrome profile.");
  return dir;
}

export const parseAgentBrowserProfileChoices = decodeAgentBrowserProfileChoices;
