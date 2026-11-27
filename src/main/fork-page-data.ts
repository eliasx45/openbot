// Fork (docs/fork/FEATURES.md #123): openbotPage.data, live read-only SQL on OpenBot's shared tables for an agent's
// page. Security invariants: only a page made on this computer (an html_render call here) that declared
// `uses: ["data"]` in that call reads data; the declaration is kept here, keyed by the page's attachment id, where the
// page cannot write it; the ids come from the host (the renderer's own record of the page), never from the page; a
// saved app reads with the declaration of the version it shows; reads go through AgentTables' read-only checks and
// limits; each window and page has a call budget.

import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CHAT_VISUAL_DATA_TOO_MANY, CHAT_VISUAL_DATA_UNDECLARED } from "@openbot/contracts/chat-visual";
import {
  createRateLimiter,
  PAGE_DATA_RATES,
  type PageDataRequest,
  type PageStateReply,
  type PageStateTarget,
  type PageStateValue,
  type PageUse,
  pageUses,
} from "@openbot/contracts/fork-saved-apps";
import { isDynamicRecord, isNumber, isString } from "@openbot/contracts/runtime-values";

const USES_FILE = "page-uses.json";
const USES_MAX = 5_000;
/** The JSON of one answer's rows; AgentTables already stops at 500 rows and 256 KB of cells. */
export const PAGE_DATA_ANSWER_BYTES = 1024 * 1024;

export const PAGE_DATA_NOT_LOCAL = "Only pages made on this computer can read data.";
export const PAGE_DATA_NO_PAGE = "This page is not in the chat any more.";

interface Declared {
  agentId: string;
  uses: PageUse[];
  at: number;
}

/** What each page made here declared in its html_render call: `<dir>/page-uses.json`, newest 5,000 pages. */
export class PageUsesStore {
  readonly #file: string;
  readonly #max: number;
  readonly #pages = new Map<string, Declared>();

  constructor(dir: string, max = USES_MAX) {
    this.#file = join(dir, USES_FILE);
    this.#max = max;
    try {
      const parsed = JSON.parse(readFileSync(this.#file, "utf8"));
      if (isDynamicRecord(parsed) && parsed.version === 1 && isDynamicRecord(parsed.pages))
        for (const [attachmentId, value] of Object.entries(parsed.pages)) {
          if (!isDynamicRecord(value) || !isString(value.agentId)) continue;
          const uses = pageUses(value.uses);
          if (uses.length) this.#pages.set(attachmentId, { agentId: value.agentId, uses, at: count(value.at) });
        }
    } catch {}
  }

  /** Kept only when the page declared something. */
  record(attachmentId: string, agentId: string, uses: readonly PageUse[], at = Date.now()): void {
    const kept = pageUses(uses);
    if (!kept.length || !attachmentId || !agentId) return;
    this.#pages.delete(attachmentId);
    this.#pages.set(attachmentId, { agentId, uses: kept, at });
    while (this.#pages.size > this.#max) {
      const oldest = this.#pages.keys().next().value;
      if (oldest === undefined) break;
      this.#pages.delete(oldest);
    }
    const temporary = `${this.#file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      mkdirSync(dirname(this.#file), { recursive: true, mode: 0o700 });
      writeFileSync(temporary, `${JSON.stringify({ version: 1, pages: Object.fromEntries(this.#pages) })}\n`, {
        mode: 0o600,
      });
      renameSync(temporary, this.#file);
    } catch (error) {
      rmSync(temporary, { force: true });
      throw error;
    }
  }

  /** What the page of this attachment declared, for this agent; [] for anything else. */
  uses(attachmentId: string, agentId: string): PageUse[] {
    const declared = this.#pages.get(attachmentId);
    return declared && declared.agentId === agentId ? declared.uses : [];
  }
}

function count(value: unknown): number {
  return isNumber(value) && Number.isFinite(value) ? value : 0;
}

type PageDataCell = string | number | null | { blobBytes: number };

export interface PageDataQueryResult {
  columns: string[];
  rows: PageDataCell[][];
  truncated: boolean;
}

type PageDataCheck<T> = { ok: true; value: T } | { ok: false; message: string };

export interface PageDataDependencies {
  localServerId: string;
  uses: Pick<PageUsesStore, "uses">;
  /** The agents and thread of a page of this computer, from the chat itself. */
  localPage: (attachmentId: string) => { agentIds: readonly string[] } | null;
  /** The declaration of the version a saved app shows; null when there is no such app. */
  appUses: (appId: string) => { serverId: string; uses: readonly PageUse[] } | null;
  /** AgentTables' read-only query, with its checks and limits. */
  query: (sql: string, params: (string | number | null)[]) => Promise<PageDataCheck<PageDataQueryResult>>;
  tables: () => Promise<string[]>;
  now?: () => number;
}

/** Rows as objects by column name; a repeated name gets `_2`, `_3`… so no cell is lost. */
export function pageDataRows(result: PageDataQueryResult): { columns: string[]; rows: PageStateValue[] } {
  const seen = new Map<string, number>();
  const columns = result.columns.map((name) => {
    const n = (seen.get(name) ?? 0) + 1;
    seen.set(name, n);
    return n === 1 ? name : `${name}_${n}`;
  });
  const rows = result.rows.map((row) => {
    const out: { [key: string]: PageStateValue } = {};
    columns.forEach((name, index) => {
      const cell = row[index] ?? null;
      Object.defineProperty(out, name, {
        value: isDynamicRecord(cell) ? { blobBytes: count(cell.blobBytes) } : cell,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    });
    return out;
  });
  return { columns, rows };
}

export type PageData = ReturnType<typeof createPageData>;

export function createPageData(deps: PageDataDependencies) {
  const now = deps.now ?? Date.now;
  const budgets = new Map<string, ReturnType<typeof createRateLimiter>>();

  /** The refusal for this target, or null when it may read. */
  function refusal(target: PageStateTarget): string | null {
    if ("appId" in target) {
      const app = deps.appUses(target.appId);
      if (!app) return "This app is not here any more.";
      if (app.serverId !== deps.localServerId) return PAGE_DATA_NOT_LOCAL;
      return app.uses.includes("data") ? null : CHAT_VISUAL_DATA_UNDECLARED;
    }
    if (target.serverId !== deps.localServerId) return PAGE_DATA_NOT_LOCAL;
    const page = deps.localPage(target.attachmentId);
    if (!page?.agentIds.includes(target.agentId)) return PAGE_DATA_NO_PAGE;
    return deps.uses.uses(target.attachmentId, target.agentId).includes("data") ? null : CHAT_VISUAL_DATA_UNDECLARED;
  }

  function withinBudget(caller: string, target: PageStateTarget): boolean {
    const key = `${caller}\u0000${"appId" in target ? target.appId : `${target.serverId}\u0000${target.attachmentId}`}`;
    let budget = budgets.get(key);
    if (!budget) {
      if (budgets.size > 1_000) budgets.clear();
      budget = createRateLimiter(PAGE_DATA_RATES, now);
      budgets.set(key, budget);
    }
    return budget.take();
  }

  return {
    refusal,
    /** `caller`: the asking window (its web contents id), so one window cannot spend another's budget. */
    async handle(caller: string, request: PageDataRequest): Promise<PageStateReply> {
      const refused = refusal(request.target);
      if (refused) return { ok: false, error: refused };
      if (!withinBudget(caller, request.target)) return { ok: false, error: CHAT_VISUAL_DATA_TOO_MANY };
      try {
        if (request.op === "tables") return { ok: true, value: await deps.tables() };
        const result = await deps.query(request.sql, request.params);
        if (!result.ok) return { ok: false, error: result.message };
        const shaped = pageDataRows(result.value);
        let rows = shaped.rows;
        let truncated = result.value.truncated;
        // Rows as objects repeat their column names: the cap holds for what is sent.
        while (rows.length > 0 && Buffer.byteLength(JSON.stringify(rows)) > PAGE_DATA_ANSWER_BYTES) {
          rows = rows.slice(0, rows.length - Math.max(1, Math.ceil(rows.length / 10)));
          truncated = true;
        }
        return { ok: true, value: { columns: shaped.columns, rows, truncated } };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : "The data could not be read." };
      }
    },
  };
}
