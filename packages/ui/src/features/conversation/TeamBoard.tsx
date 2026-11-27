/**
 * Fork (docs/fork/FEATURES.md #134, "Team board"): a lead agent's teammates in the side panel, one row
 * each: its current request and state, whether it works now, its last report with status, next step
 * and age. A row opens the teammate's chat; Message opens it with the composer ready.
 */
import type {
  TeamBoardReport,
  TeamBoardRow,
  TeamBoardState,
  TeamMemberActivity,
  TeamReportStatus,
} from "@openbot/contracts/fork-team-board";
import type { AppTextKey, AppTranslate } from "@openbot/i18n";
import { Badge, Button, MessageSquare, RefreshCw } from "@openbot/ui";
import type { JSX } from "@solidjs/web";
import { For, Show } from "solid-js";
import type { AgentProfile } from "../../data";
import { useText } from "../../text";
import { AgentAvatar } from "../agents/AgentAvatar";

type BadgeVariant = "secondary" | "info-light" | "success-light" | "warning-light" | "destructive-light" | "outline";

const STATE_LABEL = {
  queued: "conversation.team.state.queued",
  working: "conversation.team.state.working",
  done: "conversation.team.state.done",
  progress: "conversation.team.state.progress",
  partial: "conversation.team.state.partial",
  blocked: "conversation.team.state.blocked",
  "needs-input": "conversation.team.state.needsInput",
  replied: "conversation.team.state.replied",
  failed: "conversation.team.state.failed",
  overdue: "conversation.team.state.overdue",
} as const satisfies Record<TeamBoardState, AppTextKey>;

const STATE_VARIANT: Record<TeamBoardState, BadgeVariant> = {
  queued: "secondary",
  working: "info-light",
  done: "success-light",
  progress: "info-light",
  partial: "warning-light",
  blocked: "destructive-light",
  "needs-input": "warning-light",
  replied: "outline",
  failed: "destructive-light",
  overdue: "warning-light",
};

const ACTIVITY_LABEL = {
  working: "conversation.team.live.working",
  queued: "conversation.team.live.queued",
  idle: "conversation.team.live.idle",
} as const satisfies Record<TeamMemberActivity, AppTextKey>;

/** The states that need the lead or the user. */
export const TEAM_ATTENTION_STATES: ReadonlySet<TeamBoardState> = new Set([
  "needs-input",
  "blocked",
  "failed",
  "overdue",
]);

export function teamStateLabel(state: TeamBoardState | TeamReportStatus, t: AppTranslate): string {
  return t(STATE_LABEL[state]);
}

/** A report status or a board state as a coloured chip. */
export function TeamStateChip(props: { state: TeamBoardState | TeamReportStatus; title?: string | undefined }) {
  const { t } = useText();
  return (
    <Badge
      variant={STATE_VARIANT[props.state]}
      class="team-state-chip"
      data-team-state={props.state}
      title={props.title}
    >
      {teamStateLabel(props.state, t)}
    </Badge>
  );
}

/** "just now", "9 min ago", "3 h ago", "2 d ago". */
export function teamAge(at: string, now: number, t: AppTranslate): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(at)) / 60_000));
  if (minutes < 1) return t("conversation.team.age.now");
  if (minutes < 60) return t("conversation.team.age.minutes", { minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return t("conversation.team.age.hours", { hours });
  return t("conversation.team.age.days", { days: Math.floor(hours / 24) });
}

/** The chip of a report: its status (an OpenBot note is a failure), unless the row's state says it. */
function reportChip(report: TeamBoardReport, state: TeamBoardState): TeamBoardState | TeamReportStatus | null {
  const chip = report.openBotNote ? "failed" : report.status;
  return chip && (chip !== state || !report.current) ? chip : null;
}

export interface TeamBoardPaneProps {
  leadName: string;
  /** Undefined while the first read runs. */
  rows: readonly TeamBoardRow[] | undefined;
  windowHours: number;
  error: boolean;
  agents: readonly AgentProfile[];
  now: number;
  /** The teammate whose chat is opening, for instant feedback. */
  opening?: string | null | undefined;
  resizer?: JSX.Element;
  onOpenTeammate: (teammateId: string) => void;
  onMessageTeammate: (teammateId: string) => void;
  onRetry: () => void;
}

function TeamBoardRowView(props: {
  row: TeamBoardRow;
  agent: AgentProfile | undefined;
  now: number;
  opening: boolean;
  onOpen: () => void;
  onMessage: () => void;
}) {
  const { t } = useText();
  const report = () => props.row.report;
  return (
    <li
      class="team-board-item"
      data-team-state={props.row.state}
      data-activity={props.row.activity}
      aria-busy={props.opening ? "true" : undefined}
    >
      <Button
        variant="ghost"
        class="team-board-row"
        aria-label={t("conversation.team.openChat", { name: props.row.teammateName })}
        onClick={() => props.onOpen()}
      >
        <span class="team-board-head">
          <span class="team-board-avatar" title={t(ACTIVITY_LABEL[props.row.activity])}>
            <AgentAvatar agent={props.agent} seed={props.agent ? undefined : props.row.teammateId} />
            <span class="team-board-live" data-activity={props.row.activity} aria-hidden="true" />
          </span>
          <span class="team-board-name" dir="auto">
            {props.row.teammateName}
          </span>
          <TeamStateChip state={props.row.state} />
          <span class="team-board-live-label">{t(ACTIVITY_LABEL[props.row.activity])}</span>
        </span>
        <span class="team-board-request" dir="auto">
          {props.row.request}
        </span>
        <span class="team-board-meta">
          {t("conversation.team.asked", { time: teamAge(props.row.sentAt, props.now, t) })}
        </span>
        <Show
          when={report()}
          fallback={<span class="team-board-report team-board-report-empty">{t("conversation.team.noReport")}</span>}
        >
          {(shown) => (
            <span class="team-board-report" data-current={shown().current ? "true" : "false"}>
              <span class="team-board-report-line">
                <Show when={reportChip(shown(), props.row.state)}>{(state) => <TeamStateChip state={state()} />}</Show>
                <span class="team-board-report-text" dir="auto">
                  {shown().excerpt}
                </span>
              </span>
              <Show when={shown().next}>
                {(next) => (
                  <span class="team-board-next" dir="auto">
                    {t("conversation.team.next", { next: next() })}
                  </span>
                )}
              </Show>
              <span class="team-board-meta">
                {t(shown().current ? "conversation.team.reported" : "conversation.team.earlierReport", {
                  time: teamAge(shown().at, props.now, t),
                })}
              </span>
            </span>
          )}
        </Show>
        <Show when={props.row.earlierOpen > 0}>
          <span class="team-board-meta team-board-earlier">
            {t("conversation.team.earlierOpen", { count: props.row.earlierOpen })}
          </span>
        </Show>
      </Button>
      <Button
        variant="secondary"
        size="sm"
        class="team-board-message"
        aria-label={t("conversation.team.messageLabel", { name: props.row.teammateName })}
        onClick={() => props.onMessage()}
      >
        <MessageSquare aria-hidden="true" />
        {t("conversation.team.message")}
      </Button>
    </li>
  );
}

export function TeamBoardPane(props: TeamBoardPaneProps) {
  const { t } = useText();
  const counts = () => {
    const tally = new Map<TeamBoardState, number>();
    for (const row of props.rows ?? []) tally.set(row.state, (tally.get(row.state) ?? 0) + 1);
    return [...tally];
  };
  return (
    <aside
      id="team-board-panel"
      class="browser-panel team-board-pane"
      aria-label={t("conversation.sidePanel.pane.team")}
    >
      {props.resizer}
      <div class="team-board-scroll">
        <div class="team-board-summary">
          <h2 class="team-board-title" dir="auto">
            {t("conversation.team.title", { name: props.leadName })}
          </h2>
          <Show when={counts().length > 0}>
            <ul class="team-board-counts" aria-label={t("conversation.team.counts")}>
              <For each={counts()} keyed={(entry) => entry[0]}>
                {(entry) => (
                  <li>
                    <TeamStateChip state={entry()[0]} />
                    <span class="team-board-count">{entry()[1]}</span>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </div>
        <Show when={props.error}>
          <div class="team-board-error" role="alert">
            <span>{t("conversation.team.loadFailed")}</span>
            <Button variant="secondary" size="sm" onClick={() => props.onRetry()}>
              <RefreshCw aria-hidden="true" />
              {t("conversation.team.retry")}
            </Button>
          </div>
        </Show>
        <Show
          when={props.rows}
          fallback={
            <Show when={!props.error}>
              <p class="team-board-empty" role="status">
                {t("conversation.team.loading")}
              </p>
            </Show>
          }
        >
          {(rows) => (
            <Show
              when={rows().length > 0}
              fallback={
                <div class="team-board-empty">
                  <p class="team-board-empty-title">{t("conversation.team.empty", { hours: props.windowHours })}</p>
                  <p>{t("conversation.team.emptyHint")}</p>
                </div>
              }
            >
              <ul class="team-board-list" aria-label={t("conversation.team.list")}>
                <For each={rows()} keyed={(row) => row.teammateId}>
                  {(row) => (
                    <TeamBoardRowView
                      row={row()}
                      agent={props.agents.find((agent) => agent.id === row().teammateId)}
                      now={props.now}
                      opening={props.opening === row().teammateId}
                      onOpen={() => props.onOpenTeammate(row().teammateId)}
                      onMessage={() => props.onMessageTeammate(row().teammateId)}
                    />
                  )}
                </For>
              </ul>
            </Show>
          )}
        </Show>
      </div>
    </aside>
  );
}
