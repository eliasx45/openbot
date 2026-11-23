import { isDynamicRecord, isNumber, isString } from "./runtime-values";

export const SIDEBAR_PEOPLE_SECTION_ID = "people";
export const SIDEBAR_UNASSIGNED_SECTION_ID = "unassigned";

export interface SidebarSection {
  id: string;
  name: string;
  parentId?: string;
  /**
   * Fork (docs/fork/FEATURES.md #94): in its parent folder, the folder shows right before this chat.
   * Absent, or a chat that is not in the parent: after the chats, as before. Only this computer keeps
   * it: the Team API contracts drop it, so a remote client shows the folder after the chats.
   */
  beforeChatId?: string;
}

export const SIDEBAR_FOLDER_LEVELS = 3;

export interface SidebarLayoutSnapshot {
  revision: number;
  sections: SidebarSection[];
  order: string[];
  agentAssignments: Record<string, string>;
  agentOrder: string[];
}

export function isCompleteSectionOrder(order: readonly unknown[], sectionIds: Iterable<string>): boolean {
  const expected = new Set([SIDEBAR_PEOPLE_SECTION_ID, SIDEBAR_UNASSIGNED_SECTION_ID, ...sectionIds]);
  return (
    order.length === expected.size &&
    order.every((sectionId) => isString(sectionId) && expected.has(sectionId)) &&
    new Set(order).size === order.length
  );
}

export function isSidebarLayoutSnapshot(value: unknown): value is SidebarLayoutSnapshot {
  if (!isDynamicRecord(value) || !isNumber(value.revision) || !Number.isInteger(value.revision) || value.revision < 0) {
    return false;
  }
  if (
    !Array.isArray(value.sections) ||
    !Array.isArray(value.order) ||
    !isDynamicRecord(value.agentAssignments) ||
    !Array.isArray(value.agentOrder)
  ) {
    return false;
  }
  const sectionIds = new Set<string>();
  for (const section of value.sections) {
    if (!isDynamicRecord(section) || !isString(section.id) || !isString(section.name)) return false;
    if (section.parentId !== undefined && !isString(section.parentId)) return false;
    if (section.beforeChatId !== undefined && !isString(section.beforeChatId)) return false;
    if (sectionIds.has(section.id)) return false;
    sectionIds.add(section.id);
  }
  return (
    isCompleteSectionOrder(value.order, sectionIds) &&
    Object.values(value.agentAssignments).every(isString) &&
    value.agentOrder.every(isString) &&
    new Set(value.agentOrder).size === value.agentOrder.length
  );
}

export type SidebarLayoutAction =
  | { type: "create"; name: string; agentId?: string; parentId?: string }
  | { type: "rename"; sectionId: string; name: string }
  | { type: "delete"; sectionId: string }
  | { type: "move"; sectionId: string; direction: "up" | "down"; steps?: number }
  | { type: "assign"; agentId: string; sectionId: string | null }
  | { type: "move-agent"; agentId: string; sectionId: string | null; beforeAgentId: string | null }
  | { type: "nest"; sectionId: string; parentId: string | null; beforeSectionId: string | null }
  | {
      type: "place";
      item: SidebarFolderItem;
      parentId: string;
      beforeAgentId: string | null;
      beforeSectionId: string | null;
    };

export type SidebarFolderItem = {
  kind: "chat" | "section";
  id: string;
};

export function sidebarPlaceFallback(
  action: Extract<SidebarLayoutAction, { type: "place" }>,
): Exclude<SidebarLayoutAction, { type: "place" }> {
  return action.item.kind === "chat"
    ? { type: "move-agent", agentId: action.item.id, sectionId: action.parentId, beforeAgentId: action.beforeAgentId }
    : { type: "nest", sectionId: action.item.id, parentId: action.parentId, beforeSectionId: action.beforeSectionId };
}

export function sidebarFolderItems(
  chatIds: readonly string[],
  folderIds: readonly string[],
  beforeChatOf: (folderId: string) => string | undefined,
): SidebarFolderItem[] {
  const chats = new Set(chatIds);
  const before = new Map<string, string[]>();
  const after: string[] = [];
  for (const folderId of folderIds) {
    const chatId = beforeChatOf(folderId);
    if (chatId !== undefined && chats.has(chatId)) before.set(chatId, [...(before.get(chatId) ?? []), folderId]);
    else after.push(folderId);
  }
  const items: SidebarFolderItem[] = [];
  for (const chatId of chatIds) {
    for (const folderId of before.get(chatId) ?? []) items.push({ kind: "section", id: folderId });
    items.push({ kind: "chat", id: chatId });
  }
  for (const folderId of after) items.push({ kind: "section", id: folderId });
  return items;
}

export function sidebarFolderAnchors(items: readonly SidebarFolderItem[]): Map<string, string | undefined> {
  const anchors = new Map<string, string | undefined>();
  let pending: string[] = [];
  for (const item of items) {
    if (item.kind === "section") pending.push(item.id);
    else {
      for (const folderId of pending) anchors.set(folderId, item.id);
      pending = [];
    }
  }
  for (const folderId of pending) anchors.set(folderId, undefined);
  return anchors;
}

export function sidebarFolderParents(layout: Pick<SidebarLayoutSnapshot, "sections" | "order">): Map<string, string> {
  const known = new Map(layout.sections.map((section) => [section.id, section]));
  const rank = new Map(layout.order.map((sectionId, index) => [sectionId, index]));
  const ordered = [...layout.sections].sort(
    (left, right) => (rank.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(right.id) ?? Number.MAX_SAFE_INTEGER),
  );
  const parents = new Map<string, string>();
  for (const section of ordered) {
    const parentId = section.parentId;
    if (parentId === undefined || parentId === section.id || !known.has(parentId)) continue;
    let ancestor: string | undefined = parentId;
    while (ancestor !== undefined && ancestor !== section.id) ancestor = parents.get(ancestor);
    if (ancestor === undefined) parents.set(section.id, parentId);
  }
  for (const sectionId of sidebarFolderTreeOrder(layout.order, parents)) {
    const chain = sidebarFolderAncestors(parents, sectionId);
    if (chain.length >= SIDEBAR_FOLDER_LEVELS) {
      const parentId = chain[SIDEBAR_FOLDER_LEVELS - 2];
      if (parentId !== undefined) parents.set(sectionId, parentId);
    }
  }
  return parents;
}

export function sidebarFolderAncestors(parents: ReadonlyMap<string, string>, sectionId: string): string[] {
  const chain: string[] = [];
  for (let parentId = parents.get(sectionId); parentId !== undefined; parentId = parents.get(parentId)) {
    if (chain.includes(parentId)) break;
    chain.unshift(parentId);
  }
  return chain;
}

export function sidebarFolderHeight(parents: ReadonlyMap<string, string>, sectionId: string): number {
  let height = 0;
  for (const [childId, parentId] of parents) {
    if (parentId === sectionId) height = Math.max(height, 1 + sidebarFolderHeight(parents, childId));
  }
  return height;
}

export function sidebarFolderTreeOrder(order: readonly string[], parents: ReadonlyMap<string, string>): string[] {
  const present = new Set(order);
  const children = new Map<string | null, string[]>();
  for (const sectionId of order) {
    const parentId = parents.get(sectionId);
    const key = parentId !== undefined && present.has(parentId) ? parentId : null;
    children.set(key, [...(children.get(key) ?? []), sectionId]);
  }
  const result: string[] = [];
  const visit = (sectionId: string) => {
    if (result.includes(sectionId)) return;
    result.push(sectionId);
    for (const childId of children.get(sectionId) ?? []) visit(childId);
  };
  for (const sectionId of children.get(null) ?? []) visit(sectionId);
  for (const sectionId of order) visit(sectionId);
  return result;
}

export function sidebarFolderPath(
  layout: Pick<SidebarLayoutSnapshot, "sections">,
  parents: ReadonlyMap<string, string>,
  sectionId: string,
): string[] {
  const names = new Map(layout.sections.map((section) => [section.id, section.name]));
  return [...sidebarFolderAncestors(parents, sectionId), sectionId].flatMap((id) => {
    const name = names.get(id);
    return name === undefined ? [] : [name];
  });
}
