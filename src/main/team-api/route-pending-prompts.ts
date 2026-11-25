import { agentAccessRank } from "@openbot/contracts/ipc";
import {
  PENDING_PROMPTS_CAPABILITY,
  PENDING_PROMPTS_ROUTES,
  pendingPromptsWithinLimits,
} from "@openbot/contracts/team-protocol/pending-prompts-v1";
import { sourceText } from "@openbot/i18n/source";
import type { TeamApiAgents } from "./dependencies";
import { HttpError } from "./http-error";
import { hiddenProviderAgentIds } from "./provider-visibility";
import type { RouteOutcome, TeamApiRequestContext } from "./request-context";

export async function routePendingPrompts(
  context: TeamApiRequestContext,
  agents: Pick<TeamApiAgents, "pendingPrompts" | "listAgents">,
  hiddenAgentIds: ReadonlySet<string>,
): Promise<RouteOutcome> {
  const { method, url, capabilities, json } = context;
  if (method !== "POST" || url.pathname !== PENDING_PROMPTS_ROUTES.list) return "unmatched";
  if (!capabilities.has(PENDING_PROMPTS_CAPABILITY))
    throw new HttpError(400, sourceText("error.team.pendingPromptsUnsupported"));
  const shownAgentIds = new Set(
    agents
      .listAgents()
      .map((agent) => agent.id)
      .filter((agentId) => !hiddenAgentIds.has(agentId) && agentAccessRank(context.agentLevel(agentId)) > 0),
  );
  const prompts = pendingPromptsWithinLimits(
    agents
      .pendingPrompts()
      .filter(
        (prompt) =>
          shownAgentIds.has(prompt.agentId) ||
          (!hiddenProviderAgent(agents, prompt.agentId, context) &&
            context.threadChannelLevel(prompt.threadId) !== "none"),
      ),
  );
  return json(200, { prompts });
}

function hiddenProviderAgent(
  agents: Pick<TeamApiAgents, "listAgents">,
  agentId: string,
  context: Pick<TeamApiRequestContext, "protocol">,
): boolean {
  return hiddenProviderAgentIds(agents.listAgents(), context.protocol).has(agentId);
}
