import { type ConversationSubagent, currentPlanStep } from "@openbot/contracts/ipc";
import type { AgentMessage } from "@openbot/ui/data";
import type { LiveWorkItem } from "@openbot/ui/features/conversation/LiveWork";
import type { VirtualItem } from "@tanstack/virtual-core";
import { createMemo } from "solid-js";

export interface SubagentDockDeps {
  rows: () => readonly AgentMessage[];
  drawnRows: () => readonly VirtualItem[];
  scrollElement: () => HTMLElement | undefined;
  hidden: () => boolean;
  /** Fork: what waits for the person now: a question or an approval. */
  waiting?: () => readonly LiveWorkItem[];
}

const working = (subagent: ConversationSubagent) => subagent.status === "running";

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
        const current = currentPlanStep(message.plan) ?? steps.find((step) => step.status !== "completed");
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
    update: () => {},
    items: (): readonly LiveWorkItem[] => (deps.hidden() ? [] : [...(deps.waiting?.() ?? []), ...items()]),
  };
}
