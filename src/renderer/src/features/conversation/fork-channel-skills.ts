/**
 * Fork (docs/fork/FEATURES.md, "`$` in channels"): the `$` list of a channel is the skills of its
 * members, each once, with the members that have it. Built-in commands of an agent's CLI (Claude
 * Code's `/compact`) run only at the start of a session's prompt, which a channel turn is not, so
 * they stay out.
 */

import { AGENT_COMMAND_ID_PREFIX, type InstalledSkill } from "@openbot/contracts/ipc";
import type { AgentProfile, ComposerSkill } from "@openbot/ui/data";

export type ChannelSkill = InstalledSkill & Pick<ComposerSkill, "owners">;

/** One skill for each id, in member order, with every member that lists it as an owner. */
export function channelSkills(lists: ReadonlyArray<{ agent: AgentProfile; skills: readonly InstalledSkill[] }>) {
  const merged = new Map<string, ChannelSkill & { owners: AgentProfile[] }>();
  for (const { agent, skills } of lists)
    for (const skill of skills) {
      if (skill.skillId.startsWith(AGENT_COMMAND_ID_PREFIX)) continue;
      const known = merged.get(skill.skillId);
      if (known) {
        if (!known.owners.some((owner) => owner.id === agent.id)) known.owners.push(agent);
      } else merged.set(skill.skillId, { ...skill, owners: [agent] });
    }
  return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
}
