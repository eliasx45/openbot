/**
 * Fork: the live work of a chat in one bar under its header (Elias, 8 Nov 2026: "i keep asking
 * 'whats the progress'"). It shows while anything works: what waits for the person, then each agent
 * with its own plan and, under it, every subagent it started, each with its own task list. A click
 * opens the tree; a subagent row opens its steps on the side, a plan row scrolls to the plan. A click
 * on an agent's name in the chat's working line opens the tree at that agent (`focusLiveWork`).
 */

import type { ConversationSubagent } from "@openbot/contracts/ipc";
import { Badge, Button, ChevronRight, CircleAlert, ListChecks, RadialProgress } from "@openbot/ui";
import { useText } from "@openbot/ui/text";
import { createEffect, createMemo, createSignal, createUniqueId, For, Show } from "solid-js";
import {
  createClock,
  elapsedMs,
  LiveLine,
  SubagentPlanBadge,
  SubagentStatus,
  subagentPlanProgress,
  useDuration,
} from "./Subagents";

export interface LiveWorkPlan {
  title: string | null;
  done: number;
  total: number;
  current: string | null;
}

export type LiveWorkItem =
  | { kind: "subagent"; key: string; cardId: string; agentId: string | undefined; subagent: ConversationSubagent }
  | { kind: "plan"; key: string; cardId: string; agentId: string | undefined; plan: LiveWorkPlan }
  /** Something that waits for the person: a question or an approval. */
  | { kind: "waiting"; key: string; agentId: string | undefined; label: string };

type SubagentWork = Extract<LiveWorkItem, { kind: "subagent" }>;
type PlanWork = Extract<LiveWorkItem, { kind: "plan" }>;
type WaitingWork = Extract<LiveWorkItem, { kind: "waiting" }>;

interface AgentWork {
  agentId: string | undefined;
  plan: PlanWork | undefined;
  subagents: SubagentWork[];
}

/** A click on a name in the working line: the bar opens at that agent. */
const [focus, setFocus] = createSignal<{ agentId: string; at: number }>();
export function focusLiveWork(agentId: string): void {
  setFocus({ agentId, at: Date.now() });
}

export interface LiveWorkDockProps {
  /** All the live work of the chat, empty when nothing works. */
  items: readonly LiveWorkItem[];
  /** The name of the agent that does a piece of work; `undefined` is the chat's own agent. */
  agentName: (agentId: string | undefined) => string;
  /** Opens a subagent on the side. */
  onOpenSubagent: (subagentId: string) => void;
  /** Scrolls the chat to a card. */
  onReveal: (cardId: string) => void;
}

export function LiveWorkDock(props: LiveWorkDockProps) {
  const { t, format } = useText();
  const duration = useDuration();
  const listId = createUniqueId();
  const [open, setOpen] = createSignal(false);
  const [focused, setFocused] = createSignal<string>();
  let list: HTMLUListElement | undefined;
  const waiting = () => props.items.flatMap((item): WaitingWork[] => (item.kind === "waiting" ? [item] : []));
  const subagents = () => props.items.flatMap((item): SubagentWork[] => (item.kind === "subagent" ? [item] : []));
  /** One group per agent, in the order its work started, with its plan first. */
  const groups = createMemo(() => {
    const byAgent = new Map<string, AgentWork>();
    const group = (agentId: string | undefined) => {
      const key = agentId ?? "";
      let found = byAgent.get(key);
      if (!found) {
        found = { agentId, plan: undefined, subagents: [] };
        byAgent.set(key, found);
      }
      return found;
    };
    for (const item of props.items) {
      if (item.kind === "plan") group(item.agentId).plan = item;
      if (item.kind === "subagent") group(item.agentId).subagents.push(item);
    }
    return [...byAgent.values()];
  });
  const now = createClock(() => subagents().length > 0);
  const workCount = () => subagents().length + groups().filter((entry) => entry.plan).length;
  const names = createMemo(() => groups().map((entry) => props.agentName(entry.agentId)));
  const newest = () => subagents().at(-1);
  const elapsed = () => {
    const starts = subagents()
      .map((item) => Date.parse(item.subagent.startedAt))
      .filter(Number.isFinite);
    return starts.length ? duration(now() - Math.min(...starts)) : "";
  };

  createEffect(focus, (request) => {
    if (!request || !groups().some((entry) => entry.agentId === request.agentId)) return;
    setOpen(true);
    setFocused(request.agentId);
    requestAnimationFrame(() =>
      list
        ?.querySelector(`[data-agent="${CSS.escape(request.agentId)}"]`)
        ?.scrollIntoView({ block: "nearest", behavior: "smooth" }),
    );
    const timer = window.setTimeout(() => setFocused(undefined), 1600);
    return () => window.clearTimeout(timer);
  });

  return (
    <div class="subagents-dock live-work-dock">
      <Show when={props.items.length > 0}>
        <div class="live-work-panel" data-open={open() ? "true" : undefined}>
          <Button
            type="button"
            variant="ghost"
            class="subagents-dock-bar live-work-bar no-drag"
            aria-expanded={open() ? "true" : "false"}
            aria-controls={open() ? listId : undefined}
            onClick={() => setOpen(!open())}
          >
            <span class="live-work-pulse" aria-hidden="true" />
            <span class="subagents-group-title">{t("chat.liveWork.title", { count: workCount() })}</span>
            <Show when={waiting().length > 0}>
              <Badge class="live-work-waiting-badge">{t("chat.liveWork.waiting", { count: waiting().length })}</Badge>
            </Show>
            <span class="live-work-names">{format.list(names())}</span>
            <span class="subagents-dock-live">
              <Show when={newest()}>
                {(found) => (
                  <Show
                    when={subagentPlanProgress(found().subagent)?.current}
                    fallback={<LiveLine subagent={found().subagent} />}
                  >
                    {(current) => (
                      <span class="subagents-live">
                        <span class="subagents-live-text agent-activity-label">{current()}</span>
                      </span>
                    )}
                  </Show>
                )}
              </Show>
            </span>
            <span class="subagents-elapsed">{elapsed()}</span>
            <ChevronRight class="subagents-dock-chevron live-work-chevron" aria-hidden="true" />
          </Button>
          <Show when={open()}>
            <ul id={listId} ref={(element) => (list = element)} class="subagents-list live-work-list">
              <For each={waiting()} keyed={(item) => item.key}>
                {(item) => (
                  <li class="live-work-waiting">
                    <CircleAlert class="live-work-waiting-icon" aria-hidden="true" />
                    <span class="subagents-row-copy">
                      <span class="subagents-row-title">
                        <span class="live-work-agent">{props.agentName(item().agentId)}</span>
                        {t("chat.liveWork.waitsForYou")}
                      </span>
                      <span class="subagents-live">
                        <span class="subagents-live-text">{item().label}</span>
                      </span>
                    </span>
                  </li>
                )}
              </For>
              <For each={groups()} keyed={(entry) => entry.agentId ?? ""}>
                {(entry) => (
                  <li
                    class="live-work-group"
                    data-agent={entry().agentId ?? ""}
                    data-focused={focused() !== undefined && focused() === entry().agentId ? "true" : undefined}
                  >
                    <Button
                      type="button"
                      variant="ghost"
                      class="subagents-row live-work-row live-work-agent-row"
                      disabled={!entry().plan}
                      onClick={() => {
                        const plan = entry().plan;
                        if (plan) props.onReveal(plan.cardId);
                      }}
                    >
                      <ListChecks class="live-work-plan-icon" aria-hidden="true" />
                      <span class="subagents-row-copy">
                        <span class="subagents-row-title">
                          <span class="live-work-agent-name">{props.agentName(entry().agentId)}</span>
                          {entry().plan?.plan.title ?? ""}
                        </span>
                        <Show when={entry().plan?.plan.current}>
                          {(current) => (
                            <span class="subagents-live">
                              <span class="subagents-live-text agent-activity-label">{current()}</span>
                            </span>
                          )}
                        </Show>
                      </span>
                      <Show when={entry().plan}>
                        {(plan) => (
                          <Badge class="subagents-progress">
                            <RadialProgress
                              class="subagents-ring"
                              aria-hidden="true"
                              value={(plan().plan.done / Math.max(plan().plan.total, 1)) * 100}
                            />
                            {t("chat.taskList.count", { done: plan().plan.done, total: plan().plan.total })}
                          </Badge>
                        )}
                      </Show>
                    </Button>
                    <ul class="live-work-children">
                      <For each={entry().subagents} keyed={(item) => item.key}>
                        {(item) => (
                          <li>
                            <Button
                              type="button"
                              variant="ghost"
                              class="subagents-row live-work-row live-work-child"
                              onClick={() => props.onOpenSubagent(item().subagent.id)}
                            >
                              <SubagentStatus status={item().subagent.status} />
                              <span class="subagents-row-copy">
                                <span class="subagents-row-title">{item().subagent.title}</span>
                                <Show
                                  when={subagentPlanProgress(item().subagent)?.current}
                                  fallback={<LiveLine subagent={item().subagent} />}
                                >
                                  {(current) => (
                                    <span class="subagents-live">
                                      <span class="subagents-live-text agent-activity-label">{current()}</span>
                                    </span>
                                  )}
                                </Show>
                              </span>
                              <SubagentPlanBadge subagent={item().subagent} />
                              <span class="subagents-elapsed">{duration(elapsedMs(item().subagent, now()))}</span>
                              <ChevronRight class="subagents-row-chevron" aria-hidden="true" />
                            </Button>
                          </li>
                        )}
                      </For>
                    </ul>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </div>
      </Show>
    </div>
  );
}
