// Fork (docs/fork/FEATURES.md #134, "Team board"): the lead's board pane, the header count, the report
// chip of an exchange row, and the shared read that refreshes on change.
import type { TeamBoard, TeamBoardRow } from "@openbot/contracts/fork-team-board";
import type { AgentEvent, ConversationMessage } from "@openbot/contracts/ipc";
import { ChatActionMarker } from "@openbot/ui/features/conversation/ChatActionMarker";
import { TeamBoardPane, teamAge } from "@openbot/ui/features/conversation/TeamBoard";
import { currentText } from "@openbot/ui/text";
import { fireEvent, render, screen, within } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toAgentMessage } from "../../app-message-projection";
import { useTeamBoard } from "./team-board-store";

afterEach(() => {
  document.body.innerHTML = "";
  vi.useRealTimers();
});

const NOW = Date.parse("2026-11-27T16:00:00.000Z");
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

const row = (name: string, extra: Partial<TeamBoardRow> = {}): TeamBoardRow => ({
  teammateId: name.toLowerCase(),
  teammateName: name,
  requestId: `request-${name}`,
  request: `Render the ${name} part of wave 2 with the tactile style pack and check every frame`,
  sentAt: ago(34),
  state: "working",
  report: null,
  activity: "working",
  earlierOpen: 0,
  ...extra,
});

const ROWS: TeamBoardRow[] = [
  row("Apoo", {
    state: "blocked",
    activity: "idle",
    report: {
      messageId: "m1",
      at: ago(9),
      status: "blocked",
      next: "grant read access to style-packs",
      excerpt: "Cannot read the style pack folder.",
      openBotNote: false,
      current: true,
    },
  }),
  row("Arena", { earlierOpen: 2 }),
  row("Pacer", {
    state: "done",
    activity: "idle",
    report: {
      messageId: "m2",
      at: ago(130),
      status: "done",
      next: null,
      excerpt: "Cut is in out/final.mp4",
      openBotNote: false,
      current: true,
    },
  }),
];

function renderPane(rows: readonly TeamBoardRow[] | undefined, handlers = { open: vi.fn(), message: vi.fn() }) {
  render(() => (
    <TeamBoardPane
      leadName="Vegapunk"
      rows={rows}
      windowHours={24}
      error={false}
      agents={[]}
      now={NOW}
      onOpenTeammate={handlers.open}
      onMessageTeammate={handlers.message}
      onRetry={vi.fn()}
    />
  ));
  return handlers;
}

describe("team board pane", () => {
  it("shows one row per teammate with request, state, live state, report, next step and ages", () => {
    renderPane(ROWS);
    const list = screen.getByRole("list", { name: "Teammates" });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    const apoo = within(items[0] ?? list);
    expect(apoo.getByRole("button", { name: "Open Apoo's chat" })).toBeTruthy();
    // The report's status is the row's state: one chip.
    expect(apoo.getAllByText("Blocked")).toHaveLength(1);
    expect(apoo.getByText("Idle")).toBeTruthy();
    expect(apoo.getByText("Cannot read the style pack folder.")).toBeTruthy();
    expect(apoo.getByText("Next: grant read access to style-packs")).toBeTruthy();
    expect(apoo.getByText("Asked 34 min ago")).toBeTruthy();
    expect(apoo.getByText("Reported 9 min ago")).toBeTruthy();
    const arena = within(items[1] ?? list);
    expect(arena.getByText("No report yet")).toBeTruthy();
    expect(arena.getByText("Working now")).toBeTruthy();
    expect(arena.getByText("2 earlier requests got no report")).toBeTruthy();
    expect(within(items[2] ?? list).getByText("Reported 2 h ago")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Vegapunk's team" })).toBeTruthy();
    expect(within(screen.getByRole("list", { name: "Teammates by state" })).getAllByRole("listitem")).toHaveLength(3);
  });

  it("opens a teammate's chat, or its composer, on every click", () => {
    const handlers = renderPane(ROWS);
    const open = screen.getByRole("button", { name: "Open Arena's chat" });
    fireEvent.click(open);
    fireEvent.click(open);
    fireEvent.click(screen.getByRole("button", { name: "Message Pacer" }));
    expect(handlers.open.mock.calls).toEqual([["arena"], ["arena"]]);
    expect(handlers.message.mock.calls).toEqual([["pacer"]]);
  });

  it("says when it reads, and when the agent leads nobody", () => {
    renderPane(undefined);
    expect(screen.getByRole("status").textContent).toBe("Reading the team…");
    document.body.innerHTML = "";
    renderPane([]);
    expect(screen.getByText("No requests to teammates in the last 24 hours.")).toBeTruthy();
  });

  it("ages", () => {
    const { t } = currentText();
    expect(teamAge(ago(0), NOW, t)).toBe("just now");
    expect(teamAge(ago(59), NOW, t)).toBe("59 min ago");
    expect(teamAge(ago(47 * 60), NOW, t)).toBe("47 h ago");
    expect(teamAge(ago(72 * 60), NOW, t)).toBe("3 d ago");
  });
});

describe("team board read", () => {
  it("is shared by the views of one lead, and reads again after a change", async () => {
    vi.useFakeTimers();
    const board: TeamBoard = {
      generatedAt: ago(0),
      windowHours: 24,
      leads: [{ leadId: "vegapunk", leadName: "Vegapunk", rows: ROWS }],
    };
    let listener: ((event: AgentEvent) => void) | undefined;
    const api = {
      forkTeamBoard: vi.fn(async () => board),
      onEvent: vi.fn((next: (event: AgentEvent) => void) => {
        listener = next;
        return () => {
          listener = undefined;
        };
      }),
    };
    function Probe() {
      const one = useTeamBoard(() => "vegapunk", api);
      const two = useTeamBoard(() => "vegapunk", api);
      return (
        <p>
          {one.lead()?.rows.length ?? "none"}/{two.lead()?.rows.length ?? "none"}
        </p>
      );
    }
    const view = render(() => <Probe />);
    await vi.advanceTimersByTimeAsync(10);
    expect(screen.getByText("3/3")).toBeTruthy();
    expect(api.forkTeamBoard).toHaveBeenCalledTimes(1);
    listener?.({ type: "queue-invalidated", agentId: "apoo" });
    listener?.({ type: "hidden-agents-changed", agents: [] });
    listener?.({ type: "memories-changed", agentId: "apoo" });
    await vi.advanceTimersByTimeAsync(500);
    expect(api.forkTeamBoard).toHaveBeenCalledTimes(2);
    view.unmount();
    expect(listener).toBeUndefined();
  });
});

describe("report chip on an exchange row", () => {
  const reply = (text: string): ConversationMessage => ({
    id: "explorer-reply",
    author: "agent",
    text,
    status: "completed",
    createdAt: ago(3),
    senderAgentId: "explorer",
    exchange: {
      direction: "incoming",
      messageId: "exchange-1",
      senderAgentId: "explorer",
      recipientAgentIds: ["vegapunk"],
      replyToMessageId: "request-1",
      deliveries: [],
      expectsReply: false,
    },
  });

  it("reads the status and next step of a teammate's reply", () => {
    const marker = toAgentMessage(reply("Status: needs-input\nNext: pick a palette\n\nTwo options.")).actionMarker;
    expect(marker?.kind === "agent-message" ? marker.report : undefined).toEqual({
      status: "needs-input",
      next: "pick a palette",
    });
    const note = toAgentMessage(
      reply("Status: blocked\nResult: OpenBot note, not written by this teammate: the request failed."),
    ).actionMarker;
    expect(note?.kind === "agent-message" ? note.report : undefined).toEqual({ status: "failed", next: null });
    const plain = toAgentMessage(reply("All done.")).actionMarker;
    expect(plain?.kind === "agent-message" ? plain.report : "missing").toBeUndefined();
  });

  it("shows the chip, with the next step as its title", () => {
    const marker = toAgentMessage(reply("Status: blocked\nNext: grant access")).actionMarker;
    if (!marker) throw new Error("No marker.");
    render(() => <ChatActionMarker marker={marker} agents={[]} onSelectAgent={vi.fn()} />);
    const chip = screen.getByText("Blocked");
    expect(chip.getAttribute("title")).toBe("Next: grant access");
  });
});
