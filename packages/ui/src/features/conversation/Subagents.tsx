import { claudeModelName } from "@openbot/contracts/agent-providers";
import {
  AGENT_REASONING_EFFORTS,
  type AgentReasoningEffort,
  type ConversationSubagent,
  type ConversationSubagentStatus,
  type ConversationSubagentStepKind,
} from "@openbot/contracts/ipc";
import { isOneOf } from "@openbot/contracts/runtime-values";
import type { AppTextKey, AppTranslate } from "@openbot/i18n";
import {
  Badge,
  Brain,
  Button,
  ChevronRight,
  CircleCheck,
  Code,
  File,
  Globe2,
  LoaderCircle,
  MessageCircle,
  Minus,
  Pencil,
  Puzzle,
  RadialProgress,
  Search,
  TriangleAlert,
  X,
} from "@openbot/ui";
import { useText } from "@openbot/ui/text";
import { prefersReducedMotion } from "@openbot/ui/utils";
import type { JSX } from "@solidjs/web";
import { createEffect, createMemo, createSignal, createUniqueId, For, Match, Show, Switch } from "solid-js";
import { ActivityShine } from "./ActivityShine";
import { TaskList } from "./TaskList";

const STATE_LABEL = {
  running: "chat.subagents.state.running",
  completed: "chat.subagents.state.completed",
  failed: "chat.subagents.state.failed",
  stopped: "chat.subagents.state.stopped",
} as const satisfies Record<ConversationSubagentStatus, AppTextKey>;

/** The Claude type of a subagent with no special role. The meta line does not name it. */
const GENERAL_AGENT_TYPE = "general-purpose";

/**
 * Fork (docs/fork/FEATURES.md #78): the name of a model id in the app's model list, or `undefined`
 * for an id the list does not have. The screen passes it; without one a model shows by its id.
 */
export type SubagentModelNames = (id: string) => string | undefined;

/** Fork: a `SubagentModelNames` that reads a model list, such as the model picker's. */
export function subagentModelNames(options: readonly { id: string; name: string }[]): SubagentModelNames {
  return (id) => options.find((option) => option.id === id)?.name;
}

const EFFORT_LABEL = {
  none: "provider.effort.none",
  minimal: "provider.effort.minimal",
  low: "provider.effort.low",
  medium: "provider.effort.medium",
  high: "provider.effort.high",
  xhigh: "provider.effort.xhigh",
  max: "provider.effort.max",
  ultra: "provider.effort.ultra",
} as const satisfies Record<AgentReasoningEffort, AppTextKey>;

/**
 * Fork (#78): the model and effort a subagent runs on, such as "Claude Opus 5.5 · High", or null
 * when neither is known. The name is the model picker's, else the Claude product name of the id,
 * else the id. `compact` drops the "Claude " that every Claude model starts with, for a row.
 */
export function subagentModelText(
  subagent: Pick<ConversationSubagent, "model" | "effort">,
  t: AppTranslate,
  names?: SubagentModelNames,
  compact = false,
): string | null {
  const id = subagent.model?.trim();
  const name = id ? (names?.(id) ?? claudeModelName(id) ?? id) : null;
  const shown = name && compact ? name.replace(/^Claude\s+/u, "") : name;
  const effort = subagent.effort?.trim().toLowerCase();
  const effortText = !effort
    ? null
    : isOneOf(AGENT_REASONING_EFFORTS, effort)
      ? t(EFFORT_LABEL[effort])
      : `${effort[0]?.toUpperCase()}${effort.slice(1)}`;
  const text = [shown, effortText].filter(Boolean).join(" · ");
  return text || null;
}

/** Fork (#78): the model a subagent runs on, muted, at the end of its row's title line. */
export function SubagentModel(props: { subagent: ConversationSubagent; names?: SubagentModelNames | undefined }) {
  const { t } = useText();
  const compact = () => subagentModelText(props.subagent, t, props.names, true);
  return (
    <Show when={compact()}>
      {(text) => (
        <span
          class="subagents-row-model"
          title={t("chat.subagents.model", {
            model: subagentModelText(props.subagent, t, props.names) ?? text(),
          })}
        >
          {text()}
        </span>
      )}
    </Show>
  );
}

/** The time now, once a second while `running` is true. */
export function createClock(running: () => boolean) {
  const [now, setNow] = createSignal(Date.now());
  createEffect(running, (active) => {
    setNow(Date.now());
    if (!active) return;
    // All clocks tick on the same wall-clock second, so the card and its bar show the same time.
    const nextSecond = () => 1_000 - (Date.now() % 1_000);
    const tick = () => {
      setNow(Date.now());
      timer = window.setTimeout(tick, nextSecond());
    };
    let timer = window.setTimeout(tick, nextSecond());
    return () => window.clearTimeout(timer);
  });
  return now;
}

function timeOf(value: string | null, fallback: number): number {
  const time = value === null ? Number.NaN : Date.parse(value);
  return Number.isFinite(time) ? time : fallback;
}

export function elapsedMs(subagent: ConversationSubagent, now: number): number {
  return timeOf(subagent.endedAt, now) - timeOf(subagent.startedAt, now);
}

/** "12s" or "1m 05s": the time of a subagent, or of a turn in its steps row. */
export function useDuration() {
  const { t } = useText();
  return (ms: number) => {
    const total = Math.max(0, Math.floor(ms / 1_000));
    if (total < 60) return t("chat.subagents.seconds", { seconds: total });
    return t("chat.subagents.minutes", {
      minutes: Math.floor(total / 60),
      seconds: String(total % 60).padStart(2, "0"),
    });
  };
}

function StepGlyph(props: { kind: ConversationSubagentStepKind; class: string }): JSX.Element {
  return (
    <Switch>
      <Match when={props.kind === "thinking"}>
        <Brain class={props.class} aria-hidden="true" />
      </Match>
      <Match when={props.kind === "search"}>
        <Search class={props.class} aria-hidden="true" />
      </Match>
      <Match when={props.kind === "read"}>
        <File class={props.class} aria-hidden="true" />
      </Match>
      <Match when={props.kind === "web"}>
        <Globe2 class={props.class} aria-hidden="true" />
      </Match>
      <Match when={props.kind === "edit"}>
        <Pencil class={props.class} aria-hidden="true" />
      </Match>
      <Match when={props.kind === "command"}>
        <Code class={props.class} aria-hidden="true" />
      </Match>
      <Match when={props.kind === "text"}>
        <MessageCircle class={props.class} aria-hidden="true" />
      </Match>
      <Match when={props.kind === "tool"}>
        <Puzzle class={props.class} aria-hidden="true" />
      </Match>
    </Switch>
  );
}

/** The state of one subagent, in the icons and colours of the chat action markers. */
export function SubagentStatus(props: { status: ConversationSubagentStatus }) {
  const { t } = useText();
  return (
    <span class="subagents-status" data-state={props.status} role="img" aria-label={t(STATE_LABEL[props.status])}>
      <Show when={props.status === "running"}>
        <LoaderCircle class="subagents-status-icon" aria-hidden="true" />
      </Show>
      <Show when={props.status === "completed"}>
        <CircleCheck class="subagents-status-icon" aria-hidden="true" />
      </Show>
      <Show when={props.status === "failed"}>
        <X class="subagents-status-icon" aria-hidden="true" />
      </Show>
      <Show when={props.status === "stopped"}>
        <Minus class="subagents-status-icon" aria-hidden="true" />
      </Show>
    </span>
  );
}

/**
 * Fork: a step as a person reads it. Home paths become `~/`, an agent folder's long id is cut to
 * its first block, a file step shows its folder and name, and a command loses its error redirects
 * (Elias, 8 Nov 2026: the live lines were `ls /Users/elias/OpenBot/Agents/agent-dfc2ff03-…`).
 * The full text stays in the panel's tooltip.
 */
export function readableStep(kind: ConversationSubagentStepKind, text: string): string {
  let value = text
    .replace(/\/(?:Users|home)\/[^/\s'"]+\//gu, "~/")
    .replace(/\bagent-([0-9a-f]{8})(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gu, "agent-$1…");
  if (kind === "read" || kind === "edit") {
    const parts = value.split("/").filter(Boolean);
    if (parts.length > 2) value = `…/${parts.slice(-2).join("/")}`;
  }
  if (kind === "command")
    value = value
      .replace(/\s*2>(?:&1|\/dev\/null)/gu, "")
      .replace(/\s+/gu, " ")
      .trim();
  return value;
}

/** What the subagent does now, with the icon of that kind of step, or how it ended. */
export function LiveLine(props: { subagent: ConversationSubagent }) {
  const { t } = useText();
  /** The step that the line shows: the current step, or the answer of a subagent that ended. */
  const shown = () => {
    const last = props.subagent.steps.at(-1);
    if (props.subagent.status === "running") return last;
    return props.subagent.status !== "failed" && last?.kind === "text" ? last : undefined;
  };
  const text = () => {
    const subagent = props.subagent;
    if (subagent.status === "failed") return subagent.error ?? t(STATE_LABEL.failed);
    const step = shown();
    return step ? readableStep(step.kind, step.text) : t(STATE_LABEL[subagent.status]);
  };
  return (
    <span class="subagents-live" data-state={props.subagent.status}>
      <Show when={shown()}>{(step) => <StepGlyph kind={step().kind} class="subagents-live-glyph" />}</Show>
      <span class={["subagents-live-text", { "agent-activity-label": props.subagent.status === "running" }]}>
        {text()}
        <Show when={props.subagent.status === "running"}>
          <ActivityShine text={text()} />
        </Show>
      </span>
    </span>
  );
}

/**
 * Fork: how far a subagent's own task list is, and the step it does now. `undefined` without a list.
 */
export function subagentPlanProgress(
  subagent: ConversationSubagent,
): { done: number; total: number; current: string | null } | undefined {
  const plan = subagent.plan;
  if (!plan?.length) return undefined;
  // A subagent's task list has no current step; the last running one is the newest work.
  const now = plan.findLast((step) => step.status === "inProgress") ?? plan.find((step) => step.status !== "completed");
  return {
    done: plan.filter((step) => step.status === "completed").length,
    total: plan.length,
    current: now ? (now.activeText ?? now.text) : null,
  };
}

/** "2/5" with its ring: a subagent's own task list. */
export function SubagentPlanBadge(props: { subagent: ConversationSubagent }) {
  const { t } = useText();
  return (
    <Show when={subagentPlanProgress(props.subagent)}>
      {(progress) => (
        <Badge class="subagents-progress subagents-plan-badge">
          <RadialProgress
            class="subagents-ring"
            aria-hidden="true"
            value={(progress().done / Math.max(progress().total, 1)) * 100}
          />
          {t("chat.taskList.count", { done: progress().done, total: progress().total })}
        </Badge>
      )}
    </Show>
  );
}

/** How far the subagents of one turn are, and their time together, which runs while one works. */
function createGroupProgress(subagents: () => readonly ConversationSubagent[]) {
  const duration = useDuration();
  const total = () => subagents().length;
  const running = () => subagents().filter((subagent) => subagent.status === "running").length;
  const failed = () => subagents().filter((subagent) => subagent.status === "failed").length;
  const finished = () => total() - running();
  const now = createClock(() => running() > 0);
  const elapsed = createMemo(() => {
    const current = now();
    const start = Math.min(...subagents().map((subagent) => timeOf(subagent.startedAt, current)));
    const end = running() > 0 ? current : Math.max(...subagents().map((subagent) => timeOf(subagent.endedAt, current)));
    return duration(end - start);
  });
  return { total, running, failed, finished, now, elapsed };
}

/** The ring and "1 of 3" of subagents that still work. */
function RunningProgress(props: { finished: number; total: number }) {
  const { t } = useText();
  return (
    <Badge class="subagents-progress">
      <RadialProgress
        class="subagents-ring"
        aria-label={t("chat.subagents.progressLabel")}
        value={(props.finished / Math.max(props.total, 1)) * 100}
      />
      {t("chat.subagents.progress", { finished: props.finished, total: props.total })}
    </Badge>
  );
}

export interface SubagentGroupProps {
  subagents: readonly ConversationSubagent[];
  /** The subagent that the side panel shows now. */
  selectedId?: string | null | undefined;
  /** Opens the subagent in the side panel, or closes the panel when it shows that subagent. */
  onOpen: (subagentId: string) => void;
  /** Fork (#78): the names of the app's models, for the model each subagent runs on. */
  modelNames?: SubagentModelNames | undefined;
}

/**
 * The subagents that an agent started in one turn. The header shows how far they are and opens or
 * closes the list; the list is open while a subagent works, unless the user chose. Each row shows
 * what its subagent does now. A click on a row opens its steps in the side panel.
 */
export function SubagentGroup(props: SubagentGroupProps) {
  const { t } = useText();
  const duration = useDuration();
  const listId = createUniqueId();
  const { total, running, failed, finished, now, elapsed: groupElapsed } = createGroupProgress(() => props.subagents);
  const [choice, setChoice] = createSignal<boolean>();
  const expanded = () => choice() ?? running() > 0;
  const rowLabel = (subagent: ConversationSubagent) =>
    t("chat.subagents.open", {
      title: subagent.title,
      state: t(STATE_LABEL[subagent.status]).toLocaleLowerCase(),
    });
  return (
    <section class="subagents-group" aria-label={t("chat.subagents.label")}>
      <Button
        type="button"
        variant="ghost"
        class="subagents-group-header"
        aria-expanded={expanded() ? "true" : "false"}
        aria-controls={expanded() ? listId : undefined}
        onClick={() => setChoice(!expanded())}
      >
        <span class="subagents-group-title">
          {running() > 0
            ? t("chat.subagents.running", { count: total() })
            : t("chat.subagents.ran", { count: total() })}
        </span>
        <Show
          when={running() > 0}
          fallback={
            <Badge class="subagents-progress">
              {t("chat.subagents.done", { count: finished() - failed() })}
              <Show when={failed() > 0}>
                <span class="subagents-progress-failed">· {t("chat.subagents.failed", { count: failed() })}</span>
              </Show>
            </Badge>
          }
        >
          <RunningProgress finished={finished()} total={total()} />
        </Show>
        <span class="subagents-elapsed">{groupElapsed()}</span>
        <ChevronRight class="subagents-group-chevron" aria-hidden="true" />
      </Button>
      <Show when={expanded()}>
        <ul id={listId} class="subagents-list">
          <For each={props.subagents} keyed={(subagent) => subagent.id}>
            {(subagent) => {
              const selected = () => props.selectedId === subagent().id;
              return (
                <li>
                  <Button
                    type="button"
                    variant="ghost"
                    class={["subagents-row", { "subagents-row-selected": selected() }]}
                    aria-current={selected() ? "true" : undefined}
                    aria-label={rowLabel(subagent())}
                    onClick={() => props.onOpen(subagent().id)}
                  >
                    <SubagentStatus status={subagent().status} />
                    <span class="subagents-row-copy">
                      <span class="subagents-row-title subagents-row-title-model">
                        <span class="subagents-row-title-text">{subagent().title}</span>
                        <SubagentModel subagent={subagent()} names={props.modelNames} />
                      </span>
                      <LiveLine subagent={subagent()} />
                    </span>
                    <SubagentPlanBadge subagent={subagent()} />
                    <span class="subagents-elapsed">{duration(elapsedMs(subagent(), now()))}</span>
                    <ChevronRight class="subagents-row-chevron" aria-hidden="true" />
                  </Button>
                </li>
              );
            }}
          </For>
        </ul>
      </Show>
    </section>
  );
}

/** The morph between the card header in the chat and the bar under the chat header. */
const DOCK_IN: KeyframeAnimationOptions = { duration: 340, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" };
const DOCK_OUT: KeyframeAnimationOptions = { ...DOCK_IN, duration: 260 };

/** The offset from `to` to `from`, for a FLIP transform. */
function offset(from: DOMRect, to: DOMRect): string {
  return `translate(${from.left - to.left}px, ${from.top - to.top}px)`;
}

export interface SubagentDockProps {
  /** The subagents of a card that is out of view while one of them works. Otherwise `undefined`. */
  subagents: readonly ConversationSubagent[] | undefined;
  /** Where the header of that card is, held inside the chat view; `undefined` when it is not drawn. */
  cardHeader: () => DOMRect | undefined;
  /** Scrolls the chat back to the card. */
  onReveal: () => void;
}

/**
 * The header of a subagent card that the reader scrolled away from while its subagents work. It
 * morphs from the card to a bar under the chat header, with what a subagent does now, and back when
 * the card shows again. A click scrolls back to the card.
 */
export function SubagentDock(props: SubagentDockProps) {
  const { t } = useText();
  // The bar keeps its last subagents while it morphs back to the card.
  const [shown, setShown] = createSignal<readonly ConversationSubagent[]>();
  let bar: HTMLElement | undefined;
  let leaving: Animation | undefined;
  createEffect(
    () => props.subagents,
    (subagents) => {
      if (subagents) {
        leaving?.cancel();
        leaving = undefined;
        setShown(() => subagents);
        return;
      }
      // The bar morphs back once; a second change while it leaves does not start a second morph.
      if (leaving) return;
      const target = props.cardHeader();
      if (!bar?.isConnected || !target || prefersReducedMotion()) {
        setShown(undefined);
        return;
      }
      const animation = bar.animate(
        [
          { transform: "none", opacity: 1 },
          { transform: offset(target, bar.getBoundingClientRect()), opacity: 0 },
        ],
        DOCK_OUT,
      );
      leaving = animation;
      const done = () => {
        if (leaving !== animation) return;
        leaving = undefined;
        setShown(undefined);
      };
      animation.finished.then(done, done);
    },
  );
  const morphIn = (element: HTMLElement) => {
    bar = element;
    requestAnimationFrame(() => {
      const from = props.cardHeader();
      if (!from || prefersReducedMotion() || !element.isConnected) return;
      element.animate(
        [
          { transform: offset(from, element.getBoundingClientRect()), opacity: 0.2 },
          { transform: "none", opacity: 1 },
        ],
        DOCK_IN,
      );
    });
  };
  return (
    <div class="subagents-dock">
      <Show when={shown()}>
        {(subagents) => {
          const progress = createGroupProgress(subagents);
          /** The newest step of a subagent that works: what the team of the agent does now. */
          const current = () => subagents().find((subagent) => subagent.status === "running");
          return (
            <Button
              ref={morphIn}
              type="button"
              variant="ghost"
              class="subagents-dock-bar no-drag"
              onClick={() => props.onReveal()}
            >
              <span class="subagents-group-title">{t("chat.subagents.running", { count: progress.total() })}</span>
              <RunningProgress finished={progress.finished()} total={progress.total()} />
              <span class="subagents-dock-live">
                <Show when={current()}>{(subagent) => <LiveLine subagent={subagent()} />}</Show>
              </span>
              <span class="subagents-elapsed">{progress.elapsed()}</span>
              <ChevronRight class="subagents-dock-chevron" aria-hidden="true" />
            </Button>
          );
        }}
      </Show>
    </div>
  );
}

export interface SubagentPanelProps {
  /** The subagent to show. A subagent that is not in the chat any more shows an empty pane. */
  subagent: ConversationSubagent | undefined;
  /** The agent that started the subagent. */
  agentName: string;
  onClosePanel: () => void;
  /** Fork (#78): the names of the app's models, for the model the subagent runs on. */
  modelNames?: SubagentModelNames | undefined;
}

/** The side panel pane of one subagent: its task, its state, and all of its steps. */
export function SubagentPanel(props: SubagentPanelProps) {
  const { t } = useText();
  const duration = useDuration();
  const now = createClock(() => props.subagent?.status === "running");
  return (
    <aside class="browser-panel subagents-panel" aria-label={t("conversation.sidePanel.pane.subagent")}>
      <header class="file-preview-header side-panel-pane-header">
        <h2 class="side-panel-pane-title">{t("conversation.sidePanel.pane.subagent")}</h2>
        <Button
          type="button"
          variant="ghost"
          class="browser-toolbar-button side-panel-pane-close"
          aria-label={t("conversation.sidePanel.closePanel")}
          onClick={() => props.onClosePanel()}
        >
          <X class="browser-toolbar-icon" />
        </Button>
      </header>
      <Show when={props.subagent}>
        {(subagent) => (
          <section class="subagents-panel-detail" aria-label={subagent().title}>
            <div class="subagents-panel-head">
              <SubagentStatus status={subagent().status} />
              <h3 dir="auto">{subagent().title}</h3>
            </div>
            <p class="subagents-panel-meta">
              {[
                subagent().agentType === GENERAL_AGENT_TYPE ? null : subagent().agentType,
                // Fork (#78): the model and effort the subagent runs on.
                subagentModelText(subagent(), t, props.modelNames),
                t(STATE_LABEL[subagent().status]),
                duration(elapsedMs(subagent(), now())),
                t("chat.subagents.stepCount", { count: subagent().steps.length }),
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
            <div class="subagents-steps">
              <Show when={subagent().plan?.length ? subagent().plan : undefined}>
                {(plan) => (
                  <TaskList
                    items={plan().map((step, index) => ({
                      id: String(index),
                      label:
                        step.status === "inProgress" && subagent().status === "running"
                          ? (step.activeText ?? step.text)
                          : step.text,
                      state:
                        step.status === "completed"
                          ? "done"
                          : step.status === "inProgress" && subagent().status === "running"
                            ? "active"
                            : "pending",
                    }))}
                  />
                )}
              </Show>
              <Show when={subagent().prompt}>
                {(prompt) => {
                  // Fork: a brief is often a page long; it folds to three lines so the work shows first.
                  const [briefOpen, setBriefOpen] = createSignal(false);
                  const long = () => prompt().length > 240 || prompt().split("\n").length > 3;
                  return (
                    <div class="subagents-prompt" data-open={briefOpen() || !long() ? "true" : undefined}>
                      <span class="subagents-prompt-label">
                        {t("chat.subagents.taskFrom", { name: props.agentName })}
                      </span>
                      <span class="subagents-prompt-text" dir="auto">
                        {prompt()}
                      </span>
                      <Show when={long()}>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          class="subagents-prompt-toggle"
                          aria-expanded={briefOpen() ? "true" : "false"}
                          onClick={() => setBriefOpen(!briefOpen())}
                        >
                          {briefOpen() ? t("chat.subagents.hideBrief") : t("chat.subagents.showBrief")}
                        </Button>
                      </Show>
                    </div>
                  );
                }}
              </Show>
              <ol class="subagents-step-list" aria-label={t("chat.subagents.steps", { title: subagent().title })}>
                <For each={subagent().steps} keyed={(step) => step.id}>
                  {(step, index) => {
                    const live = () => subagent().status === "running" && index() === subagent().steps.length - 1;
                    return (
                      <li class="subagents-step" data-kind={step().kind}>
                        <StepGlyph kind={step().kind} class="subagents-step-glyph" />
                        {/* A command reads left to right; other steps take their direction from their text. */}
                        <span
                          class={["subagents-step-text", { "agent-activity-label": live() }]}
                          dir={step().kind === "command" ? "ltr" : "auto"}
                          title={step().text}
                        >
                          {readableStep(step().kind, step().text)}
                          <Show when={live()}>
                            <ActivityShine text={readableStep(step().kind, step().text)} />
                          </Show>
                        </span>
                      </li>
                    );
                  }}
                </For>
              </ol>
              <Show when={subagent().error}>
                {(error) => (
                  <p class="subagents-error">
                    <TriangleAlert class="subagents-error-icon" aria-hidden="true" />
                    {error()}
                  </p>
                )}
              </Show>
            </div>
          </section>
        )}
      </Show>
    </aside>
  );
}
