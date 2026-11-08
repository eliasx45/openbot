import type { ConversationSubagent } from "@openbot/contracts/ipc";
import type { AgentMessage } from "@openbot/ui/data";
import type { LiveWorkItem } from "@openbot/ui/features/conversation/LiveWork";
import type { VirtualItem } from "@tanstack/virtual-core";
import { createMemo } from "solid-js";

export interface SubagentDockDeps {
  /** The rows of the chat, oldest first. */
  rows: () => readonly AgentMessage[];
  /** The rows that the virtualizer draws now. */
  drawnRows: () => readonly VirtualItem[];
  scrollElement: () => HTMLElement | undefined;
  /** True while something covers the chat, such as a side thread. */
  hidden: () => boolean;
  /** Fork: what waits for the person now: a question or an approval. */
  waiting?: () => readonly LiveWorkItem[];
}

const working = (subagent: ConversationSubagent) => subagent.status === "running";

/**
 * Fork: all the live work of the chat, not only the newest subagent card. Every subagent that still
 * works, in any card and of any member (a background subagent works on after its turn and its channel
 * task ended), and the plan of each agent whose turn still runs. Before, the bar followed the newest
 * card only, so an older card's subagents and every plan were out of sight in a group chat (Elias,
 * 8 Nov 2026: "a subagent is working but idk what OTHER subagents are working/tasks being done in
 * the group chat … i keep asking 'whats the progress'").
 *
 * The bar shows while any of it works, on screen or not: it answers "what is the progress".
 */
export function createSubagentDock(deps: SubagentDockDeps) {
  const items = createMemo((): LiveWorkItem[] => {
    const list: LiveWorkItem[] = [];
    const plans = new Map<string, LiveWorkItem>();
    for (const message of deps.rows()) {
      const agentId = message.author === "agent" ? message.senderAgentId : undefined;
      if (message.kind === "subagents")
        for (const subagent of message.subagents ?? [])
          if (working(subagent))
            list.push({ kind: "subagent", key: `${message.id}:${subagent.id}`, cardId: message.id, agentId, subagent });
      if (message.kind === "plan" && message.streaming && message.plan?.steps.length) {
        const steps = message.plan.steps;
        const current =
          steps.find((step) => step.status === "inProgress") ?? steps.find((step) => step.status !== "completed");
        plans.set(agentId ?? "", {
          kind: "plan",
          key: message.id,
          cardId: message.id,
          agentId,
          plan: {
            title: message.plan.explanation ?? null,
            done: steps.filter((step) => step.status === "completed").length,
            total: steps.length,
            current: current ? (current.activeText ?? current.text) : null,
          },
        });
      }
    }
    return [...plans.values(), ...list];
  });
  return {
    /** The bar no longer depends on the scroll position; kept for the timeline's scroll handler. */
    update: () => {},
    /** All the live work: what waits for the person first, then the work. Empty while a side thread covers the chat. */
    items: (): readonly LiveWorkItem[] => (deps.hidden() ? [] : [...(deps.waiting?.() ?? []), ...items()]),
  };
}
