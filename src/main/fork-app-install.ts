// Fork (docs/fork/FEATURES.md #123): install a saved app on this computer. On macOS a small bundle in
// ~/Applications/OpenBot Apps/<Name>.app whose launcher hands openbot://app/<id>?window=1 to OpenBot; on Windows a
// Start menu shortcut in "OpenBot Apps"; and, when asked, a copy of either on the Desktop. Linux is not supported.
// Adapted from OpenMausBot electron/app-install (Apache-2.0). No Electron here, so the node tests can run it.
//
// Security invariants: an app id is checked (SAVED_APP_ID) before it reaches any file name or shell text; shell text
// is single-quoted and plist text XML-escaped; nothing is written outside the launcher folder, the Desktop folder and
// the install state folder; an existing file is replaced or removed only when it carries this app's id marker (a
// bundle's Info.plist key, a shortcut's argument) and is no symbolic link; the Desktop folder is never created and is
// read only once a Desktop item exists. Every operation runs one at a time.

import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import nodePath from "node:path";
import { isSavedAppId, savedAppLink } from "@openbot/contracts/fork-saved-apps";
import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";

export const SAVED_APP_FOLDER_NAME = "OpenBot Apps";
/** electron-builder's appId: the host's bundle id when the running app's Info.plist cannot be read. */
export const SAVED_APP_HOST_BUNDLE_ID = "app.openbot.desktop";
export const MAC_ID_KEY = "OpenBotSavedApp";
const MAC_EXECUTABLE = "launcher";
const MAC_ICON = "AppIcon";
const MANIFEST = "installed.json";
const MAX_ICON_BYTES = 2 * 1024 * 1024;
const BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9.-]{0,154}$/u;
const STAGING = /^\.openbot-[0-9a-f]{16}\.staging$/u;

export const validBundleId = (id: unknown): id is string => isString(id) && BUNDLE_ID.test(id) && !id.includes("..");

export const savedAppKey = (id: string) =>
  createHash("sha256").update(`openbot-saved-app\n${id}`).digest("hex").slice(0, 16);

export const savedAppBundleId = (id: string, host: string) =>
  `${validBundleId(host) ? host : SAVED_APP_HOST_BUNDLE_ID}.savedapp.${savedAppKey(id)}`;

const windowsAppUserModelId = (id: string) => `${SAVED_APP_HOST_BUNDLE_ID}.savedapp.${savedAppKey(id)}`;

/** The link every launcher opens: the app in a window of its own. */
function savedAppLauncherLink(id: string): string {
  return savedAppLink(id, true);
}

// ---- Names ----

const RESERVED_WINDOWS = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)$/iu;
const MAX_GRAPHEMES = 64;
const MAX_BYTES = 180;

function shorten(name: string): string {
  let out = "";
  let count = 0;
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(name)) {
    if (count === MAX_GRAPHEMES || Buffer.byteLength(out + segment) > MAX_BYTES) break;
    out += segment;
    count += 1;
  }
  return out;
}

/**
 * One file name every target file system accepts: no control, bidirectional or zero-width characters, none of
 * `\ / : * ? " < > |`, no leading dot, no trailing dot or space, no reserved Windows device name, at most 64
 * characters and 180 UTF-8 bytes. Never empty.
 */
export function launcherName(raw: unknown): string {
  let name = (isString(raw) ? raw : "")
    .normalize("NFC")
    .replace(/[\t\n\v\f\r\u0085\u2028\u2029]/gu, " ")
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .replace(/[\\/:*?"<>|]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/^[.\s]+/u, "");
  name = shorten(name).replace(/[.\s]+$/u, "");
  const dot = name.indexOf(".");
  const stem = dot === -1 ? name : name.slice(0, dot);
  if (RESERVED_WINDOWS.test(stem.trimEnd())) name = `${stem.trimEnd()}_${dot === -1 ? "" : name.slice(dot)}`;
  return name || "App";
}

/** macOS and Windows compare file names without case and, on macOS, without Unicode form. */
const nameKey = (name: string) => name.normalize("NFD").toLocaleLowerCase("en-US");

/** `base`, then `base 2`, `base 3`… until `free` says yes; null when none of 99 is free. */
async function firstFreeName(base: string, free: (name: string) => Promise<boolean>): Promise<string | null> {
  for (let n = 1; n < 100; n += 1) {
    const candidate = n === 1 ? base : `${base} ${n}`;
    if (await free(candidate)) return candidate;
  }
  return null;
}

// ---- Launcher text ----

const xml = (value: string) =>
  value.replace(/[&<>"']/gu, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&apos;",
  );

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** LSUIElement: the launcher hands the link to OpenBot and exits, so it never shows a Dock tile of its own. */
export function macInfoPlist(input: { id: string; name: string; hostBundleId: string; icon: boolean }): string {
  if (!isSavedAppId(input.id)) throw new Error("Invalid app id.");
  const entries: [string, string][] = [
    ["CFBundleDevelopmentRegion", "en"],
    ["CFBundleDisplayName", input.name],
    ["CFBundleExecutable", MAC_EXECUTABLE],
    ...(input.icon ? ([["CFBundleIconFile", MAC_ICON]] satisfies [string, string][]) : []),
    ["CFBundleIdentifier", savedAppBundleId(input.id, input.hostBundleId)],
    ["CFBundleInfoDictionaryVersion", "6.0"],
    ["CFBundleName", input.name],
    ["CFBundlePackageType", "APPL"],
    ["CFBundleShortVersionString", "1.0"],
    ["CFBundleVersion", "1"],
    [MAC_ID_KEY, input.id],
  ];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    ...entries.map(([key, value]) => `  <key>${key}</key>\n  <string>${xml(value)}</string>`),
    "  <key>LSUIElement</key>\n  <true/>",
    "  <key>NSHighResolutionCapable</key>\n  <true/>",
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

/** The app id a launcher's Info.plist names, or null. */
export function macPlistAppId(text: string | null): string | null {
  const match = new RegExp(`<key>${MAC_ID_KEY}</key>\\s*<string>([A-Za-z0-9_-]+)</string>`, "u").exec(text ?? "");
  const id = match?.[1];
  return isSavedAppId(id) ? id : null;
}

/** `open -b` finds OpenBot by bundle id wherever it is and starts it when needed; plain `open` is the fallback. */
export function macLauncherScript(input: { id: string; hostBundleId: string }): string {
  const link = shellQuote(savedAppLauncherLink(input.id));
  const host = shellQuote(validBundleId(input.hostBundleId) ? input.hostBundleId : SAVED_APP_HOST_BUNDLE_ID);
  return `#!/bin/sh\n/usr/bin/open -b ${host} ${link} 2>/dev/null || exec /usr/bin/open ${link}\n`;
}

export interface ShortcutOptions {
  target: string;
  args: string;
  description: string;
  icon?: string;
  iconIndex?: number;
  appUserModelId: string;
}

/** Electron's `shell.writeShortcutLink` options: OpenBot's executable with the link as its one argument. */
function windowsShortcut(input: { id: string; name: string; executable: string; iconPath?: string }) {
  return {
    target: input.executable,
    args: savedAppLauncherLink(input.id),
    description: input.name,
    ...(input.iconPath ? { icon: input.iconPath, iconIndex: 0 } : {}),
    appUserModelId: windowsAppUserModelId(input.id),
  } satisfies ShortcutOptions;
}

// ---- Icons ----

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** `{ width, height }` of a PNG within the limits, or null. */
function pngSize(bytes: Uint8Array | null): { width: number; height: number } | null {
  if (!bytes || bytes.byteLength < 33 || bytes.byteLength > MAX_ICON_BYTES) return null;
  const png = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (!png.subarray(0, 8).equals(PNG_SIGNATURE) || png.toString("latin1", 12, 16) !== "IHDR") return null;
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (width < 1 || height < 1 || width > 1024 || height > 1024) return null;
  return { width, height };
}

/** A Windows icon file holding one PNG image (Windows Vista and later read PNG entries). */
export function icoFromPng(png: Uint8Array): Buffer {
  const size = pngSize(png);
  if (!size) throw new Error("not a PNG");
  const header = Buffer.alloc(22);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  header.writeUInt8(size.width >= 256 ? 0 : size.width, 6);
  header.writeUInt8(size.height >= 256 ? 0 : size.height, 7);
  header.writeUInt16LE(1, 10);
  header.writeUInt16LE(32, 12);
  header.writeUInt32LE(png.byteLength, 14);
  header.writeUInt32LE(22, 18);
  return Buffer.concat([header, Buffer.from(png)]);
}

/** The files iconutil reads from a .iconset, up to the 256 pixel source. */
const MAC_ICONSET = [16, 32, 128, 256].flatMap((side) => [
  { file: `icon_${side}x${side}.png`, px: side },
  ...(side * 2 <= 256 ? [{ file: `icon_${side}x${side}@2x.png`, px: side * 2 }] : []),
]);

// ---- The installer ----

type FileKind = "bundle" | "shortcut" | "icon";

interface InstalledFile {
  path: string;
  kind: FileKind;
  desktop?: true;
}

interface InstalledEntry {
  name: string;
  files: InstalledFile[];
}

interface Manifest {
  version: 1;
  apps: Record<string, InstalledEntry>;
}

export interface InstalledSavedApp {
  id: string;
  name: string;
  desktop: boolean;
}

export type SavedAppInstallUnavailable = "linux" | "dev" | "unsupported";

export type SavedAppInstallFailure = "unavailable" | "invalid-id" | "not-installed" | "no-desktop" | "taken" | "failed";

export type InstallOutcome =
  | { ok: true; app: InstalledSavedApp }
  | { ok: true; removed: boolean; left?: string[] }
  | { ok: false; reason: SavedAppInstallFailure };

export interface SavedAppInstallerShell {
  trashItem?: (path: string) => Promise<void>;
  writeShortcutLink?: (path: string, operation: "create" | "replace", options: ShortcutOptions) => boolean;
  readShortcutLink?: (path: string) => { args?: string };
}

export interface SavedAppInstallerOptions {
  platform: NodeJS.Platform;
  /** Where installed.json, the icons and the work folder live (userData/saved-apps). */
  stateDir: string;
  /** ~/Applications/OpenBot Apps, or the Start menu's OpenBot Apps folder. */
  launchersDir: string;
  /** The Desktop folder; null when there is none. Never created. */
  desktopDir: string | null;
  /** OpenBot's executable (the Windows shortcut target). */
  executable: string;
  hostBundleId: string;
  /** null: available; else why not. */
  unavailable: SavedAppInstallUnavailable | null;
  /** Runs sips and iconutil. */
  run?: (file: string, args: string[]) => Promise<{ code: number }>;
  shell?: SavedAppInstallerShell;
  path?: nodePath.PlatformPath;
  log?: (line: string) => void;
}

export type SavedAppInstaller = ReturnType<typeof createSavedAppInstaller>;

const KINDS: readonly FileKind[] = ["bundle", "shortcut", "icon"];

function readFileEntry(value: unknown): InstalledFile | null {
  if (!isDynamicRecord(value) || !isString(value.path)) return null;
  const kind = KINDS.find((one) => one === value.kind);
  if (!kind) return null;
  const file: InstalledFile = { path: value.path, kind };
  if (value.desktop === true) file.desktop = true;
  return file;
}

export function createSavedAppInstaller(options: SavedAppInstallerOptions) {
  const path = options.path ?? nodePath;
  const { platform, stateDir, launchersDir } = options;
  const shell = options.shell ?? {};
  const log = options.log ?? (() => {});
  const enabled =
    options.unavailable === null &&
    (platform === "darwin" || (platform === "win32" && typeof shell.writeShortcutLink === "function"));
  const manifestFile = path.join(stateDir, MANIFEST);
  const iconsDir = path.join(stateDir, "icons");
  /** The Desktop folder as last resolved; null when there is none or it was not needed yet. */
  let desktopRoot: string | null = null;

  const childOf = (dir: string | null, file: string) => {
    if (!dir) return false;
    const rel = path.relative(dir, file);
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel) && !rel.includes(path.sep);
  };
  const allowed = (file: string) =>
    childOf(launchersDir, file) || childOf(iconsDir, file) || childOf(desktopRoot, file);

  const lstatOrNull = async (file: string) => lstat(file).catch(() => null);
  const readText = async (file: string) => readFile(file, "utf8").catch(() => null);
  const readBytes = async (file: string) => readFile(file).catch(() => null);

  async function readManifest(): Promise<Manifest> {
    const text = await readText(manifestFile);
    if (text === null) return { version: 1, apps: {} };
    try {
      const parsed = JSON.parse(text);
      if (isDynamicRecord(parsed) && parsed.version === 1 && isDynamicRecord(parsed.apps)) {
        const apps: Record<string, InstalledEntry> = {};
        for (const [id, entry] of Object.entries(parsed.apps)) {
          if (!isSavedAppId(id) || !isDynamicRecord(entry) || !isString(entry.name) || !Array.isArray(entry.files))
            continue;
          const files = entry.files.map(readFileEntry).filter((file) => file !== null);
          apps[id] = { name: entry.name, files };
        }
        return { version: 1, apps };
      }
    } catch {}
    log("[saved-app-install] the list of installed launchers was unreadable; starting it again");
    return { version: 1, apps: {} };
  }

  async function writeManifest(manifest: Manifest): Promise<void> {
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    const temporary = `${manifestFile}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, manifestFile);
  }

  /** Whether `file` is a launcher written for `id`: no symbolic link, and the id marker inside. */
  async function ownedBy(id: string, file: string, kind: FileKind): Promise<boolean> {
    const info = await lstatOrNull(file);
    if (!info || info.isSymbolicLink()) return false;
    if (kind === "bundle")
      return info.isDirectory() && macPlistAppId(await readText(path.join(file, "Contents", "Info.plist"))) === id;
    if (kind === "shortcut") {
      try {
        return info.isFile() && (shell.readShortcutLink?.(file)?.args ?? "").trim() === savedAppLauncherLink(id);
      } catch {
        return false;
      }
    }
    return info.isFile() && path.basename(file).startsWith(savedAppKey(id));
  }

  /** A real folder (no symbolic link) that is there, made when `create`. */
  async function realFolder(dir: string, create: boolean): Promise<boolean> {
    if (create) await mkdir(dir, { recursive: true });
    const info = await lstatOrNull(dir);
    return Boolean(info?.isDirectory() && !info.isSymbolicLink());
  }

  /** The first free `<name><ext>` in `dir`: absent, or already this app's own; another app's chosen name is skipped. */
  function chooseName(manifest: Manifest, id: string, dir: string, base: string, ext: string, kind: FileKind) {
    const others = new Set(
      Object.entries(manifest.apps)
        .filter(([other]) => other !== id)
        .flatMap(([, entry]) =>
          entry.files
            .filter((file) => file.kind === kind && nameKey(path.dirname(file.path)) === nameKey(dir))
            .map((file) => nameKey(path.basename(file.path))),
        ),
    );
    return firstFreeName(base, async (candidate) => {
      const file = path.join(dir, `${candidate}${ext}`);
      if (others.has(nameKey(`${candidate}${ext}`))) return false;
      return !(await lstatOrNull(file)) || ownedBy(id, file, kind);
    });
  }

  async function removeOwned(id: string, file: InstalledFile): Promise<boolean> {
    if (!allowed(file.path)) {
      log(`[saved-app-install] left ${file.path}: outside the launcher folders`);
      return false;
    }
    if (!(await lstatOrNull(file.path))) return true;
    if (!(await ownedBy(id, file.path, file.kind))) {
      log(`[saved-app-install] left ${file.path}: not a launcher written for ${id}`);
      return false;
    }
    if (file.kind === "bundle" && shell.trashItem) {
      try {
        await shell.trashItem(file.path);
        return true;
      } catch {}
    }
    await rm(file.path, { recursive: file.kind === "bundle", force: true });
    return true;
  }

  /** The app's icon PNG: the one given (kept for later), else the one kept from before. */
  async function iconPng(id: string, given: Uint8Array | null): Promise<Uint8Array | null> {
    const kept = path.join(iconsDir, `${savedAppKey(id)}.png`);
    if (given && pngSize(given)) {
      await mkdir(iconsDir, { recursive: true, mode: 0o700 });
      await writeFile(kept, given, { mode: 0o600 });
      return given;
    }
    const bytes = await readBytes(kept);
    return bytes && pngSize(bytes) ? new Uint8Array(bytes) : null;
  }

  /** sips and iconutil ship with every macOS; when either fails the bundle has no icon of its own. */
  async function macIcon(id: string, png: Uint8Array | null, out: string): Promise<boolean> {
    if (!options.run || !png) return false;
    const work = path.join(stateDir, "work", savedAppKey(id));
    const iconset = path.join(work, "icon.iconset");
    try {
      await rm(work, { recursive: true, force: true });
      await mkdir(iconset, { recursive: true });
      const source = path.join(work, "source.png");
      await writeFile(source, png);
      for (const { file, px } of MAC_ICONSET) {
        const result = await options.run("/usr/bin/sips", [
          "-z",
          String(px),
          String(px),
          source,
          "--out",
          path.join(iconset, file),
        ]);
        if (result.code !== 0) return false;
      }
      const result = await options.run("/usr/bin/iconutil", ["-c", "icns", "-o", out, iconset]);
      return result.code === 0 && Boolean(await lstatOrNull(out));
    } catch (error) {
      log(`[saved-app-install] no icon for ${id}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    } finally {
      await rm(path.dirname(work), { recursive: true, force: true }).catch(() => {});
    }
  }

  /** Builds `<chosen>.app` beside its place and renames it in; null when that name is not this app's own. */
  async function placeMacBundle(
    id: string,
    dir: string,
    chosen: string,
    writeIcon: (out: string) => Promise<boolean>,
  ): Promise<string | null> {
    const bundle = path.join(dir, `${chosen}.app`);
    if (!allowed(bundle)) throw new Error("outside the launcher folders");
    const staging = path.join(dir, `.openbot-${savedAppKey(id)}.staging`);
    await rm(staging, { recursive: true, force: true });
    try {
      await mkdir(path.join(staging, "Contents", "MacOS"), { recursive: true });
      await mkdir(path.join(staging, "Contents", "Resources"), { recursive: true });
      const icon = await writeIcon(path.join(staging, "Contents", "Resources", `${MAC_ICON}.icns`));
      await writeFile(
        path.join(staging, "Contents", "Info.plist"),
        macInfoPlist({ id, name: chosen, hostBundleId: options.hostBundleId, icon }),
      );
      await writeFile(path.join(staging, "Contents", "PkgInfo"), "APPL????");
      await writeFile(
        path.join(staging, "Contents", "MacOS", MAC_EXECUTABLE),
        macLauncherScript({ id, hostBundleId: options.hostBundleId }),
        { mode: 0o755 },
      );
      if (await lstatOrNull(bundle)) {
        if (!(await ownedBy(id, bundle, "bundle"))) {
          await rm(staging, { recursive: true, force: true });
          return null;
        }
        await rm(bundle, { recursive: true, force: true });
      }
      await rename(staging, bundle);
      return bundle;
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  type Written = { name: string; files: InstalledFile[] } | { error: SavedAppInstallFailure };

  async function installMac(manifest: Manifest, id: string, name: string, png: Uint8Array | null): Promise<Written> {
    if (!(await realFolder(launchersDir, true))) return { error: "failed" };
    const chosen = await chooseName(manifest, id, launchersDir, name, ".app", "bundle");
    if (!chosen) return { error: "taken" };
    const bundle = await placeMacBundle(id, launchersDir, chosen, (out) => macIcon(id, png, out));
    return bundle ? { name: chosen, files: [{ path: bundle, kind: "bundle" }] } : { error: "taken" };
  }

  async function writeShortcut(
    manifest: Manifest,
    id: string,
    dir: string,
    name: string,
    iconPath: string | undefined,
  ): Promise<{ name: string; file: InstalledFile } | null> {
    const chosen = await chooseName(manifest, id, dir, name, ".lnk", "shortcut");
    if (!chosen) return null;
    const file = path.join(dir, `${chosen}.lnk`);
    if (!allowed(file)) throw new Error("outside the launcher folders");
    const exists = Boolean(await lstatOrNull(file));
    const shortcut = windowsShortcut({
      id,
      name: chosen,
      executable: options.executable,
      ...(iconPath ? { iconPath } : {}),
    });
    if (!shell.writeShortcutLink?.(file, exists ? "replace" : "create", shortcut))
      throw new Error(`Windows did not write ${file}`);
    return { name: chosen, file: { path: file, kind: "shortcut" } };
  }

  async function installWindows(
    manifest: Manifest,
    id: string,
    name: string,
    png: Uint8Array | null,
  ): Promise<Written> {
    if (!(await realFolder(launchersDir, true))) return { error: "failed" };
    let icon: InstalledFile | null = null;
    if (png) {
      try {
        const iconPath = path.join(iconsDir, `${savedAppKey(id)}.ico`);
        await writeFile(iconPath, icoFromPng(png));
        icon = { path: iconPath, kind: "icon" };
      } catch (error) {
        log(`[saved-app-install] no icon for ${id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const start = await writeShortcut(manifest, id, launchersDir, name, icon?.path);
    if (!start) return { error: "taken" };
    return { name: start.name, files: [start.file, ...(icon ? [icon] : [])] };
  }

  /** The Desktop folder when it is there as a real folder; never made. */
  async function resolveDesktop(): Promise<string | null> {
    const dir = options.desktopDir;
    if (!dir || !path.isAbsolute(dir)) {
      desktopRoot = null;
      return null;
    }
    const info = await stat(dir).catch(() => null);
    const link = await lstatOrNull(dir);
    desktopRoot = info?.isDirectory() && !link?.isSymbolicLink() ? path.resolve(dir) : null;
    return desktopRoot;
  }

  const isDesktop = (file: InstalledFile) => file.desktop === true;
  const launcherOf = (entry: InstalledEntry | undefined) =>
    entry?.files.find((file) => file.kind !== "icon" && !isDesktop(file)) ?? null;
  const ownedFile = async (id: string, file: InstalledFile | null) =>
    Boolean(file && (await ownedBy(id, file.path, file.kind)));
  async function onDesktop(id: string, entry: InstalledEntry | undefined): Promise<boolean> {
    if (!entry?.files.some(isDesktop)) return false;
    await resolveDesktop();
    for (const file of entry.files.filter(isDesktop))
      if (allowed(file.path) && (await ownedFile(id, file))) return true;
    return false;
  }

  /** The app's Desktop item from its installed entry. */
  async function writeDesktop(
    manifest: Manifest,
    id: string,
    entry: InstalledEntry,
  ): Promise<{ file: InstalledFile } | { error: SavedAppInstallFailure }> {
    const dir = await resolveDesktop();
    if (!dir) return { error: "no-desktop" };
    try {
      if (platform === "darwin") {
        const launcher = entry.files.find((file) => file.kind === "bundle" && !isDesktop(file))?.path;
        const icns = launcher
          ? await readBytes(path.join(launcher, "Contents", "Resources", `${MAC_ICON}.icns`))
          : null;
        const chosen = await chooseName(manifest, id, dir, entry.name, ".app", "bundle");
        if (!chosen) return { error: "taken" };
        const bundle = await placeMacBundle(id, dir, chosen, async (out) => {
          if (!icns) return false;
          await writeFile(out, icns);
          return true;
        });
        return bundle ? { file: { path: bundle, kind: "bundle", desktop: true } } : { error: "taken" };
      }
      const icon = entry.files.find((file) => file.kind === "icon")?.path;
      const written = await writeShortcut(manifest, id, dir, entry.name, icon);
      return written ? { file: { ...written.file, desktop: true } } : { error: "taken" };
    } catch (error) {
      log(`[saved-app-install] could not put ${id} on the Desktop: ${error instanceof Error ? error.message : error}`);
      return { error: "failed" };
    }
  }

  async function uninstallLocked(manifest: Manifest, id: string): Promise<InstallOutcome> {
    const entry = manifest.apps[id];
    if (!entry) return { ok: true, removed: false };
    if (entry.files.some(isDesktop)) await resolveDesktop();
    const left: string[] = [];
    for (const file of entry.files) if (!(await removeOwned(id, file).catch(() => false))) left.push(file.path);
    delete manifest.apps[id];
    await rm(path.join(iconsDir, `${savedAppKey(id)}.png`), { force: true }).catch(() => {});
    await writeManifest(manifest);
    return { ok: true, removed: true, ...(left.length ? { left } : {}) };
  }

  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const next = queue.then(task);
    queue = next.catch(() => {});
    return next;
  };

  const view = (id: string, entry: InstalledEntry, desktop: boolean): InstalledSavedApp => ({
    id,
    name: entry.name,
    desktop,
  });

  async function installLocked(
    manifest: Manifest,
    input: { id: string; name: string; iconPng: Uint8Array | null; desktop: boolean },
  ): Promise<InstallOutcome> {
    const { id } = input;
    const name = launcherName(input.name);
    const previous = manifest.apps[id];
    let written: Written;
    try {
      const png = await iconPng(id, input.iconPng);
      written =
        platform === "darwin"
          ? await installMac(manifest, id, name, png)
          : await installWindows(manifest, id, name, png);
    } catch (error) {
      log(`[saved-app-install] could not install ${id}: ${error instanceof Error ? error.message : String(error)}`);
      return { ok: false, reason: "failed" };
    }
    if ("error" in written) return { ok: false, reason: written.error };
    const files = [...written.files];
    const before = (previous?.files ?? []).filter(isDesktop);
    if (input.desktop || (await onDesktop(id, previous))) {
      const desktop = await writeDesktop(manifest, id, { name: written.name, files });
      if ("file" in desktop) files.push(desktop.file);
      else {
        log(`[saved-app-install] ${id} kept its Desktop item as it was: ${desktop.error}`);
        for (const file of before) if (await ownedFile(id, file)) files.push(file);
      }
    } else if (before.length) await resolveDesktop();
    // A new name: the new launcher is in place, so the old one goes now.
    const kept = new Set(files.map((file) => nameKey(file.path)));
    for (const file of previous?.files ?? [])
      if (!kept.has(nameKey(file.path))) await removeOwned(id, file).catch(() => false);
    manifest.apps[id] = { name: written.name, files };
    await writeManifest(manifest);
    return { ok: true, app: view(id, manifest.apps[id] ?? { name: written.name, files }, files.some(isDesktop)) };
  }

  return {
    unavailable: (): SavedAppInstallUnavailable | null =>
      enabled ? null : (options.unavailable ?? (platform === "linux" ? "linux" : "unsupported")),

    /** Installs (or reinstalls under a new name) the app's launcher; `desktop` also puts a copy on the Desktop. */
    installApp: (input: { id: string; name: string; iconPng?: Uint8Array | null; desktop?: boolean }) =>
      serial(async (): Promise<InstallOutcome> => {
        if (!enabled) return { ok: false, reason: "unavailable" };
        if (!isSavedAppId(input.id)) return { ok: false, reason: "invalid-id" };
        return installLocked(await readManifest(), {
          id: input.id,
          name: input.name,
          iconPng: input.iconPng ?? null,
          desktop: input.desktop === true,
        });
      }),

    /** Removes only this app's own launcher files; a bundle goes to the Trash when it can. */
    uninstallApp: (id: string) =>
      serial(async (): Promise<InstallOutcome> => {
        if (!isSavedAppId(id)) return { ok: false, reason: "invalid-id" };
        return uninstallLocked(await readManifest(), id);
      }),

    /** A copy on the Desktop; installs the app first when it is not installed. */
    addToDesktop: (input: { id: string; name: string; iconPng?: Uint8Array | null }) =>
      serial(async (): Promise<InstallOutcome> => {
        if (!enabled) return { ok: false, reason: "unavailable" };
        if (!isSavedAppId(input.id)) return { ok: false, reason: "invalid-id" };
        const manifest = await readManifest();
        const entry = manifest.apps[input.id];
        if (!entry || !(await ownedFile(input.id, launcherOf(entry)))) {
          if (!(await resolveDesktop())) return { ok: false, reason: "no-desktop" };
          return installLocked(manifest, { ...input, iconPng: input.iconPng ?? null, desktop: true });
        }
        if (await onDesktop(input.id, entry)) return { ok: true, app: view(input.id, entry, true) };
        const desktop = await writeDesktop(manifest, input.id, entry);
        if ("error" in desktop) return { ok: false, reason: desktop.error };
        entry.files = [...entry.files.filter((file) => !isDesktop(file)), desktop.file];
        await writeManifest(manifest);
        return { ok: true, app: view(input.id, entry, true) };
      }),

    /** Removes only this app's own Desktop item; the launcher stays. */
    removeFromDesktop: (id: string) =>
      serial(async (): Promise<InstallOutcome> => {
        if (!isSavedAppId(id)) return { ok: false, reason: "invalid-id" };
        const manifest = await readManifest();
        const entry = manifest.apps[id];
        const items = entry?.files.filter(isDesktop) ?? [];
        if (!entry || !items.length) return { ok: true, removed: false };
        await resolveDesktop();
        const left: string[] = [];
        for (const file of items) if (!(await removeOwned(id, file).catch(() => false))) left.push(file.path);
        entry.files = entry.files.filter((file) => !isDesktop(file));
        await writeManifest(manifest);
        return { ok: true, removed: true, ...(left.length ? { left } : {}) };
      }),

    /** The launchers still on disk as written, each `{ id, name, desktop }`. */
    installedApps: () =>
      serial(async (): Promise<InstalledSavedApp[]> => {
        if (!enabled) return [];
        const manifest = await readManifest();
        const out: InstalledSavedApp[] = [];
        for (const [id, entry] of Object.entries(manifest.apps))
          if (await ownedFile(id, launcherOf(entry))) out.push(view(id, entry, await onDesktop(id, entry)));
        return out;
      }),

    /** Uninstalls the launchers of apps no longer saved. `ids` must be the whole list as read; null removes nothing. */
    cleanup: (ids: readonly string[] | null) =>
      serial(async (): Promise<string[]> => {
        if (!Array.isArray(ids)) return [];
        const keep = new Set(ids);
        const manifest = await readManifest();
        const removed: string[] = [];
        for (const id of Object.keys(manifest.apps)) {
          if (keep.has(id)) continue;
          await uninstallLocked(manifest, id);
          removed.push(id);
        }
        await rm(path.join(stateDir, "work"), { recursive: true, force: true }).catch(() => {});
        const sweep = async (dir: string | null) => {
          if (!dir || platform !== "darwin") return;
          for (const name of await readdir(dir).catch(() => []))
            if (STAGING.test(name)) await rm(path.join(dir, name), { recursive: true, force: true }).catch(() => {});
        };
        await sweep(launchersDir);
        // Only where a Desktop item was made: reading the Desktop folder asks for access on macOS.
        if (Object.values(manifest.apps).some((entry) => entry.files.some(isDesktop)))
          await sweep(await resolveDesktop());
        return removed;
      }),
  };
}
