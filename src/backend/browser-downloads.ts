import { existsSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * The download limits of all browser sessions, so that a page cannot fill the disk. No new download
 * starts while `BROWSER_DOWNLOAD_MAX_ACTIVE` are in progress, and a download larger than
 * `BROWSER_DOWNLOAD_MAX_BYTES` stops.
 */
export const BROWSER_DOWNLOAD_MAX_ACTIVE = 4;
export const BROWSER_DOWNLOAD_MAX_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * Where an agent's `download` call writes, before the server names the file. Only the agent tool makes
 * one: a download that a page starts always goes to the Downloads folder with a new name.
 */
export type BrowserDownloadTarget =
  | { kind: "directory"; directory: string; overwrite: boolean }
  | { kind: "file"; path: string; overwrite: boolean };

/** The server's file name without folders or characters that a file system can refuse. */
export function safeDownloadName(serverName: string): string {
  return basename(serverName).replace(/[^a-zA-Z0-9._ -]/g, "_") || `download-${Date.now()}`;
}

/** `name` in `root`, or `name (2)`, `name (3)`… when a file or another download has that path. */
export function uniqueDownloadPath(root: string, name: string, reserved: ReadonlySet<string>): string {
  const extension = extname(name);
  const stem = extension ? name.slice(0, -extension.length) : name;
  for (let suffix = 1; ; suffix += 1) {
    const candidate = join(root, suffix === 1 ? name : `${stem} (${suffix})${extension}`);
    if (!reserved.has(candidate) && !existsSync(candidate)) return candidate;
  }
}

/**
 * Checks the agent's `saveTo` before the request starts. An existing folder takes the server's file
 * name. Another path is the file itself: its folder must exist, and an existing file fails unless
 * `overwrite` is true. `writableRoots`, for an agent with Workspace access, are the folders that it
 * may write; the Downloads folder is always one of them.
 */
export async function resolveDownloadTarget(
  saveTo: string | undefined,
  overwrite: boolean,
  downloadsRoot: string,
  writableRoots?: readonly string[],
): Promise<BrowserDownloadTarget> {
  if (saveTo === undefined) return { kind: "directory", directory: downloadsRoot, overwrite: false };
  if (!isAbsolute(saveTo)) throw new Error(`saveTo must be an absolute path: ${saveTo}`);
  const requested = resolve(saveTo);
  const existing = await stat(requested).catch(() => null);
  let target: BrowserDownloadTarget;
  if (existing?.isDirectory()) {
    target = { kind: "directory", directory: await realpath(requested), overwrite };
  } else {
    if (existing && !existing.isFile()) throw new Error(`saveTo is not a file or a folder: ${saveTo}`);
    if (saveTo.endsWith(sep)) throw new Error(`The saveTo folder does not exist: ${saveTo}`);
    const folder = await realpath(dirname(requested)).catch(() => null);
    if (!folder || !(await stat(folder)).isDirectory())
      throw new Error(`The folder of saveTo does not exist: ${dirname(requested)}`);
    const path = join(folder, basename(requested));
    if (existing && !overwrite)
      throw new Error(`A file already exists at ${path}. Pass overwrite: true to replace it, or choose another path.`);
    target = { kind: "file", path, overwrite };
  }
  if (writableRoots) {
    const folder = target.kind === "directory" ? target.directory : dirname(target.path);
    const roots = await Promise.all(
      [downloadsRoot, ...writableRoots].map((root) => realpath(root).catch(() => resolve(root))),
    );
    if (!roots.some((root) => isInside(root, folder)))
      throw new Error(
        "This agent has Workspace access: saveTo must be in its workspace, the shared folder, an added folder or the OpenBot Downloads folder.",
      );
  }
  return target;
}

/**
 * The save path of an agent download, chosen when the server sends the file name. The checks of
 * `resolveDownloadTarget` run again: a file can appear while the request waits for the response.
 */
export function agentDownloadPath(
  target: BrowserDownloadTarget,
  serverName: string,
  reserved: ReadonlySet<string>,
): string {
  if (target.kind === "directory") {
    const name = safeDownloadName(serverName);
    if (!target.overwrite) return uniqueDownloadPath(target.directory, name, reserved);
    const path = join(target.directory, name);
    if (reserved.has(path)) throw new Error(`Another download writes ${path} now.`);
    return path;
  }
  if (reserved.has(target.path)) throw new Error(`Another download writes ${target.path} now.`);
  if (!target.overwrite && existsSync(target.path))
    throw new Error(
      `A file already exists at ${target.path}. Pass overwrite: true to replace it, or choose another path.`,
    );
  return target.path;
}

function isInside(root: string, path: string): boolean {
  const offset = relative(root, path);
  return offset === "" || (offset !== ".." && !offset.startsWith(`..${sep}`) && !isAbsolute(offset));
}
