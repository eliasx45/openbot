import { type AgentAccessLevel, type AgentSummary, agentAccessRank } from "@openbot/contracts/ipc";
import type { ChannelAssignment } from "../channel-store";

export interface ForkChannelReachPort {
  store: {
    assignmentForDelivery(deliveryId: string): Pick<ChannelAssignment, "channelId" | "taskId"> | null;
    exists(channelId: string): boolean;
    get(channelId: string): { members: readonly { agentId: string }[] };
  };
  forkTaskPeople(channelId: string, taskId: string): string[];
  hooks: { remotePerson?(personId: string): boolean };
}

export function forkChannelTaskPeople(deliveryId: string, channels: ForkChannelReachPort): string[] {
  const assignment = channels.store.assignmentForDelivery(deliveryId);
  if (!assignment) return [];
  return channels
    .forkTaskPeople(assignment.channelId, assignment.taskId)
    .filter((personId) => channels.hooks.remotePerson?.(personId) ?? false);
}

export function forkReachableAgents(
  agents: readonly AgentSummary[],
  senderAgentId: string,
  requesterIds: readonly string[],
  channelId: string | null,
  channels: Pick<ForkChannelReachPort, "store">,
  level: (personId: string, agentId: string) => AgentAccessLevel | undefined,
): AgentSummary[] {
  const channelMembers = new Set(
    channelId && channels.store.exists(channelId)
      ? channels.store.get(channelId).members.map((member) => member.agentId)
      : [],
  );
  return agents.filter(
    (agent) =>
      agent.id === senderAgentId ||
      channelMembers.has(agent.id) ||
      requesterIds.every(
        (personId) => agentAccessRank(level(personId, agent.id) ?? "manage") >= agentAccessRank("chat"),
      ),
  );
}
