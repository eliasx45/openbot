import {
  SIDEBAR_PEOPLE_SECTION_ID,
  SIDEBAR_UNASSIGNED_SECTION_ID,
  type SidebarLayoutSnapshot,
  sidebarFolderParents,
  sidebarFolderTreeOrder,
} from "@openbot/contracts/ipc";
import type { ComposerSection } from "@openbot/ui/data";

/** The most agent names that a folder row of the `@` list shows. */
const DETAIL_AGENT_LIMIT = 4;

/**
 * Fork (docs/fork/FEATURES.md, "`@` a sidebar section"): the user's sidebar folders that `@` tags, in
 * sidebar order. A row shows the folder's agents, or the folder that holds it when it has none.
 */
export function forkMentionSections(
  layout: SidebarLayoutSnapshot,
  agents: ReadonlyArray<{ id: string; name: string }>,
): ComposerSection[] {
  const byId = new Map(layout.sections.map((section) => [section.id, section]));
  const parents = sidebarFolderParents(layout);
  const rank = (id: string) => {
    const index = layout.agentOrder.indexOf(id);
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
  };
  const sorted = [...agents].sort((left, right) => rank(left.id) - rank(right.id));
  return sidebarFolderTreeOrder(layout.order, parents).flatMap((sectionId) => {
    const section = byId.get(sectionId);
    if (!section || sectionId === SIDEBAR_PEOPLE_SECTION_ID || sectionId === SIDEBAR_UNASSIGNED_SECTION_ID) return [];
    const names = sorted.filter((agent) => layout.agentAssignments[agent.id] === sectionId).map((agent) => agent.name);
    const parent = byId.get(parents.get(sectionId) ?? "");
    const shown = names.slice(0, DETAIL_AGENT_LIMIT).join(", ");
    const more = names.length - DETAIL_AGENT_LIMIT;
    const detail = names.length ? (more > 0 ? `${shown} +${more}` : shown) : parent?.name;
    return [{ id: section.id, name: section.name, detail }];
  });
}
