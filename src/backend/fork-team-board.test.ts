// @vitest-environment node
// Fork (docs/fork/FEATURES.md #134, "Team board"): the board read model over the mailbox, the status
// of a report, and the `status` / `next` fields of openbot.send_message.
import {
  decodeTeamBoard,
  parseReportStatus,
  reportExcerpt,
  requestTitle,
  type TeamMemberActivity,
  withReportStatus,
} from "@openbot/contracts/fork-team-board";
import type { QueueDeliveryStatus } from "@openbot/contracts/ipc";
import { describe, expect, it } from "vitest";
import {
  buildTeamBoard,
  reportFields,
  type TeamBoardMessage,
  teamBoardHours,
  teamBoardToolResult,
} from "./fork-team-board";

const MIN = 60_000;
const NOW = Date.parse("2026-11-27T16:00:00.000Z");
const ago = (minutes: number) => new Date(NOW - minutes * MIN).toISOString();

let ids = 0;
function request(
  lead: string,
  teammate: string,
  minutes: number,
  status: QueueDeliveryStatus,
  text = `Do part ${ids + 1}`,
): TeamBoardMessage {
  ids += 1;
  return {
    id: `request-${ids}`,
    senderAgentId: lead,
    text,
    createdAt: ago(minutes),
    replyToMessageId: null,
    expectsReply: true,
    deliveries: [{ recipientAgentId: teammate, status }],
  };
}

function reply(
  teammate: string,
  lead: string,
  minutes: number,
  text: string,
  replyTo: string | null,
  extra: Partial<TeamBoardMessage> = {},
): TeamBoardMessage {
  ids += 1;
  return {
    id: `reply-${ids}`,
    senderAgentId: teammate,
    text,
    createdAt: ago(minutes),
    replyToMessageId: replyTo,
    expectsReply: false,
    deliveries: [{ recipientAgentId: lead, status: "completed" }],
    ...extra,
  };
}

const NAMES: Record<string, string> = {
  vegapunk: "Vegapunk",
  apoo: "Apoo",
  arena: "Arena",
  distiller: "Distiller",
  pacer: "Pacer",
  shaka: "Shaka",
};

function board(
  messages: TeamBoardMessage[],
  options: { gone?: string[]; activity?: Record<string, TeamMemberActivity>; leadId?: string | null } = {},
) {
  return buildTeamBoard({
    messages,
    agent: (agentId) => (options.gone?.includes(agentId) || !NAMES[agentId] ? null : { name: NAMES[agentId] ?? "" }),
    activity: (agentId) => options.activity?.[agentId] ?? "idle",
    now: NOW,
    windowHours: 24,
    leadId: options.leadId === undefined ? "vegapunk" : options.leadId,
    overdueMs: 60 * MIN,
  });
}

function rowOf(messages: TeamBoardMessage[], teammate: string, options: Parameters<typeof board>[1] = {}) {
  return board(messages, options).leads[0]?.rows.find((row) => row.teammateId === teammate);
}

describe("team board states", () => {
  it("queued, working and the teammate's live activity", () => {
    const queued = request("vegapunk", "apoo", 5, "queued");
    const working = request("vegapunk", "arena", 10, "running", "Render wave 2\nwith the tactile pack");
    const result = board([queued, working], { activity: { arena: "working", apoo: "queued" } });
    const rows = result.leads[0]?.rows ?? [];
    expect(rows.map((row) => [row.teammateName, row.state, row.activity])).toEqual([
      ["Apoo", "queued", "queued"],
      ["Arena", "working", "working"],
    ]);
    expect(rows[1]?.request).toBe("Render wave 2");
    expect(rows[1]?.report).toBeNull();
  });

  it("a report's status line gives the state, with its next step", () => {
    const asked = request("vegapunk", "apoo", 40, "completed");
    const done = reply(
      "apoo",
      "vegapunk",
      24,
      "Status: done\nNext: wire the renderer\n\nResult: toolkit v2 written.",
      asked.id,
    );
    const row = rowOf([asked, done], "apoo");
    expect(row?.state).toBe("done");
    expect(row?.report).toMatchObject({
      status: "done",
      next: "wire the renderer",
      excerpt: "toolkit v2 written.",
      current: true,
      openBotNote: false,
    });
  });

  it("blocked, needs-input and a report without a status", () => {
    const one = request("vegapunk", "apoo", 30, "completed");
    const two = request("vegapunk", "arena", 30, "completed");
    const three = request("vegapunk", "pacer", 30, "completed");
    const messages = [
      one,
      two,
      three,
      reply("apoo", "vegapunk", 20, "**Status:** blocked\nUnblock: grant the folder", one.id),
      reply("arena", "vegapunk", 20, "Status: needs input — which palette?", two.id),
      reply("pacer", "vegapunk", 20, "Finished the cut, see out.mp4", three.id),
    ];
    expect(rowOf(messages, "apoo")?.state).toBe("blocked");
    expect(rowOf(messages, "arena")?.state).toBe("needs-input");
    expect(rowOf(messages, "pacer")?.state).toBe("replied");
  });

  it("a question back to the lead without a status needs input", () => {
    const asked = request("vegapunk", "apoo", 30, "running");
    const question = reply("apoo", "vegapunk", 5, "Which of the two folders do you mean?", null, {
      expectsReply: true,
    });
    expect(rowOf([asked, question], "apoo")?.state).toBe("needs-input");
  });

  it("a progress report while the turn runs is working; after it, progress", () => {
    const asked = request("vegapunk", "apoo", 30, "running");
    const progress = reply("apoo", "vegapunk", 5, "Status: in progress\nNext: stage 2", asked.id);
    expect(rowOf([asked, progress], "apoo")?.state).toBe("working");
    const ended = { ...asked, deliveries: [{ recipientAgentId: "apoo", status: "completed" as const }] };
    expect(rowOf([ended, progress], "apoo")?.state).toBe("progress");
  });

  it("failed: the delivery failed, or OpenBot's note answered the request", () => {
    const one = request("vegapunk", "apoo", 30, "failed");
    const two = request("vegapunk", "arena", 30, "completed");
    const note = reply(
      "arena",
      "vegapunk",
      10,
      "Status: blocked\nResult: OpenBot note, not written by this teammate: the request failed before the teammate answered. Gemini timed out.\nEvidence: none",
      two.id,
    );
    expect(rowOf([one, two, note], "apoo")?.state).toBe("failed");
    const arena = rowOf([one, two, note], "arena");
    expect(arena?.state).toBe("failed");
    expect(arena?.report?.openBotNote).toBe(true);
    expect(arena?.report?.excerpt).toBe("the request failed before the teammate answered. Gemini timed out.");
  });

  it("overdue: the turn ended without a report, or no report for longer than the overdue time", () => {
    const ended = request("vegapunk", "apoo", 10, "completed");
    const justEnded = request("vegapunk", "arena", 1, "completed");
    const old = request("vegapunk", "pacer", 90, "running");
    const messages = [ended, justEnded, old];
    expect(rowOf(messages, "apoo")?.state).toBe("overdue");
    expect(rowOf(messages, "arena")?.state).toBe("working");
    expect(rowOf(messages, "pacer", { activity: { pacer: "working" } })).toMatchObject({
      state: "overdue",
      activity: "working",
    });
  });

  it("the newest request supersedes older ones; unanswered older ones count, answered and cancelled do not", () => {
    const first = request("vegapunk", "apoo", 300, "completed", "Wave 1");
    const firstDone = reply("apoo", "vegapunk", 280, "Status: done", first.id);
    const second = request("vegapunk", "apoo", 200, "completed", "Wave 2");
    const third = request("vegapunk", "apoo", 150, "cancelled", "Wave 3");
    const fourth = request("vegapunk", "apoo", 20, "running", "Wave 4");
    const row = rowOf([first, firstDone, second, third, fourth], "apoo", { activity: { apoo: "working" } });
    expect(row).toMatchObject({ request: "Wave 4", state: "working", earlierOpen: 1 });
    // The last report answers Wave 1, not the current request.
    expect(row?.report).toMatchObject({ messageId: firstDone.id, status: "done", current: false });
  });

  it("a report without a reply id answers the newest request sent before it", () => {
    const first = request("vegapunk", "apoo", 60, "completed", "Wave 1");
    const loose = reply("apoo", "vegapunk", 50, "Status: done", null);
    const second = request("vegapunk", "apoo", 10, "running", "Wave 2");
    const row = rowOf([first, loose, second], "apoo");
    expect(row).toMatchObject({ request: "Wave 2", state: "working", earlierOpen: 0 });
    expect(row?.report?.current).toBe(false);
  });

  it("leaves out hidden or deleted teammates and leads, channel-free requests to self, and old mail", () => {
    const toGone = request("vegapunk", "shaka", 10, "running");
    const fromGone = request("distiller", "apoo", 10, "running");
    const old = request("vegapunk", "arena", 25 * 60, "completed");
    const info = { ...request("vegapunk", "pacer", 10, "completed"), expectsReply: false };
    const result = board([toGone, fromGone, old, info], { gone: ["shaka", "distiller"], leadId: null });
    expect(result.leads).toEqual([]);
  });

  it("groups by lead, attention first, and filters one lead", () => {
    const messages = [
      request("vegapunk", "apoo", 10, "running"),
      request("vegapunk", "arena", 90, "running"),
      request("distiller", "pacer", 10, "queued"),
    ];
    const all = board(messages, { leadId: null });
    expect(all.leads.map((lead) => lead.leadName)).toEqual(["Distiller", "Vegapunk"]);
    expect(all.leads[1]?.rows.map((row) => [row.teammateName, row.state])).toEqual([
      ["Arena", "overdue"],
      ["Apoo", "working"],
    ]);
    expect(board(messages, { leadId: "distiller" }).leads.map((lead) => lead.leadId)).toEqual(["distiller"]);
  });

  it("one request to several teammates gives each a row", () => {
    const asked = {
      ...request("vegapunk", "apoo", 10, "running"),
      deliveries: [
        { recipientAgentId: "apoo", status: "running" as const },
        { recipientAgentId: "arena", status: "queued" as const },
      ],
    };
    const done = reply("arena", "vegapunk", 2, "Status: done", asked.id);
    const rows = board([asked, done]).leads[0]?.rows ?? [];
    expect(rows.map((row) => [row.teammateId, row.state])).toEqual([
      ["apoo", "working"],
      ["arena", "done"],
    ]);
  });

  it("round-trips through the app's decoder", () => {
    const asked = request("vegapunk", "apoo", 40, "completed");
    const result = board([asked, reply("apoo", "vegapunk", 3, "Status: done\nNext: none", asked.id)]);
    expect(decodeTeamBoard(JSON.parse(JSON.stringify(result)))).toEqual(result);
    expect(() => decodeTeamBoard({ ...result, leads: [{ leadId: 1 }] })).toThrow();
  });

  it("the tool's compact result", () => {
    const asked = request("vegapunk", "apoo", 40, "completed", "Build the toolkit");
    const done = reply("apoo", "vegapunk", 9, "Status: done\nNext: review\n\nResult: shipped", asked.id);
    const result = teamBoardToolResult(board([asked, done]), "vegapunk", NOW);
    expect(result).toEqual({
      windowHours: 24,
      counts: { done: 1 },
      teammates: [
        {
          name: "Apoo",
          id: "apoo",
          state: "done",
          live: "idle",
          request: "Build the toolkit",
          requestId: asked.id,
          askedMinutesAgo: 40,
          report: { status: "done", next: "review", text: "shipped", minutesAgo: 9, messageId: done.id },
        },
      ],
    });
    expect(teamBoardToolResult(board([]), "vegapunk", NOW)).toMatchObject({ teammates: [], note: expect.any(String) });
  });
});

describe("report status", () => {
  it("reads the status line among the first lines, in the ways teammates write it", () => {
    expect(parseReportStatus("Status: done\nResult: ok")).toEqual({ status: "done", next: null });
    expect(parseReportStatus("✅ **Status:** Complete — all 4 clips")).toEqual({ status: "done", next: null });
    expect(parseReportStatus("Apoo here.\n\n- Status: BLOCKED\nNext step: Elias grants access")).toEqual({
      status: "blocked",
      next: "Elias grants access",
    });
    expect(parseReportStatus("Status: needs-input\nNext:\n  pick A or B")).toEqual({
      status: "needs-input",
      next: "pick A or B",
    });
    expect(parseReportStatus("Status: partial")?.status).toBe("partial");
    expect(parseReportStatus("status = in progress")?.status).toBe("progress");
    expect(parseReportStatus("Status: done | partial | blocked")?.status).toBe("done");
  });

  it("is null without a known status line near the top", () => {
    expect(parseReportStatus("All done here.")).toBeNull();
    expect(parseReportStatus("Status: unknown words")).toBeNull();
    expect(parseReportStatus("a\nb\nc\nd\ne\nStatus: done")).toBeNull();
  });

  it("writes the status lines first and drops the text's own", () => {
    expect(withReportStatus("Rendered 4 clips.", "done", null)).toBe("Status: done\n\nRendered 4 clips.");
    expect(withReportStatus("Status: done\nNext: old\nResult: x", "blocked", "grant the folder")).toBe(
      "Status: blocked\nNext: grant the folder\n\nResult: x",
    );
    expect(withReportStatus("Status: done", "done", null)).toBe("Status: done");
    expect(parseReportStatus(withReportStatus("Result: x", "needs-input", "pick a palette"))).toEqual({
      status: "needs-input",
      next: "pick a palette",
    });
  });

  it("excerpts and titles", () => {
    expect(reportExcerpt("Status: done\nNext: x\nResult: **toolkit** v2\nEvidence: ls -> out_final/", 100)).toBe(
      "toolkit v2 Evidence: ls -> out_final/",
    );
    expect(reportExcerpt("Status: done\nAll fine", 4)).toBe("All…");
    expect(requestTitle("\n## Wave 2: render\nmore", 100)).toBe("Wave 2: render");
  });
});

describe("send_message status and next", () => {
  it("accepts a known status with an optional one-line next", () => {
    expect(reportFields({})).toBeNull();
    expect(reportFields({ status: null, next: null })).toBeNull();
    expect(reportFields({ status: "done" })).toEqual({ status: "done", next: null });
    expect(reportFields({ status: "blocked", next: "  grant\n the folder " })).toEqual({
      status: "blocked",
      next: "grant the folder",
    });
  });

  it("refuses an unknown status, next without status, and an empty, long or non-text next", () => {
    expect(() => reportFields({ status: "finished" })).toThrow(/status must be one of/u);
    expect(() => reportFields({ next: "x" })).toThrow(/next needs status/u);
    expect(() => reportFields({ status: "done", next: "   " })).toThrow(/must not be empty/u);
    expect(() => reportFields({ status: "done", next: "x".repeat(301) })).toThrow(/at most 300/u);
    expect(() => reportFields({ status: "done", next: 3 })).toThrow(/must be text/u);
  });

  it("checks the tool's hours", () => {
    expect(teamBoardHours(undefined)).toBe(24);
    expect(teamBoardHours(2)).toBe(2);
    expect(() => teamBoardHours(0)).toThrow();
    expect(() => teamBoardHours(1000)).toThrow();
    expect(() => teamBoardHours("3")).toThrow();
  });
});
