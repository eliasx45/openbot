/**
 * Fork: the MCP servers of Claude Code's user-level `mcpServers` (`~/.claude.json`), mirrored into the
 * MCP panel's list. See docs/fork/FEATURES.md entry 9.
 *
 * `~/.claude.json` stays the one source of truth. Nothing here writes it, and nothing here writes a
 * mirrored server to the database: each read of the list converts the file again (cached by the file's
 * modification time and size), so a server removed there is gone here, and a changed one changes here.
 * The env values and headers are kept in memory only and are registered for redaction like a stored
 * row's. The only state OpenBot keeps is the names the user switched off, in a small JSON file beside
 * the database, so that choice survives the next sync.
 *
 * Left out on purpose: project `.mcp.json` servers, project-scoped `projects.<path>.mcpServers`, and
 * plugin servers. Only the top-level `mcpServers` key is read.
 */

import { readFileSync, renameSync, type Stats, statSync, unwatchFile, watchFile, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import {
  CLAUDE_CODE_MCP_SERVER_ID_PREFIX,
  isMcpServerConfig,
  type McpKeyValue,
  type McpServerConfig,
  mcpConfigErrors,
  normalizeMcpConfig,
} from "@openbot/contracts/ipc";
import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import type { Logger } from "@openbot/logging";
import { registerMcpSecretValues } from "./mcp-redaction";

/** Where Claude Code keeps its user-level state, `CLAUDE_CONFIG_DIR` included as the CLI reads it. */
export function claudeCodeUserConfigPath(): string {
  const directory = process.env.CLAUDE_CONFIG_DIR?.trim();
  return directory ? join(directory, ".claude.json") : join(homedir(), ".claude.json");
}

/** The file that holds the names the user switched off, beside the database. `null` for a database in memory. */
export function claudeCodeMcpOffPath(databasePath: string): string | null {
  return isAbsolute(databasePath) ? join(dirname(databasePath), "fork-claude-code-mcp-off.json") : null;
}

interface Snapshot {
  stamp: string;
  servers: McpServerConfig[];
  /** Compares two reads; it holds secrets, so it is never logged. */
  fingerprint: string;
}

export class ClaudeCodeMcpMirror {
  readonly #configPath: string;
  readonly #offPath: string | null;
  readonly #logger: Pick<Logger, "warn" | "info">;
  readonly #off: Set<string>;
  /** Each skip is said once a process, keyed by name and reason. Names only: never a value. */
  readonly #reported = new Set<string>();
  #snapshot: Snapshot = { stamp: "", servers: [], fingerprint: "[]" };
  #listener: ((current: Stats, previous: Stats) => void) | null = null;
  #changed: (() => void) | null = null;
  /** Fork: servers that come from elsewhere than `~/.claude.json` (Composio), listed the same way. */
  readonly #extra: () => McpServerConfig[];

  constructor(options: {
    configPath: string;
    offPath: string | null;
    logger: Pick<Logger, "warn" | "info">;
    extra?: () => McpServerConfig[];
  }) {
    this.#configPath = options.configPath;
    this.#extra = options.extra ?? (() => []);
    this.#offPath = options.offPath;
    this.#logger = options.logger;
    this.#off = new Set(readOffNames(options.offPath));
  }

  /**
   * The mirrored servers that are not shadowed by a server the user made by hand (same name), with
   * the user's on/off choice, and no more than `room` of them: the panel's list has a limit.
   */
  list(handMadeNames: ReadonlySet<string>, room: number): McpServerConfig[] {
    const servers: McpServerConfig[] = [];
    const mirrored = this.#read().servers;
    const extra = this.#extra().filter((server) => !mirrored.some((item) => item.name === server.name));
    for (const server of [...mirrored, ...extra]) {
      if (handMadeNames.has(server.name)) {
        this.#report(server.name, "A panel server you made has this name; the Claude Code one is left out.");
        continue;
      }
      if (servers.length >= room) {
        this.#report(server.name, "The MCP server list is full; the Claude Code server is left out.");
        continue;
      }
      servers.push({ ...server, enabled: !this.#off.has(server.name) });
    }
    return servers;
  }

  /** Records the user's switch for a mirrored server, by name, so the next sync keeps it. */
  setEnabled(server: McpServerConfig, enabled: boolean): McpServerConfig {
    if (enabled) this.#off.delete(server.name);
    else this.#off.add(server.name);
    this.#writeOffNames();
    return { ...server, enabled };
  }

  /**
   * Calls `changed` when the mirrored part of `~/.claude.json` changes. `fs.watchFile` polls the file's
   * stat (no read) and survives the atomic rename Claude Code writes with; the file changes often for
   * other reasons, so only a different `mcpServers` result calls back.
   */
  watch(changed: () => void): void {
    if (this.#listener) return;
    this.#changed = changed;
    this.#read();
    this.#listener = () => {
      const before = this.#snapshot.fingerprint;
      if (this.#read().fingerprint !== before) changed();
    };
    watchFile(this.#configPath, { interval: 3000, persistent: false }, this.#listener);
  }

  /** Fork: an extra server changed (Composio's session is ready): agents get it at their next turn. */
  refresh(): void {
    this.#changed?.();
  }

  close(): void {
    if (!this.#listener) return;
    unwatchFile(this.#configPath, this.#listener);
    this.#listener = null;
  }

  #read(): Snapshot {
    let stats: Stats;
    try {
      stats = statSync(this.#configPath);
    } catch {
      // No Claude Code on this computer, or the file moved away for a moment: nothing is mirrored.
      if (this.#snapshot.stamp !== "missing") this.#snapshot = { stamp: "missing", servers: [], fingerprint: "[]" };
      return this.#snapshot;
    }
    const stamp = `${stats.mtimeMs}:${stats.size}`;
    if (stamp === this.#snapshot.stamp) return this.#snapshot;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.#configPath, "utf8"));
    } catch {
      // A write in progress. Keep the last good list; the next change of the file reads it again.
      this.#report("", "~/.claude.json cannot be read as JSON; the last Claude Code MCP list is kept.");
      return this.#snapshot;
    }
    const entries = isDynamicRecord(parsed) && isDynamicRecord(parsed.mcpServers) ? parsed.mcpServers : {};
    const servers: McpServerConfig[] = [];
    for (const [name, entry] of Object.entries(entries)) {
      const converted = toConfig(name, entry);
      if (isString(converted)) {
        this.#report(name, converted);
        continue;
      }
      registerMcpSecretValues(converted);
      servers.push(converted);
    }
    this.#snapshot = { stamp, servers, fingerprint: JSON.stringify(servers) };
    return this.#snapshot;
  }

  #writeOffNames(): void {
    const path = this.#offPath;
    if (!path) return;
    try {
      const temporary = `${path}.tmp`;
      writeFileSync(temporary, `${JSON.stringify([...this.#off].sort(), null, 2)}\n`, { mode: 0o600 });
      renameSync(temporary, path);
    } catch (error) {
      this.#logger.warn("The Claude Code MCP on/off choices were not saved.", {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  #report(name: string, reason: string): void {
    const key = `${name}\u0000${reason}`;
    if (this.#reported.has(key)) return;
    this.#reported.add(key);
    this.#logger.info("Claude Code MCP mirror skipped an entry.", { server: name, reason });
  }
}

function readOffNames(path: string | null): string[] {
  if (!path) return [];
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(value) ? value.filter(isString) : [];
  } catch {
    return [];
  }
}

/** One `mcpServers` entry as a panel row, or the reason it cannot be one. A reason never quotes a value. */
export function toConfig(name: string, entry: unknown): McpServerConfig | string {
  if (!isDynamicRecord(entry)) return "The entry is not an object.";
  const type = isString(entry.type)
    ? entry.type
    : isString(entry.command)
      ? "stdio"
      : isString(entry.url)
        ? "http"
        : "";
  const base: McpServerConfig = {
    id: `${CLAUDE_CODE_MCP_SERVER_ID_PREFIX}${name}`,
    name,
    transport: "stdio",
    enabled: true,
    command: "",
    args: [],
    env: [],
    envPassthrough: [],
    workingDirectory: "",
    url: "",
    headers: [],
  };
  let config: McpServerConfig;
  if (type === "stdio") {
    if (!isString(entry.command)) return "A stdio entry has no command.";
    const args = entry.args === undefined ? [] : entry.args;
    if (!Array.isArray(args) || !args.every(isString)) return "The args are not a list of strings.";
    const env = pairs(entry.env);
    if (!env) return "The env is not an object of strings.";
    config = { ...base, command: entry.command, args, env };
  } else if (type === "http") {
    if (!isString(entry.url)) return "An http entry has no url.";
    const headers = pairs(entry.headers);
    if (!headers) return "The headers are not an object of strings.";
    config = { ...base, transport: "http", url: entry.url, headers };
  } else {
    // The panel has stdio and Streamable HTTP only; an SSE server would not answer an http client.
    return `The transport "${type || "none"}" is not supported by the MCP panel.`;
  }
  const normalized = normalizeMcpConfig(config);
  const errors = mcpConfigErrors(normalized);
  const firstError = errors.name ?? errors.command ?? errors.url;
  if (firstError) return firstError;
  if (!isMcpServerConfig(normalized)) return "A value is past a limit of the MCP panel.";
  return normalized;
}

function pairs(value: unknown): McpKeyValue[] | null {
  if (value === undefined) return [];
  if (!isDynamicRecord(value)) return null;
  const result: McpKeyValue[] = [];
  for (const [key, item] of Object.entries(value)) {
    if (!isString(item)) return null;
    result.push({ key, value: item });
  }
  return result;
}
