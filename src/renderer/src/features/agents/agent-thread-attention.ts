import type { AgentApproval, BrowserTakeoverRequest } from "@openbot/contracts/ipc";
import type { AgentProfile } from "@openbot/ui/data";
import type { SidebarApproval, SidebarAttention } from "@openbot/ui/features/sidebar/sidebar-agent-states";
import { attentionAgentId, type PendingAttentionPrompts } from "./agent-runtime-snapshot";

export interface AgentThreadAttentionInput {
  agents: readonly Pick<AgentProfile, "id" | "threadId">[];
  pendingPrompts: PendingAttentionPrompts;
  approvals: readonly AgentApproval[];
  /**
   * Fork (docs/fork/FEATURES.md, "A question in a side thread marks its agent"): the open side
   * threads (tasks, routine threads) of an agent. Their waits count after the agent's own thread,
   * because the row opens that thread. Omitted, only the agent's own thread counts.
   */
  sideThreads?: (agentId: string) => readonly string[];
}

export function agentThreadAttention(input: AgentThreadAttentionInput): {
  pendingPrompts: Record<string, SidebarAttention | undefined>;
  pendingApprovals: Record<string, SidebarApproval | undefined>;
} {
  const agentThreads = new Map(input.agents.map((agent) => [agent.id, agent.threadId]));
  const inAgentThread = (agentId: string, threadId: string | undefined) =>
    threadId !== undefined && agentThreads.get(agentId) === threadId;
  const inSideThread = (agentId: string, threadId: string | undefined) =>
    threadId !== undefined && agentThreads.has(agentId) && (input.sideThreads?.(agentId).includes(threadId) ?? false);
  const prompts = Object.values(input.pendingPrompts).flatMap((event) =>
    event ? [{ agentId: attentionAgentId(event), threadId: promptThreadId(event), event }] : [],
  );
  return {
    pendingPrompts: byAgent(prompts, inAgentThread, inSideThread, (item) => item.event),
    pendingApprovals: byAgent(input.approvals, inAgentThread, inSideThread, (approval) => approval),
  };
}

export function agentWaitThreadId(input: AgentThreadAttentionInput, agentId: string): string | undefined {
  const own = input.agents.find((agent) => agent.id === agentId)?.threadId;
  const side = input.sideThreads?.(agentId) ?? [];
  const threads = [
    ...Object.values(input.pendingPrompts).flatMap((event) =>
      event && attentionAgentId(event) === agentId ? [promptThreadId(event)] : [],
    ),
    ...input.approvals.filter((approval) => approval.agentId === agentId).map((approval) => approval.threadId),
  ];
  if (own && threads.includes(own)) return own;
  return threads.find((threadId) => threadId !== undefined && side.includes(threadId));
}

function promptThreadId(event: NonNullable<PendingAttentionPrompts[string]>): string | undefined {
  return event.type === "prompt" ? event.threadId : event.request.threadId;
}

function byAgent<Item extends { agentId: string; threadId?: string | undefined }, Value>(
  items: readonly Item[],
  inAgentThread: (agentId: string, threadId: string | undefined) => boolean,
  inSideThread: (agentId: string, threadId: string | undefined) => boolean,
  value: (item: Item) => Value,
): Record<string, Value | undefined> {
  const result: Record<string, Value | undefined> = {};
  for (const item of items) if (inSideThread(item.agentId, item.threadId)) result[item.agentId] ??= value(item);
  for (const item of items) if (inAgentThread(item.agentId, item.threadId)) result[item.agentId] = value(item);
  return result;
}

export function agentTakeoverTabIds(
  agents: readonly Pick<AgentProfile, "id" | "threadId">[],
  takeovers: readonly Pick<BrowserTakeoverRequest, "agentId" | "threadId" | "tabId">[],
): Record<string, string> {
  const agentThreads = new Map(agents.map((agent) => [agent.id, agent.threadId]));
  return Object.fromEntries(
    takeovers
      .filter((request) => agentThreads.get(request.agentId) === request.threadId)
      .map((request) => [request.agentId, request.tabId]),
  );
}
