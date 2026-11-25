import {
  isSidebarLayoutSnapshot,
  SIDEBAR_PEOPLE_SECTION_ID,
  SIDEBAR_UNASSIGNED_SECTION_ID,
  type SidebarLayoutSnapshot,
} from "@openbot/contracts/ipc";
import type { TeamProtocolV1JsonObject, TeamProtocolV1JsonValue } from "@openbot/contracts/team-protocol/v1";

// Fork (docs/fork/FEATURES.md #117): a member who cannot administer the server sees only the sidebar
// folders that hold a chat they can open (a visible agent or channel), and the parents of those folders.
// Empty folders and folders that hold only hidden chats are left out, with their names; so are the
// hidden chats' assignments and order. Owners and admins get the layout unchanged.

const FIXED_SECTIONS: ReadonlySet<string> = new Set([SIDEBAR_PEOPLE_SECTION_ID, SIDEBAR_UNASSIGNED_SECTION_ID]);

function memberLayout(layout: SidebarLayoutSnapshot, visibleChat: (chatId: string) => boolean): SidebarLayoutSnapshot {
  const parentOf = new Map<string, string>();
  for (const section of layout.sections) if (section.parentId !== undefined) parentOf.set(section.id, section.parentId);
  const assignments = Object.entries(layout.agentAssignments).filter(([chatId]) => visibleChat(chatId));
  const kept = new Set<string>();
  for (const [, sectionId] of assignments) {
    for (let id: string | undefined = sectionId; id !== undefined && !kept.has(id); id = parentOf.get(id)) kept.add(id);
  }
  return {
    ...layout,
    sections: layout.sections.filter((section) => kept.has(section.id)),
    order: layout.order.filter((id) => FIXED_SECTIONS.has(id) || kept.has(id)),
    agentAssignments: Object.fromEntries(assignments),
    agentOrder: layout.agentOrder.filter(visibleChat),
  };
}

function walk(node: TeamProtocolV1JsonValue, visibleChat: (chatId: string) => boolean): TeamProtocolV1JsonValue {
  if (Array.isArray(node)) return node.map((child) => walk(child, visibleChat));
  if (node === null || typeof node !== "object") return node;
  if (isSidebarLayoutSnapshot(node)) {
    const layout = memberLayout(node, visibleChat);
    const json: TeamProtocolV1JsonValue = JSON.parse(JSON.stringify(layout));
    return json;
  }
  const result: TeamProtocolV1JsonObject = {};
  for (const [key, child] of Object.entries(node)) result[key] = walk(child, visibleChat);
  return result;
}

/** Every sidebar layout inside `value` (a reply or an event), as the member may see it. */
export function forkMemberSidebarView(
  value: unknown,
  visibleChat: (chatId: string) => boolean,
): TeamProtocolV1JsonValue {
  const json: TeamProtocolV1JsonValue = JSON.parse(JSON.stringify(value) ?? "null");
  return walk(json, visibleChat);
}
