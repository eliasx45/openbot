/**
 * Fork (docs/fork/FEATURES.md #134, "Team board"): the shapes of a lead agent's team board, and the
 * structured status of a teammate's report.
 *
 * A report's status lives in its text, as a leading `Status: <status>` line (and an optional
 * `Next: <next>` line). `openbot.send_message` writes these lines when a teammate passes `status` and
 * `next`; teammates that write the line themselves (OpenBot asks them to, and its own failure note does)
 * are read the same way. So the mailbox needs no new field, and the lead reads the status in its prompt.
 */

import { isBoolean, isDynamicRecord, isNumber, isOneOf, isString } from "./runtime-values";

export const TEAM_REPORT_STATUSES = ["done", "progress", "partial", "blocked", "needs-input"] as const;
export type TeamReportStatus = (typeof TEAM_REPORT_STATUSES)[number];

/**
 * The state of a teammate's current request: still in its queue, being worked on, answered (with the
 * report's status, or `replied` without one), failed (an OpenBot note answered it), or `overdue`: no
 * report, and the teammate's turn ended or the request is older than the overdue time.
 */
export const TEAM_BOARD_STATES = [
  "queued",
  "working",
  "done",
  "progress",
  "partial",
  "blocked",
  "needs-input",
  "replied",
  "failed",
  "overdue",
] as const;
export type TeamBoardState = (typeof TEAM_BOARD_STATES)[number];

export const TEAM_MEMBER_ACTIVITIES = ["working", "queued", "idle"] as const;
export type TeamMemberActivity = (typeof TEAM_MEMBER_ACTIVITIES)[number];

/** The longest `next` line that `openbot.send_message` takes. */
export const TEAM_REPORT_NEXT_LIMIT = 300;

export interface TeamBoardReport {
  messageId: string;
  at: string;
  status: TeamReportStatus | null;
  next: string | null;
  excerpt: string;
  /** OpenBot answered for the teammate: its request failed or its turn stopped before it answered. */
  openBotNote: boolean;
  /** The report answers the row's current request (not an earlier one). */
  current: boolean;
}

export interface TeamBoardRow {
  teammateId: string;
  teammateName: string;
  requestId: string;
  /** The start of the request, one line. */
  request: string;
  sentAt: string;
  state: TeamBoardState;
  /** The teammate's newest report to the lead in the window, or null. */
  report: TeamBoardReport | null;
  activity: TeamMemberActivity;
  /** Earlier requests to this teammate that never got a report (superseded by the current one). */
  earlierOpen: number;
}

export interface TeamBoardLead {
  leadId: string;
  leadName: string;
  rows: TeamBoardRow[];
}

export interface TeamBoard {
  generatedAt: string;
  windowHours: number;
  leads: TeamBoardLead[];
}

export interface ReportStatusLine {
  status: TeamReportStatus;
  next: string | null;
}

const STATUS_SCAN_LINES = 5;
const NEXT_SCAN_LINES = 12;
const OPENBOT_NOTE = "OpenBot note, not written by this teammate";

/** A line without markdown marks and leading bullets or emoji, for matching. */
function plainLine(line: string): string {
  return line
    .replace(/[*_`#>]/gu, "")
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .trim();
}

function statusWord(value: string): TeamReportStatus | null {
  const word = value.toLowerCase().trim();
  if (/^(done|complete|completed|finished|success|succeeded)\b/u.test(word)) return "done";
  if (/^(needs?[ -]?(input|you|user|decision|answer|review)|waiting\b|question\b)/u.test(word)) return "needs-input";
  if (/^blocked\b/u.test(word)) return "blocked";
  if (/^partial(ly)?\b/u.test(word)) return "partial";
  if (/^(in[ -]?progress|progress|working|ongoing|started|wip)\b/u.test(word)) return "progress";
  return null;
}

function statusLineValue(line: string): string | null {
  return /^status\s*[:：=–—-]\s*(.+)$/iu.exec(plainLine(line))?.[1] ?? null;
}

function nextLineValue(line: string): string | null {
  const value = /^next(?:\s+steps?)?\s*[:：=–—-]\s*(.*)$/iu.exec(plainLine(line))?.[1];
  return value === undefined ? null : value.trim();
}

function oneLine(text: string, limit: number): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit).trimEnd()}…` : flat;
}

/**
 * The status of a report: a `Status: <word>` line among its first lines, and a `Next:` line after it.
 * Words: done (complete, finished), progress (in progress, working), partial, blocked, needs-input
 * (needs input, needs you, waiting, question). Null when the text has no such line.
 */
export function parseReportStatus(text: string): ReportStatusLine | null {
  const lines = text.split(/\r?\n/u);
  let seen = 0;
  for (let index = 0; index < lines.length && seen < STATUS_SCAN_LINES; index += 1) {
    const line = lines[index] ?? "";
    if (!line.trim()) continue;
    seen += 1;
    const value = statusLineValue(line);
    const status = value === null ? null : statusWord(value);
    if (!status) continue;
    return { status, next: nextAfter(lines, index + 1) };
  }
  return null;
}

function nextAfter(lines: readonly string[], start: number): string | null {
  for (let index = start; index < Math.min(lines.length, start + NEXT_SCAN_LINES); index += 1) {
    const value = nextLineValue(lines[index] ?? "");
    if (value === null) continue;
    if (value) return oneLine(value, TEAM_REPORT_NEXT_LIMIT);
    const following = lines.slice(index + 1).find((line) => line.trim());
    return following ? oneLine(plainLine(following), TEAM_REPORT_NEXT_LIMIT) || null : null;
  }
  return null;
}

/**
 * The text that `openbot.send_message` stores for a reply with `status` (and `next`): the status lines
 * first, then the teammate's text without a status line (or next line) of its own at its start.
 */
export function withReportStatus(text: string, status: TeamReportStatus, next: string | null): string {
  const lines = text.split(/\r?\n/u);
  const drop = (test: (line: string) => boolean) => {
    const first = lines.findIndex((line) => line.trim());
    if (first >= 0 && test(lines[first] ?? "")) lines.splice(0, first + 1);
  };
  drop((line) => statusLineValue(line) !== null);
  if (next !== null) drop((line) => nextLineValue(line) !== null);
  const body = lines
    .join("\n")
    .replace(/^\s*\n/u, "")
    .trimEnd();
  const head = [`Status: ${status}`, ...(next === null ? [] : [`Next: ${next}`])].join("\n");
  return body ? `${head}\n\n${body}` : head;
}

/** OpenBot wrote the report for the teammate: its request failed or stopped before it answered. */
export function isOpenBotReportNote(text: string): boolean {
  return text.includes(OPENBOT_NOTE);
}

/**
 * One line from a report for the board: its `Result:` line when it has one, else its text without the
 * status and next lines.
 */
/** A line without its heading or quote mark and without bold, italic or code marks. */
function withoutMarkup(line: string): string {
  return line.replace(/^\s*(?:#{1,6}|>+)\s*/u, "").replace(/\*\*|__|`/gu, "");
}

export function reportExcerpt(text: string, limit: number): string {
  const lines = text
    .split(/\r?\n/u)
    .filter((line) => statusLineValue(line) === null && nextLineValue(line) === null)
    .map(withoutMarkup)
    .filter((line) => !/^\s*evidence\s*[:：]\s*none\.?\s*$/iu.test(line));
  const resultIndex = lines.findIndex((line) => /^result\s*[:：]/iu.test(plainLine(line)));
  const kept = resultIndex >= 0 ? lines.slice(resultIndex) : lines;
  const joined = kept
    .join(" ")
    .replace(/^\W*result\s*[:：]\s*/iu, "")
    .replace(new RegExp(`${OPENBOT_NOTE}:?\\s*`, "u"), "");
  return oneLine(joined, limit);
}

/** The first line of a request, for the board's title. */
export function requestTitle(text: string, limit: number): string {
  const first = text.split(/\r?\n/u).find((line) => plainLine(line)) ?? "";
  return oneLine(withoutMarkup(first).replace(/^\s*[-•]\s*/u, ""), limit);
}

function decodeReport(value: unknown): TeamBoardReport | null {
  if (value === null) return null;
  if (
    !isDynamicRecord(value) ||
    !isString(value.messageId) ||
    !isString(value.at) ||
    !isString(value.excerpt) ||
    !(value.status === null || isOneOf(TEAM_REPORT_STATUSES, value.status)) ||
    !(value.next === null || isString(value.next)) ||
    !isBoolean(value.openBotNote) ||
    !isBoolean(value.current)
  )
    throw new Error("Invalid team board report.");
  return {
    messageId: value.messageId,
    at: value.at,
    status: value.status,
    next: value.next,
    excerpt: value.excerpt,
    openBotNote: value.openBotNote,
    current: value.current,
  };
}

function decodeRow(value: unknown): TeamBoardRow {
  if (
    !isDynamicRecord(value) ||
    !isString(value.teammateId) ||
    !isString(value.teammateName) ||
    !isString(value.requestId) ||
    !isString(value.request) ||
    !isString(value.sentAt) ||
    !isOneOf(TEAM_BOARD_STATES, value.state) ||
    !isOneOf(TEAM_MEMBER_ACTIVITIES, value.activity) ||
    !isNumber(value.earlierOpen)
  )
    throw new Error("Invalid team board row.");
  return {
    teammateId: value.teammateId,
    teammateName: value.teammateName,
    requestId: value.requestId,
    request: value.request,
    sentAt: value.sentAt,
    state: value.state,
    report: decodeReport(value.report),
    activity: value.activity,
    earlierOpen: value.earlierOpen,
  };
}

export function decodeTeamBoard(value: unknown): TeamBoard {
  if (
    !isDynamicRecord(value) ||
    !isString(value.generatedAt) ||
    !isNumber(value.windowHours) ||
    !Array.isArray(value.leads)
  )
    throw new Error("Invalid team board.");
  return {
    generatedAt: value.generatedAt,
    windowHours: value.windowHours,
    leads: value.leads.map((lead) => {
      if (!isDynamicRecord(lead) || !isString(lead.leadId) || !isString(lead.leadName) || !Array.isArray(lead.rows))
        throw new Error("Invalid team board lead.");
      return { leadId: lead.leadId, leadName: lead.leadName, rows: lead.rows.map(decodeRow) };
    }),
  };
}

/** A team board request: one lead's board (null: every lead's), over the last `hours` (default 24). */
export interface TeamBoardRequest {
  leadId: string | null;
  hours?: number;
}
