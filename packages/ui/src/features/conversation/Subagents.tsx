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

const GENERAL_AGENT_TYPE = "general-purpose";

export type SubagentModelNames = (id: string) => string | undefined;

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

export function createClock(running: () => boolean) {
  const [now, setNow] = createSignal(Date.now());
  createEffect(running, (active) => {
    setNow(Date.now());
    if (!active) return;
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

export function LiveLine(props: { subagent: ConversationSubagent }) {
  const { t } = useText();
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

export function subagentPlanProgress(
  subagent: ConversationSubagent,
): { done: number; total: number; current: string | null } | undefined {
  const plan = subagent.plan;
  if (!plan?.length) return undefined;
  const now = plan.findLast((step) => step.status === "inProgress") ?? plan.find((step) => step.status !== "completed");
  return {
    done: plan.filter((step) => step.status === "completed").length,
    total: plan.length,
    current: now ? (now.activeText ?? now.text) : null,
  };
}

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
  selectedId?: string | null | undefined;
  onOpen: (subagentId: string) => void;
  /** Fork (#78): the names of the app's models, for the model each subagent runs on. */
  modelNames?: SubagentModelNames | undefined;
}

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

const DOCK_IN: KeyframeAnimationOptions = { duration: 340, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" };
const DOCK_OUT: KeyframeAnimationOptions = { ...DOCK_IN, duration: 260 };

function offset(from: DOMRect, to: DOMRect): string {
  return `translate(${from.left - to.left}px, ${from.top - to.top}px)`;
}

export interface SubagentDockProps {
  subagents: readonly ConversationSubagent[] | undefined;
  cardHeader: () => DOMRect | undefined;
  onReveal: () => void;
}

export function SubagentDock(props: SubagentDockProps) {
  const { t } = useText();
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
  subagent: ConversationSubagent | undefined;
  agentName: string;
  onClosePanel: () => void;
  modelNames?: SubagentModelNames | undefined;
  resizer?: JSX.Element;
}

export function SubagentPanel(props: SubagentPanelProps) {
  const { t } = useText();
  const duration = useDuration();
  const now = createClock(() => props.subagent?.status === "running");
  return (
    <aside
      id="subagent-panel"
      class="browser-panel subagents-panel"
      aria-label={t("conversation.sidePanel.pane.subagent")}
    >
      {props.resizer}
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
