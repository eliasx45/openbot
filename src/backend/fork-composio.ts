/**
 * Fork (docs/fork/FEATURES.md, "Composio"): Elias's apps (Gmail, Calendar, GitHub, Notion… about
 * 1,000 of them) for every agent, through one Composio Tool Router session. For Elias alone: one
 * Composio user for the whole app, the same one Ghostpoint uses (`ghostpoint-<mac user>`), so an
 * app he connected there works here too.
 *
 * The key is Keychain service `COMPOSIO_API_KEY` (as Ghostpoint): a project key (`ak_…`, header
 * `x-api-key`) or a user key (`uak_…`, header `x-user-api-key`). It is read with `security` at
 * start, kept in memory, registered for redaction, and never written to a file. The session (id and
 * MCP URL, no key) is kept beside the database and reused while Composio still knows it.
 *
 * The session is an MCP server row named "composio" in the MCP panel, listed with the Claude Code
 * servers (read-only, on/off switch). Agents get Composio's meta tools: COMPOSIO_SEARCH_TOOLS,
 * COMPOSIO_GET_TOOL_SCHEMAS, COMPOSIO_MULTI_EXECUTE_TOOL and COMPOSIO_MANAGE_CONNECTIONS (which
 * gives a connect link for an app that is not connected yet; the agent gives it to the user).
 */

import { execFile } from "node:child_process";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import type { McpServerConfig } from "@openbot/contracts/ipc";
import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import type { Logger } from "@openbot/logging";
import { toConfig } from "./fork-claude-code-mcp";
import { registerMcpSecretValues } from "./mcp-redaction";

const API = "https://backend.composio.dev/api/v3.1";
const FILE = "fork-composio.json";
export const COMPOSIO_SERVER_NAME = "composio";

/** The line for the developer instructions, when the session is there. */
export const COMPOSIO_INSTRUCTIONS =
  "The user's apps (Gmail, Calendar, GitHub, Notion, Slack, Drive and about 1,000 more) are reachable through the composio MCP tools: find the right tool with COMPOSIO_SEARCH_TOOLS, read its arguments with COMPOSIO_GET_TOOL_SCHEMAS, then run it with COMPOSIO_MULTI_EXECUTE_TOOL. Use them before you tell the user you have no access to a service. When an app is not connected, COMPOSIO_MANAGE_CONNECTIONS gives its connect link: give the link to the user and wait. Ask before you send, post, delete or pay for the user unless they asked for it.";

type ComposioBody = Record<string, string | Record<string, boolean>>;

export class ForkComposio {
  readonly #file: string | null;
  readonly #logger: Pick<Logger, "warn" | "info">;
  #server: McpServerConfig | null = null;
  #onReady: (() => void) | null = null;

  constructor(options: { databasePath: string; logger: Pick<Logger, "warn" | "info"> }) {
    this.#file = options.databasePath.startsWith("/") ? join(dirname(options.databasePath), FILE) : null;
    this.#logger = options.logger;
  }

  /** The MCP row, once the session is ready. */
  servers(): McpServerConfig[] {
    return this.#server ? [this.#server] : [];
  }

  ready(): boolean {
    return this.#server !== null;
  }

  /** Reads the key and gets a session in the background; `onReady` runs when the row appears. */
  start(onReady: () => void): void {
    this.#onReady = onReady;
    void this.#connect();
  }

  async #connect(): Promise<void> {
    const key = await keychainKey();
    if (!key) {
      this.#logger.info("No Composio key in the Keychain (service COMPOSIO_API_KEY); Composio is off.");
      return;
    }
    const header = key.startsWith("uak_") ? "x-user-api-key" : "x-api-key";
    const call = async (method: string, path: string, body?: ComposioBody) => {
      const response = await fetch(`${API}/${path}`, {
        method,
        headers: { [header]: key, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) throw new Error(`Composio answered ${response.status} to ${method} ${path.split("/")[0]}`);
      const parsed = await response.json();
      if (!isDynamicRecord(parsed)) throw new Error(`Composio sent no object for ${method} ${path.split("/")[0]}`);
      return parsed;
    };
    try {
      let session = this.#saved();
      if (session) {
        // A session Composio no longer knows gets replaced.
        const found = await call("GET", `tool_router/session/${session.id}`).catch(() => null);
        if (!found) session = null;
      }
      if (!session) {
        const created = await call("POST", "tool_router/session", {
          user_id: composioUserId(),
          manage_connections: { enable: true },
          workbench: { enable: false },
          multi_account: { enable: true, require_explicit_selection: true },
        });
        const id = isString(created.session_id) ? created.session_id : null;
        const url = isDynamicRecord(created.mcp) && isString(created.mcp.url) ? created.mcp.url : null;
        if (!id || !url || !new URL(url).hostname.endsWith(".composio.dev"))
          throw new Error("Composio gave no session MCP URL.");
        session = { id, url };
        this.#save(session);
      }
      const config = toConfig(COMPOSIO_SERVER_NAME, { type: "http", url: session.url, headers: { [header]: key } });
      if (isString(config)) throw new Error(config);
      registerMcpSecretValues(config);
      this.#server = config;
      this.#logger.info("Composio is ready.");
      this.#onReady?.();
    } catch (error) {
      this.#logger.warn("Composio did not start.", { reason: error instanceof Error ? error.message : String(error) });
    }
  }

  #saved(): { id: string; url: string } | null {
    if (!this.#file) return null;
    try {
      const saved = JSON.parse(readFileSync(this.#file, "utf8"));
      return isDynamicRecord(saved) && isString(saved.id) && isString(saved.url)
        ? { id: saved.id, url: saved.url }
        : null;
    } catch {
      return null;
    }
  }

  #save(session: { id: string; url: string }): void {
    if (!this.#file) return;
    try {
      const temporary = `${this.#file}.tmp`;
      writeFileSync(temporary, JSON.stringify(session), { mode: 0o600 });
      renameSync(temporary, this.#file);
    } catch {}
  }
}

/** One Composio user for this Mac, shared with Ghostpoint. */
export function composioUserId(): string {
  const name = userInfo()
    .username.toLowerCase()
    .replace(/[^a-z0-9_-]/gu, "");
  return `ghostpoint-${name || "mac"}`;
}

function keychainKey(): Promise<string | null> {
  return new Promise((resolve) => {
    if (process.platform !== "darwin") {
      resolve(process.env.COMPOSIO_API_KEY?.trim() || null);
      return;
    }
    execFile(
      "/usr/bin/security",
      ["find-generic-password", "-s", "COMPOSIO_API_KEY", "-w"],
      { timeout: 10_000 },
      (error, stdout) => resolve(error ? process.env.COMPOSIO_API_KEY?.trim() || null : stdout.trim() || null),
    );
  });
}
