/**
 * Fork (docs/fork/FEATURES.md #134, "Team board"): a lead's team board in the app, read from the host
 * and read again when a queue, a turn or the agent list changes (throttled), and every 20 s while
 * something shows it. The header button and the side panel pane of one chat share one read.
 */
import type { TeamBoard, TeamBoardLead } from "@openbot/contracts/fork-team-board";
import type { OpenBotDesktopApi } from "@openbot/contracts/ipc";
import { type Accessor, createEffect, createSignal } from "solid-js";

const REFRESH_DEBOUNCE_MS = 400;
const POLL_MS = 20_000;
const CLOCK_MS = 30_000;
const CHANGE_EVENTS: ReadonlySet<string> = new Set([
  "queue-changed",
  "queue-invalidated",
  "turn-started",
  "turn-completed",
  "agents-changed",
  "hidden-agents-changed",
]);

export type TeamBoardApi = Pick<OpenBotDesktopApi["agent"], "forkTeamBoard" | "onEvent">;

interface Entry {
  lead: Accessor<TeamBoardLead | null | undefined>;
  windowHours: Accessor<number>;
  error: Accessor<boolean>;
  refresh: () => void;
  refs: number;
  dispose: () => void;
}

const entries = new Map<string, Entry>();
const [clock, setClock] = createSignal(Date.now());
let clockTimer: ReturnType<typeof setInterval> | null = null;

function acquire(leadId: string, api: TeamBoardApi): Entry {
  const known = entries.get(leadId);
  if (known) {
    known.refs += 1;
    return known;
  }
  const [lead, setLead] = createSignal<TeamBoardLead | null | undefined>(undefined);
  const [windowHours, setWindowHours] = createSignal(24);
  const [error, setError] = createSignal(false);
  let reads = 0;
  let debounce: ReturnType<typeof setTimeout> | null = null;
  const read = () => {
    const current = ++reads;
    void api.forkTeamBoard({ leadId }).then(
      (board: TeamBoard) => {
        if (current !== reads) return;
        setLead(board.leads.find((candidate) => candidate.leadId === leadId) ?? null);
        setWindowHours(board.windowHours);
        setError(false);
        setClock(Date.now());
      },
      () => {
        if (current === reads) setError(true);
      },
    );
  };
  // At most one read per REFRESH_DEBOUNCE_MS, also while changes keep coming.
  const refresh = () => {
    if (debounce) return;
    debounce = setTimeout(() => {
      debounce = null;
      read();
    }, REFRESH_DEBOUNCE_MS);
  };
  const unsubscribe = api.onEvent((event) => {
    if (CHANGE_EVENTS.has(event.type)) refresh();
  });
  const poll = setInterval(read, POLL_MS);
  const entry: Entry = {
    lead,
    windowHours,
    error,
    refresh: read,
    refs: 1,
    dispose: () => {
      unsubscribe();
      clearInterval(poll);
      if (debounce) clearTimeout(debounce);
      reads += 1;
    },
  };
  entries.set(leadId, entry);
  clockTimer ??= setInterval(() => setClock(Date.now()), CLOCK_MS);
  read();
  return entry;
}

function release(leadId: string): void {
  const entry = entries.get(leadId);
  if (!entry) return;
  entry.refs -= 1;
  if (entry.refs > 0) return;
  entry.dispose();
  entries.delete(leadId);
  if (entries.size === 0 && clockTimer) {
    clearInterval(clockTimer);
    clockTimer = null;
  }
}

export interface TeamBoardView {
  /** Undefined while the first read runs; null when the agent leads nobody. */
  lead: Accessor<TeamBoardLead | null | undefined>;
  windowHours: Accessor<number>;
  error: Accessor<boolean>;
  now: Accessor<number>;
  refresh: () => void;
}

/** The board of the lead `leadId()`, while it is defined. */
export function useTeamBoard(leadId: Accessor<string | undefined>, api?: TeamBoardApi): TeamBoardView {
  const [entry, setEntry] = createSignal<Entry | null>(null);
  createEffect(leadId, (id) => {
    if (!id) {
      setEntry(null);
      return;
    }
    const acquired = acquire(id, api ?? window.openbot.agent);
    setEntry(acquired);
    return () => {
      release(id);
    };
  });
  return {
    lead: () => entry()?.lead(),
    windowHours: () => entry()?.windowHours() ?? 24,
    error: () => entry()?.error() ?? false,
    now: clock,
    refresh: () => entry()?.refresh(),
  };
}

/**
 * The agent whose team board this chat shows: the chat's agent, on this computer (the board reads the
 * local mailbox), not in a channel or the web client.
 */
export function teamBoardLeadId(
  props: { agent?: { id: string } | null | undefined; server?: { kind: string } | null | undefined; runtime?: unknown },
  channel: unknown,
): string | undefined {
  if (!props.agent || channel || props.runtime || props.server?.kind !== "local") return undefined;
  return props.agent.id;
}
