/**
 * Fork (docs/fork/FEATURES.md #134, "Team board"): a lead agent's team, read from the mailbox.
 *
 * A request is a message from one agent to another that expects a reply (`openbot.send_message` with
 * `expectsReply` true, the default), outside channels. A report is any message from the teammate back to
 * the lead. For each lead and teammate the board takes the newest request in the window (older ones are
 * superseded; those that never got a report count as `earlierOpen`) and derives its state from the
 * teammate's reports and the request's delivery: a report's status (`Status: done` …), an OpenBot
 * failure note (`failed`), a question back (`needs-input`), or no report yet (`queued`, `working`, and
 * `overdue` once the turn ended without one or the request is older than the overdue time). The
 * teammate's live activity comes from its lanes. Hidden, deleted and being-deleted agents are left out,
 * as leads and as teammates. No store of its own: it holds over a restart and cannot drift.
 */

import {
  isOpenBotReportNote,
  parseReportStatus,
  reportExcerpt,
  requestTitle,
  TEAM_REPORT_NEXT_LIMIT,
  TEAM_REPORT_STATUSES,
  type TeamBoard,
  type TeamBoardLead,
  type TeamBoardReport,
  type TeamBoardRow,
  type TeamBoardState,
  type TeamMemberActivity,
  type TeamReportStatus,
} from "@openbot/contracts/fork-team-board";
import type { QueueDeliveryStatus } from "@openbot/contracts/ipc";
import { isOneOf } from "@openbot/contracts/runtime-values";

export const TEAM_BOARD_TOOL = "team_board";
export const TEAM_BOARD_DEFAULT_HOURS = 24;
export const TEAM_BOARD_MAX_HOURS = 7 * 24;
/** A request without a report for this long is overdue. Test switch `OPENBOT_FORK_TEAM_BOARD_OVERDUE_MS`. */
const TEAM_BOARD_OVERDUE_MS = 60 * 60_000;
/** A finished turn sends its result as it ends; after this, a request without a report is overdue. */
const RELAY_GRACE_MS = 2 * 60_000;
const REQUEST_LIMIT = 160;
const EXCERPT_LIMIT = 240;

/** A message from one agent, as the mailbox has it. */
export interface TeamBoardMessage {
  id: string;
  senderAgentId: string;
  text: string;
  createdAt: string;
  /** The id of the message it replies to (a delivery id resolved to its message), or null. */
  replyToMessageId: string | null;
  expectsReply: boolean;
  deliveries: ReadonlyArray<{ recipientAgentId: string; status: QueueDeliveryStatus }>;
}

export interface TeamBoardInput {
  /** Agent messages outside channels, created in the window. */
  messages: readonly TeamBoardMessage[];
  /** The agent's name, or null when it is gone, hidden or being deleted. */
  agent(agentId: string): { name: string } | null;
  activity(agentId: string): TeamMemberActivity;
  now: number;
  windowHours: number;
  /** Only this lead's board; null for every lead. */
  leadId: string | null;
  overdueMs?: number;
}

export function teamBoardOverdueMs(): number {
  const raw = process.env.OPENBOT_FORK_TEAM_BOARD_OVERDUE_MS;
  const value = Number(raw);
  return raw && Number.isFinite(value) && value > 0 ? value : TEAM_BOARD_OVERDUE_MS;
}

export function teamBoardHours(value: unknown): number {
  if (value === undefined || value === null) return TEAM_BOARD_DEFAULT_HOURS;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > TEAM_BOARD_MAX_HOURS)
    throw new Error(`hours must be a number from 1 to ${TEAM_BOARD_MAX_HOURS}.`);
  return value;
}

const time = (value: string) => Date.parse(value);

/** States that need the lead (or the user) first, then work in flight, then finished work. */
const STATE_GROUP: Record<TeamBoardState, number> = {
  "needs-input": 0,
  blocked: 0,
  failed: 0,
  overdue: 0,
  working: 1,
  queued: 1,
  progress: 1,
  partial: 2,
  replied: 2,
  done: 2,
};

export function buildTeamBoard(input: TeamBoardInput): TeamBoard {
  const since = input.now - input.windowHours * 60 * 60_000;
  const overdueMs = input.overdueMs ?? TEAM_BOARD_OVERDUE_MS;
  const messages = input.messages
    .filter((message) => {
      const at = time(message.createdAt);
      return Number.isFinite(at) && at >= since && at <= input.now + 60_000;
    })
    .sort((left, right) => time(left.createdAt) - time(right.createdAt));
  // lead -> teammate -> requests, oldest first.
  const requests = new Map<string, Map<string, TeamBoardMessage[]>>();
  // `${from}>${to}` -> messages from `from` delivered to `to`, oldest first.
  const sentTo = new Map<string, TeamBoardMessage[]>();
  for (const message of messages) {
    for (const delivery of message.deliveries) {
      if (delivery.recipientAgentId === message.senderAgentId) continue;
      const key = `${message.senderAgentId}>${delivery.recipientAgentId}`;
      sentTo.set(key, [...(sentTo.get(key) ?? []), message]);
      if (!message.expectsReply) continue;
      const team = requests.get(message.senderAgentId) ?? new Map<string, TeamBoardMessage[]>();
      team.set(delivery.recipientAgentId, [...(team.get(delivery.recipientAgentId) ?? []), message]);
      requests.set(message.senderAgentId, team);
    }
  }
  const leads: TeamBoardLead[] = [];
  for (const [leadId, team] of requests) {
    if (input.leadId !== null && leadId !== input.leadId) continue;
    const lead = input.agent(leadId);
    if (!lead) continue;
    const rows: TeamBoardRow[] = [];
    for (const [teammateId, asked] of team) {
      const teammate = input.agent(teammateId);
      if (!teammate) continue;
      rows.push(
        teamRow({
          leadId,
          teammateId,
          teammateName: teammate.name,
          asked,
          reports: (sentTo.get(`${teammateId}>${leadId}`) ?? []).filter(
            // The lead's own requests to this teammate are never its reports.
            (message) => message.senderAgentId === teammateId,
          ),
          activity: input.activity(teammateId),
          now: input.now,
          overdueMs,
        }),
      );
    }
    if (rows.length === 0) continue;
    rows.sort(
      (left, right) =>
        STATE_GROUP[left.state] - STATE_GROUP[right.state] ||
        left.teammateName.localeCompare(right.teammateName) ||
        left.teammateId.localeCompare(right.teammateId),
    );
    leads.push({ leadId, leadName: lead.name, rows });
  }
  leads.sort((left, right) => left.leadName.localeCompare(right.leadName) || left.leadId.localeCompare(right.leadId));
  return { generatedAt: new Date(input.now).toISOString(), windowHours: input.windowHours, leads };
}

function teamRow(input: {
  leadId: string;
  teammateId: string;
  teammateName: string;
  asked: readonly TeamBoardMessage[];
  reports: readonly TeamBoardMessage[];
  activity: TeamMemberActivity;
  now: number;
  overdueMs: number;
}): TeamBoardRow {
  const { asked, reports } = input;
  const current = asked[asked.length - 1];
  if (!current) throw new Error("A team row needs a request.");
  const askedIds = new Set(asked.map((request) => request.id));
  // A report answers the request it replies to; one that replies to none of them answers the newest
  // request sent before it.
  const answers = (request: TeamBoardMessage, next: TeamBoardMessage | undefined) => (report: TeamBoardMessage) =>
    report.replyToMessageId === request.id ||
    ((report.replyToMessageId === null || !askedIds.has(report.replyToMessageId)) &&
      time(report.createdAt) >= time(request.createdAt) &&
      (!next || time(report.createdAt) < time(next.createdAt)));
  const currentReports = reports.filter(answers(current, undefined));
  const earlierOpen = asked.slice(0, -1).filter((request, index) => {
    if (deliveryTo(request, input.teammateId) === "cancelled") return false;
    return !reports.some(answers(request, asked[index + 1]));
  }).length;
  const latestCurrent = currentReports[currentReports.length - 1];
  const latest = reports[reports.length - 1];
  return {
    teammateId: input.teammateId,
    teammateName: input.teammateName,
    requestId: current.id,
    request: requestTitle(current.text, REQUEST_LIMIT),
    sentAt: current.createdAt,
    state: rowState(current, latestCurrent, input),
    report: latest ? boardReport(latest, latest === latestCurrent) : null,
    activity: input.activity,
    earlierOpen,
  };
}

function deliveryTo(request: TeamBoardMessage, teammateId: string): QueueDeliveryStatus | null {
  return request.deliveries.find((delivery) => delivery.recipientAgentId === teammateId)?.status ?? null;
}

function rowState(
  request: TeamBoardMessage,
  report: TeamBoardMessage | undefined,
  input: { teammateId: string; now: number; overdueMs: number },
): TeamBoardState {
  const delivery = deliveryTo(request, input.teammateId);
  const age = input.now - time(request.createdAt);
  if (report) {
    if (isOpenBotReportNote(report.text)) return "failed";
    const status = parseReportStatus(report.text)?.status;
    if (status === "progress" && (delivery === "running" || delivery === "starting")) return "working";
    if (status) return status;
    // A question back to the lead, not an answer.
    if (report.expectsReply && report.replyToMessageId === null) return "needs-input";
    return "replied";
  }
  if (delivery === "failed" || delivery === "interrupted" || delivery === "cancelled") return "failed";
  if (delivery === "completed") return age > RELAY_GRACE_MS ? "overdue" : "working";
  if (age > input.overdueMs) return "overdue";
  return delivery === "running" ? "working" : "queued";
}

function boardReport(message: TeamBoardMessage, current: boolean): TeamBoardReport {
  const parsed = parseReportStatus(message.text);
  return {
    messageId: message.id,
    at: message.createdAt,
    status: parsed?.status ?? null,
    next: parsed?.next ?? null,
    excerpt: reportExcerpt(message.text, EXCERPT_LIMIT),
    openBotNote: isOpenBotReportNote(message.text),
    current,
  };
}

/** The validated `status` and `next` of an `openbot.send_message` call; null when neither is given. */
export function reportFields(args: { status?: unknown; next?: unknown }): {
  status: TeamReportStatus;
  next: string | null;
} | null {
  const status = args.status ?? undefined;
  const next = args.next ?? undefined;
  if (status === undefined && next === undefined) return null;
  if (status === undefined)
    throw new Error(`next needs status: pass status (${TEAM_REPORT_STATUSES.join(", ")}) with it.`);
  if (!isOneOf(TEAM_REPORT_STATUSES, status))
    throw new Error(`status must be one of ${TEAM_REPORT_STATUSES.join(", ")}.`);
  if (next === undefined) return { status, next: null };
  if (typeof next !== "string") throw new Error("next must be text: the one next step, in one line.");
  const line = next.replace(/\s+/gu, " ").trim();
  if (!line) throw new Error("next must not be empty. Leave it out when there is no next step.");
  if (line.length > TEAM_REPORT_NEXT_LIMIT)
    throw new Error(`next takes at most ${TEAM_REPORT_NEXT_LIMIT} characters: name the one next step.`);
  return { status, next: line };
}

const minutesAgo = (at: string, now: number) => Math.max(0, Math.round((now - time(at)) / 60_000));

/** The lead's board for `openbot.team_board`: compact, one entry per teammate. */
export function teamBoardToolResult(board: TeamBoard, leadId: string, now: number) {
  const lead = board.leads.find((candidate) => candidate.leadId === leadId);
  const rows = lead?.rows ?? [];
  const counts: Partial<Record<TeamBoardState, number>> = {};
  for (const row of rows) counts[row.state] = (counts[row.state] ?? 0) + 1;
  return {
    windowHours: board.windowHours,
    counts,
    teammates: rows.map((row) => ({
      name: row.teammateName,
      id: row.teammateId,
      state: row.state,
      live: row.activity,
      request: row.request,
      requestId: row.requestId,
      askedMinutesAgo: minutesAgo(row.sentAt, now),
      ...(row.report
        ? {
            report: {
              ...(row.report.status ? { status: row.report.status } : {}),
              ...(row.report.next ? { next: row.report.next } : {}),
              text: row.report.excerpt,
              minutesAgo: minutesAgo(row.report.at, now),
              messageId: row.report.messageId,
              ...(row.report.current ? {} : { forEarlierRequest: true }),
              ...(row.report.openBotNote ? { writtenByOpenBot: true } : {}),
            },
          }
        : {}),
      ...(row.earlierOpen > 0 ? { earlierRequestsWithoutReport: row.earlierOpen } : {}),
    })),
    ...(rows.length === 0
      ? {
          note: `You sent no teammate a request (openbot.send_message with expectsReply true) in the last ${board.windowHours} hours.`,
        }
      : {}),
  };
}
