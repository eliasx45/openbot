/**
 * Fork (docs/fork/FEATURES.md, "Waits"): a wait that plain code watches. Upstream's waits
 * (`await_event`) wake only when a routine run or a script event comes; here the agent names a
 * condition with `openbot.wait_until` and ends its turn, and OpenBot checks it every 2 s: a file is
 * there and stopped changing, a process exited, another agent finished its work, a URL answers.
 * When it holds, or after the timeout (24 h at most), the wait closes and a new turn starts in the
 * agent's own chat, in the same provider session, so the agent still knows everything it knew.
 *
 * The wait is an ordinary open wait (`agent_waits`): the user sees it above the composer with
 * Cancel, and `list_waits` / `close_wait` work on it. What is watched is kept in a JSON file next
 * to the database, so waits survive a restart. A cancelled or closed wait is simply forgotten.
 */

import { readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type { AgentEvent, AgentWait } from "@openbot/contracts/ipc";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { z } from "zod";
import { type OpenBotToolResponse, openBotToolFailure, openBotToolResult } from "../agent/routine-tools";
import type { MailboxStore } from "../mailbox-store";
import type { DynamicToolCallParams } from "../protocol";
import { AgentWaitError, type AgentWaitStore } from "./agent-wait-store";

export const WAIT_UNTIL_TOOL = "wait_until";
/** The routine id that the wake delivery names. No routine has it; the prompt and chat read it as a wait. */
export const FORK_WAIT_ROUTINE_ID = "fork-wait";

const TICK_MS = 2_000;
const URL_EVERY_MS = 10_000;
const MAX_MINUTES = 24 * 60;
const FILE = "fork-wait-conditions.json";

export const waitUntilToolSchema = z.strictObject({
  note: z.string().trim().min(1).max(300).describe("What you wait for and what you will do next, in a few words."),
  file: z
    .string()
    .trim()
    .min(1)
    .max(4096)
    .optional()
    .describe("Absolute path. Done when the file is there and its size and time stop changing."),
  settleSeconds: z
    .number()
    .int()
    .min(1)
    .max(600)
    .optional()
    .describe("For file: how long it must stay unchanged. Default 5."),
  pid: z.number().int().positive().optional().describe("Done when this process is gone."),
  agentId: z
    .string()
    .trim()
    .min(1)
    .max(INPUT_LIMITS.identifier)
    .optional()
    .describe("Another local agent (id from list_agents). Done when it goes from working to idle."),
  url: z
    .string()
    .trim()
    .url()
    .max(2048)
    .optional()
    .describe("Done when this http(s) URL answers with a status below 500."),
  timeoutMinutes: z.number().int().min(1).max(MAX_MINUTES).optional().describe("Default and maximum 1440 (24 h)."),
});

type Condition =
  | { kind: "file"; path: string; settleSeconds: number; baseline: string | null; last: string | null; since: number }
  | { kind: "process"; pid: number }
  | { kind: "agent"; agentId: string; sawWorking: boolean }
  | { kind: "url"; url: string; checkedAt: number };

interface Watched {
  waitId: string;
  agentId: string;
  note: string;
  requestText: string;
  watching: string;
  deadline: number;
  condition: Condition;
}

export interface ForkWaitConditionsHooks {
  emit(event: AgentEvent): void;
  /** Throws when no local agent has this id. */
  requireKnownAgent(agentId: string): void;
  agentName(agentId: string): string;
  /** A turn runs or a message waits for the agent. */
  agentBusy(agentId: string): boolean;
  /** Starts a turn in the agent's own chat with this text. */
  wake(input: { agentId: string; waitId: string; title: string; text: string }): void;
  notify(title: string, body: string): void;
  isRunning(): boolean;
}

export class ForkWaitConditions {
  readonly #store: AgentWaitStore;
  readonly #mailbox: MailboxStore;
  readonly #hooks: ForkWaitConditionsHooks;
  readonly #file: string;
  readonly #watched = new Map<string, Watched>();
  readonly #timer: ReturnType<typeof setInterval>;
  #ticking = false;

  constructor(options: {
    store: AgentWaitStore;
    mailbox: MailboxStore;
    databasePath: string;
    hooks: ForkWaitConditionsHooks;
  }) {
    this.#store = options.store;
    this.#mailbox = options.mailbox;
    this.#hooks = options.hooks;
    this.#file = join(dirname(options.databasePath), FILE);
    try {
      const saved = JSON.parse(readFileSync(this.#file, "utf8"));
      const waits = isDynamicRecord(saved) && Array.isArray(saved.waits) ? saved.waits : [];
      for (const entry of waits) if (isWatchedEntry(entry)) this.#watched.set(entry.waitId, entry);
    } catch {}
    this.#timer = setInterval(() => void this.#tick(), TICK_MS);
    this.#timer.unref?.();
  }

  dispose(): void {
    clearInterval(this.#timer);
  }

  /** A routine run does not wake a watched wait: only its condition does. */
  isWatched(waitId: string): boolean {
    return this.#watched.has(waitId);
  }

  /** The condition of a watched wait, for `list_waits`. */
  watching(waitId: string): string | null {
    return this.#watched.get(waitId)?.watching ?? null;
  }

  handleTool(
    params: DynamicToolCallParams,
    caller: { agentId: string; inExecutionThread: boolean },
  ): OpenBotToolResponse | null {
    if (params.tool !== WAIT_UNTIL_TOOL) return null;
    const parsed = waitUntilToolSchema.safeParse(params.arguments);
    if (!parsed.success) return openBotToolFailure(z.prettifyError(parsed.error));
    const input = parsed.data;
    const given = [input.file, input.pid, input.agentId, input.url].filter((value) => value !== undefined);
    if (given.length !== 1) return openBotToolFailure("Give exactly one of file, pid, agentId or url.");
    if (caller.inExecutionThread)
      return openBotToolFailure("Open a wait only in your own chat: the wake starts a turn there.");
    if (input.agentId === caller.agentId) return openBotToolFailure("You cannot wait for yourself.");
    if (input.agentId !== undefined) {
      try {
        this.#hooks.requireKnownAgent(input.agentId);
      } catch (error) {
        return openBotToolFailure(error instanceof Error ? error.message : String(error));
      }
    }
    if (input.file !== undefined && !input.file.startsWith("/"))
      return openBotToolFailure("file must be an absolute path.");
    const deliveries = this.#mailbox.findDeliveriesByTurn(caller.agentId, params.turnId);
    const request =
      deliveries.findLast((context) => context.delivery.sender.kind === "user") ?? deliveries.at(0) ?? null;
    if (!request) return openBotToolFailure("No message of this turn to continue later.");
    const now = Date.now();
    let condition: Condition;
    let watching: string;
    if (input.file !== undefined) {
      const settle = input.settleSeconds ?? 5;
      const baseline = fileState(input.file);
      condition = { kind: "file", path: input.file, settleSeconds: settle, baseline, last: null, since: now };
      watching = `file ${input.file} (settled ${settle} s${baseline ? ", after it changes" : ""})`;
    } else if (input.pid !== undefined) {
      if (!processAlive(input.pid)) return openBotToolFailure(`No process ${input.pid} runs now.`);
      condition = { kind: "process", pid: input.pid };
      watching = `process ${input.pid} exits`;
    } else if (input.agentId !== undefined) {
      condition = { kind: "agent", agentId: input.agentId, sawWorking: this.#hooks.agentBusy(input.agentId) };
      watching = `agent ${this.#hooks.agentName(input.agentId)} finishes its work`;
    } else {
      const url = input.url ?? "";
      if (!/^https?:\/\//u.test(url)) return openBotToolFailure("url must be http or https.");
      condition = { kind: "url", url, checkedAt: 0 };
      watching = `${url} answers`;
    }
    const minutes = input.timeoutMinutes ?? MAX_MINUTES;
    let wait: AgentWait;
    try {
      wait = this.#store.open({
        agentId: caller.agentId,
        requestMessageId: request.delivery.id,
        requestText: request.delivery.text,
        note: `⏳ ${input.note} · ${watching}`.slice(0, INPUT_LIMITS.agentWaitNote),
        routineId: null,
      });
    } catch (error) {
      if (error instanceof AgentWaitError) return openBotToolFailure(error.message);
      throw error;
    }
    this.#watched.set(wait.id, {
      waitId: wait.id,
      agentId: caller.agentId,
      note: input.note,
      requestText: request.delivery.text,
      watching,
      deadline: now + minutes * 60_000,
      condition,
    });
    this.#save();
    this.#changed(caller.agentId);
    return openBotToolResult({
      waitId: wait.id,
      watching,
      timeoutAt: new Date(now + minutes * 60_000).toISOString(),
      next: "Tell the user in one line what you wait for, then end your turn now. Do not poll or sleep. OpenBot watches the condition and starts a new turn in this chat, in this same session, when it holds or times out. The user or openbot.close_wait can cancel it.",
    });
  }

  async #tick(): Promise<void> {
    if (this.#ticking || this.#watched.size === 0 || !this.#hooks.isRunning()) return;
    this.#ticking = true;
    try {
      let dirty = false;
      for (const watched of [...this.#watched.values()]) {
        // Cancelled by the user, or closed with close_wait: forget it, no wake.
        if (!this.#store.get(watched.agentId, watched.waitId)) {
          this.#watched.delete(watched.waitId);
          dirty = true;
          continue;
        }
        const now = Date.now();
        const result = await this.#check(watched, now);
        if (result.changed) dirty = true;
        if (result.done !== null) {
          this.#fire(watched, result.done, false);
          dirty = true;
        } else if (now >= watched.deadline) {
          this.#fire(watched, `timed out: ${watched.watching} did not happen in time`, true);
          dirty = true;
        }
      }
      if (dirty) this.#save();
    } finally {
      this.#ticking = false;
    }
  }

  async #check(watched: Watched, now: number): Promise<{ done: string | null; changed: boolean }> {
    const condition = watched.condition;
    switch (condition.kind) {
      case "file": {
        const state = fileState(condition.path);
        if (state === null || (condition.baseline !== null && state === condition.baseline)) {
          const changed = condition.last !== null;
          condition.last = null;
          return { done: null, changed };
        }
        if (state !== condition.last) {
          condition.last = state;
          condition.since = now;
          condition.baseline = null;
          return { done: null, changed: true };
        }
        if (now - condition.since >= condition.settleSeconds * 1000)
          return {
            done: `the file is there and unchanged for ${condition.settleSeconds} s (${state.split(":")[0]} bytes)`,
            changed: false,
          };
        return { done: null, changed: false };
      }
      case "process":
        return { done: processAlive(condition.pid) ? null : `process ${condition.pid} exited`, changed: false };
      case "agent": {
        const busy = this.#hooks.agentBusy(condition.agentId);
        if (busy && !condition.sawWorking) {
          condition.sawWorking = true;
          return { done: null, changed: true };
        }
        return {
          done:
            !busy && condition.sawWorking
              ? `${this.#hooks.agentName(condition.agentId)} finished its work and is idle`
              : null,
          changed: false,
        };
      }
      case "url": {
        if (now - condition.checkedAt < URL_EVERY_MS) return { done: null, changed: false };
        condition.checkedAt = now;
        try {
          const response = await fetch(condition.url, { method: "GET", signal: AbortSignal.timeout(5_000) });
          return {
            done: response.status < 500 ? `${condition.url} answered ${response.status}` : null,
            changed: false,
          };
        } catch {
          return { done: null, changed: false };
        }
      }
    }
  }

  #fire(watched: Watched, detail: string, timedOut: boolean): void {
    this.#watched.delete(watched.waitId);
    this.#store.delete(watched.agentId, watched.waitId);
    this.#changed(watched.agentId);
    // The message's routine name must fit the contract (80 characters), or the wake fails to decode.
    const title = shortName(`${timedOut ? "⌛ Wait timed out" : "⏳ Wait over"}: ${watched.note}`);
    const text = [
      `[OpenBot: ${timedOut ? "⌛ wait timed out" : "⏳ wait over"}] The wait you opened with openbot.${WAIT_UNTIL_TOOL} has ended. This is not a message from the user.`,
      `Your note: ${watched.note}`,
      `Watched: ${watched.watching}`,
      `Result: ${detail}`,
      "The request it continues:",
      watched.requestText,
      "",
      timedOut
        ? "Tell the user that the wait timed out and what you can do now."
        : "Continue that request now. This is the same chat and session: you know what you did before the wait.",
    ].join("\n");
    try {
      this.#hooks.wake({ agentId: watched.agentId, waitId: watched.waitId, title, text });
    } catch {}
    this.#hooks.notify(
      `${this.#hooks.agentName(watched.agentId)}: ${timedOut ? "wait timed out" : "wait over"}`,
      `${watched.note} — ${detail}`,
    );
  }

  #changed(agentId: string): void {
    this.#hooks.emit({ type: "waits-changed", snapshot: { agentId, waits: this.#store.list(agentId) } });
  }

  #save(): void {
    try {
      const temporary = `${this.#file}.tmp`;
      writeFileSync(temporary, JSON.stringify({ version: 1, waits: [...this.#watched.values()] }), { mode: 0o600 });
      renameSync(temporary, this.#file);
    } catch {}
  }
}

/** `size:mtime` of a file, or null when there is no file. */
function fileState(path: string): string | null {
  try {
    const info = statSync(path);
    return info.isFile() ? `${info.size}:${info.mtimeMs}` : null;
  } catch {
    return null;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it runs, as another user.
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

/** A saved entry this build can watch. The file is the fork's own; a broken entry is dropped. */
function isWatchedEntry(value: unknown): value is Watched {
  if (!isDynamicRecord(value) || !isDynamicRecord(value.condition)) return false;
  const kind = value.condition.kind;
  return (
    typeof value.waitId === "string" &&
    typeof value.agentId === "string" &&
    typeof value.note === "string" &&
    typeof value.requestText === "string" &&
    typeof value.watching === "string" &&
    typeof value.deadline === "number" &&
    (kind === "file" || kind === "process" || kind === "agent" || kind === "url")
  );
}

function shortName(text: string): string {
  if (text.length <= INPUT_LIMITS.routineName) return text;
  const cut = text.slice(0, INPUT_LIMITS.routineName - 1);
  return `${/[\uD800-\uDBFF]$/u.test(cut) ? cut.slice(0, -1) : cut}…`;
}
