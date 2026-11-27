import { SIDEBAR_PEOPLE_SECTION_ID, type SidebarFolderItem } from "@openbot/contracts/ipc";

export interface DragSlot {
  bottom: number;
  key: string;
  left: number;
  right: number;
  top: number;
  centerX: number;
  centerY: number;
}

export interface DragOffset {
  x: number;
  y: number;
}

export const ZERO_DRAG_OFFSET: DragOffset = { x: 0, y: 0 };

export interface ReorderSlot {
  left?: number;
  top: number;
}

export interface SectionDropTarget {
  sectionId: string;
  placement: "before" | "after";
}

export interface ChatDropTarget {
  chatId: string;
  placement: "before" | "after";
  sectionId: string;
}

export interface PersonDropTarget {
  memberId: string;
  placement: "before" | "after";
}

export interface ChatDragSlot {
  chatId: string;
  bottom: number;
  centerY: number;
  element: HTMLElement;
  height: number;
  sectionId: string;
  top: number;
}

export interface SectionDragSlot {
  bottom: number;
  centerY: number;
  header: { height: number; stickTop: number | null } | null;
  sectionId: string;
  top: number;
}

function sectionHeaderBand(slot: SectionDragSlot, scrollDelta: number): { top: number; bottom: number } | null {
  if (!slot.header || slot.header.height <= 0) return null;
  const natural = slot.top - scrollDelta;
  const top =
    slot.header.stickTop === null
      ? natural
      : Math.max(natural, Math.min(slot.header.stickTop, slot.bottom - scrollDelta - slot.header.height));
  return { top, bottom: top + slot.header.height };
}

export interface PersonDragSlot {
  bottom: number;
  centerY: number;
  element: HTMLElement;
  memberId: string;
  top: number;
}

export type SidebarDragSource =
  | { kind: "chat"; id: string; origin: "section" }
  | { kind: "pinned"; id: string; key: string; origin: "pinned" }
  | { kind: "person"; id: string; origin: "people" }
  | { kind: "section"; id: string };

export type SidebarDropTarget =
  | { kind: "pinned"; key: string | null }
  | { kind: "chat"; target: ChatDropTarget }
  | { kind: "section"; sectionId: string }
  | { kind: "person"; target: PersonDropTarget }
  | { kind: "section-order"; target: SectionDropTarget }
  | { kind: "section-into"; sectionId: string };

export interface SidebarDragPoint {
  clientX: number;
  clientY: number;
}

export interface SidebarDragSession {
  source: SidebarDragSource;
  startScrollTop: number;
}

export interface SidebarDragGeometry {
  list: DOMRect | null;
  pinned: DOMRect | null;
}

export interface SidebarNativeDragStart {
  className: string;
  createPreview?: (source: HTMLElement) => HTMLElement;
  data: string;
  horizontal?: boolean;
  previewSize?: { height: number; width: number };
  source: SidebarDragSource;
}

export interface SidebarDrag {
  emptyPinnedDropVisible: boolean;
  offsets: Record<string, DragOffset>;
  source: SidebarDragSource | null;
  target: SidebarDropTarget | null;
}

export interface SidebarDragWorld {
  chatScrollDelta: number;
  chatSlots: Map<string, ChatDragSlot>;
  canPinDraggedItem: () => boolean;
  geometry: SidebarDragGeometry;
  personSlots: Map<string, PersonDragSlot>;
  pinnedSlots: DragSlot[];
  sectionAcceptsChat: (sectionId: string) => boolean;
  sectionScrollDelta: number;
  sectionSlots: Map<string, SectionDragSlot>;
  folders: SidebarDragFolders | null;
  session: SidebarDragSession;
  sessionScrollDelta: number;
  /**
   * Fork (docs/fork/FEATURES.md #94): the target to keep while a dragged folder is over its own gap.
   * When its siblings slid to open the gap somewhere else, the gap is where the drop goes; when the
   * gap is still at the start, this is null and a drop there leaves the folder in place.
   */
  heldSectionTarget?: SidebarDropTarget | null;
  /**
   * Fork (docs/fork/FEATURES.md #94): the chats and folders in a section, in the order they show. With
   * it, a drop lands at an exact place among them, also between a folder's chats and its folders.
   */
  folderItems?: ((sectionId: string) => SidebarFolderItem[]) | undefined;
  /** Whether a section is closed: below a closed folder's header, a chat goes after the folder. */
  sectionIsCollapsed?: (sectionId: string) => boolean;
}

export interface SidebarDragFolders {
  canNest: (sectionId: string, parentId: string | null) => boolean;
  isInside: (sectionId: string, ancestorId: string) => boolean;
  parent: (sectionId: string) => string | null;
}

/**
 * The section that a drop would move a chat into, which is the one section the drag tints. A chat
 * dragged within its own section is a reorder: its neighbours slide and no section lights up, as in
 * Claude's sidebar (fork FEATURES #73). A pinned tile always leaves the pinned strip, so the section
 * it lands in lights up even when the chat already belongs to it.
 */
export function chatDropSectionId(
  source: SidebarDragSource | null,
  target: SidebarDropTarget | null,
  sourceSectionId: (chatId: string) => string,
  sectionParent?: (sectionId: string) => string | null,
): string | null {
  let sectionId: string | null = null;
  if (source?.kind === "section" || source?.kind === "person") return null;
  if (target?.kind === "chat") sectionId = target.target.sectionId;
  else if (target?.kind === "section" && source?.kind === "chat") sectionId = target.sectionId;
  // Fork #94: a chat put beside a folder goes into that folder's parent.
  else if (target?.kind === "section-order") sectionId = sectionParent?.(target.target.sectionId) ?? null;
  if (sectionId === null) return null;
  if (source?.kind === "chat" && sourceSectionId(source.id) === sectionId) return null;
  return sectionId;
}

export function sidebarDropTargetsEqual(left: SidebarDropTarget | null, right: SidebarDropTarget | null): boolean {
  if (left === right) return true;
  if (!left || !right || left.kind !== right.kind) return false;
  if (left.kind === "pinned" && right.kind === "pinned") return left.key === right.key;
  if (left.kind === "section" && right.kind === "section") return left.sectionId === right.sectionId;
  if (left.kind === "section-into" && right.kind === "section-into") return left.sectionId === right.sectionId;
  if (left.kind === "chat" && right.kind === "chat") {
    return (
      left.target.chatId === right.target.chatId &&
      left.target.placement === right.target.placement &&
      left.target.sectionId === right.target.sectionId
    );
  }
  if (left.kind === "person" && right.kind === "person") {
    return left.target.memberId === right.target.memberId && left.target.placement === right.target.placement;
  }
  if (left.kind === "section-order" && right.kind === "section-order") {
    return left.target.sectionId === right.target.sectionId && left.target.placement === right.target.placement;
  }
  return false;
}

export function pointInRect(point: SidebarDragPoint, rect: DOMRect | null, scrollDelta = 0): boolean {
  if (!rect) return false;
  return (
    point.clientX >= rect.left &&
    point.clientX <= rect.right &&
    point.clientY >= rect.top - scrollDelta &&
    point.clientY <= rect.bottom - scrollDelta
  );
}

export function closestVerticalSlot<T extends { bottom: number; top: number }>(
  slots: Iterable<T>,
  clientY: number,
  scrollDelta: number,
  accepts: (slot: T) => boolean = () => true,
): T | null {
  let closest: T | null = null;
  let closestDistance = Number.POSITIVE_INFINITY;
  let extentTop = Number.POSITIVE_INFINITY;
  let extentBottom = Number.NEGATIVE_INFINITY;
  for (const slot of slots) {
    if (!accepts(slot)) continue;
    const top = slot.top - scrollDelta;
    const bottom = slot.bottom - scrollDelta;
    extentTop = Math.min(extentTop, top);
    extentBottom = Math.max(extentBottom, bottom);
    const distance = Math.max(top - clientY, clientY - bottom, 0);
    if (distance <= closestDistance) {
      closest = slot;
      closestDistance = distance;
    }
  }
  return clientY >= extentTop && clientY <= extentBottom ? closest : null;
}

function targetChatAt(
  world: SidebarDragWorld,
  sourceChatId: string,
  chatId: string,
  clientY: number,
): ChatDropTarget | null {
  if (sourceChatId === chatId) return null;
  const sourceSlot = world.chatSlots.get(sourceChatId);
  const slot = world.chatSlots.get(chatId);
  if (!slot) return null;
  const scrollDelta = world.chatScrollDelta;
  const placement =
    sourceSlot?.sectionId === slot.sectionId
      ? sourceSlot.top < slot.top
        ? "after"
        : "before"
      : clientY < slot.centerY - scrollDelta
        ? "before"
        : "after";
  const nextTarget: ChatDropTarget = {
    chatId,
    placement,
    sectionId: slot.sectionId,
  };
  return nextTarget;
}

function sectionAtPoint(world: SidebarDragWorld, point: SidebarDragPoint): SectionDragSlot | null {
  return closestVerticalSlot(world.sectionSlots.values(), point.clientY, world.sectionScrollDelta);
}

function chatAtPoint(world: SidebarDragWorld, point: SidebarDragPoint, sectionId: string): ChatDragSlot | null {
  return closestVerticalSlot(
    world.chatSlots.values(),
    point.clientY,
    world.chatScrollDelta,
    (slot) => slot.sectionId === sectionId,
  );
}

function personAtPoint(world: SidebarDragWorld, point: SidebarDragPoint): PersonDragSlot | null {
  return closestVerticalSlot(world.personSlots.values(), point.clientY, world.sessionScrollDelta);
}

function pinnedTargetAtPoint(world: SidebarDragWorld, point: SidebarDragPoint): SidebarDropTarget | null {
  const scrollDelta = world.sessionScrollDelta;
  if (!pointInRect(point, world.geometry.pinned, scrollDelta)) return null;
  const source = world.session.source;
  if (!("origin" in source) || source.origin !== "pinned") {
    return world.canPinDraggedItem() ? { kind: "pinned", key: null } : null;
  }
  if (world.pinnedSlots.length === 0) return { kind: "pinned", key: null };
  const target = world.pinnedSlots.reduce((closest, slot) =>
    Math.hypot(slot.centerX - point.clientX, slot.centerY - scrollDelta - point.clientY) <
    Math.hypot(closest.centerX - point.clientX, closest.centerY - scrollDelta - point.clientY)
      ? slot
      : closest,
  );
  return { kind: "pinned", key: target.key };
}

export function sidebarDropTargetAt(world: SidebarDragWorld, point: SidebarDragPoint): SidebarDropTarget | null {
  const session = world.session;
  if (!pointInRect(point, world.geometry.list)) return null;
  const pinnedTarget = pinnedTargetAtPoint(world, point);
  if (pinnedTarget) return pinnedTarget;
  if (session.source.kind === "section" && world.folders)
    return folderTargetAtPoint(world, world.folders, session.source.id, point);
  const section = sectionAtPoint(world, point);
  if (!section) return null;

  if (session.source.kind === "section") {
    if (section.sectionId === session.source.id) return null;
    const scrollDelta = world.sectionScrollDelta;
    return {
      kind: "section-order",
      target: {
        sectionId: section.sectionId,
        placement: point.clientY < section.centerY - scrollDelta ? "before" : "after",
      },
    };
  }

  if (session.source.kind === "person") {
    if (section.sectionId !== SIDEBAR_PEOPLE_SECTION_ID) return null;
    const person = personAtPoint(world, point);
    if (!person || person.memberId === session.source.id) return { kind: "section", sectionId: section.sectionId };
    const sourceSlot = world.personSlots.get(session.source.id);
    return {
      kind: "person",
      target: {
        memberId: person.memberId,
        placement:
          session.source.origin === "people" && sourceSlot
            ? sourceSlot.top < person.top
              ? "after"
              : "before"
            : point.clientY < person.centerY
              ? "before"
              : "after",
      },
    };
  }

  if (!world.sectionAcceptsChat(section.sectionId)) return null;
  if (world.folderItems) return chatTargetInSection(world, section, point);
  const chat = chatAtPoint(world, point, section.sectionId);
  if (chat && chat.chatId !== session.source.id) {
    const target = targetChatAt(world, session.source.id, chat.chatId, point.clientY);
    if (target) return { kind: "chat", target };
  }
  return { kind: "section", sectionId: section.sectionId };
}

interface SidebarItemSlot {
  item: SidebarFolderItem;
  top: number;
  bottom: number;
  centerY: number;
}

function itemSlotsIn(
  world: SidebarDragWorld,
  sectionId: string,
  skip: (item: SidebarFolderItem) => boolean = () => false,
): SidebarItemSlot[] {
  const slots: SidebarItemSlot[] = [];
  for (const item of world.folderItems?.(sectionId) ?? []) {
    if (skip(item)) continue;
    const slot = item.kind === "chat" ? world.chatSlots.get(item.id) : world.sectionSlots.get(item.id);
    if (!slot) continue;
    const delta = item.kind === "chat" ? world.chatScrollDelta : world.sectionScrollDelta;
    slots.push({ item, top: slot.top - delta, bottom: slot.bottom - delta, centerY: slot.centerY - delta });
  }
  return slots;
}

function itemSlotAt(slots: SidebarItemSlot[], clientY: number): SidebarItemSlot | undefined {
  const first = slots[0];
  if (!first) return undefined;
  return closestVerticalSlot(slots, clientY, 0) ?? (clientY < first.top ? first : slots[slots.length - 1]);
}

function besideSection(sectionId: string, placement: "before" | "after"): SidebarDropTarget {
  return { kind: "section-order", target: { sectionId, placement } };
}

function chatTargetInSection(
  world: SidebarDragWorld,
  section: SectionDragSlot,
  point: SidebarDragPoint,
): SidebarDropTarget | null {
  const source = world.session.source;
  const ownSectionId = source.kind === "chat" ? world.chatSlots.get(source.id)?.sectionId : undefined;
  const sectionId = section.sectionId;
  const band = sectionHeaderBand(section, world.sectionScrollDelta);
  if (band && point.clientY >= band.top && point.clientY <= band.bottom) {
    const parentId = world.folders?.parent(sectionId) ?? null;
    if (parentId !== null && world.sectionAcceptsChat(parentId)) {
      const ratio = (point.clientY - band.top) / (band.bottom - band.top);
      if (ratio < 0.25) return besideSection(sectionId, "before");
      if (ratio > 0.75 && world.sectionIsCollapsed?.(sectionId)) return besideSection(sectionId, "after");
    }
    return sectionId === ownSectionId ? null : { kind: "section", sectionId };
  }
  const hit = itemSlotAt(itemSlotsIn(world, sectionId), point.clientY);
  if (!hit) return sectionId === ownSectionId ? null : { kind: "section", sectionId };
  if (hit.item.kind === "section") return besideSection(hit.item.id, point.clientY < hit.centerY ? "before" : "after");
  const target = targetChatAt(world, source.id, hit.item.id, point.clientY);
  return target ? { kind: "chat", target } : null;
}

function folderTargetAtPoint(
  world: SidebarDragWorld,
  folders: SidebarDragFolders,
  sourceId: string,
  point: SidebarDragPoint,
): SidebarDropTarget | null {
  const scrollDelta = world.sectionScrollDelta;
  const y = point.clientY + scrollDelta;
  const sourceSlot = world.sectionSlots.get(sourceId);
  if (sourceSlot && y >= sourceSlot.top && y <= sourceSlot.bottom) return world.heldSectionTarget ?? null;
  const accepts = (candidate: SectionDragSlot) => !folders.isInside(candidate.sectionId, sourceId);
  let header: { slot: SectionDragSlot; top: number; bottom: number } | null = null;
  for (const candidate of world.sectionSlots.values()) {
    const band = accepts(candidate) ? sectionHeaderBand(candidate, scrollDelta) : null;
    if (band && point.clientY >= band.top && point.clientY <= band.bottom) header = { slot: candidate, ...band };
  }
  const slot = header?.slot ?? closestVerticalSlot(world.sectionSlots.values(), point.clientY, scrollDelta, accepts);
  if (!slot) return outsideFolders(world, folders, sourceId, y, accepts);
  const parentId = folders.parent(slot.sectionId);
  const beside = (placement: "before" | "after"): SidebarDropTarget | null =>
    folders.canNest(sourceId, parentId)
      ? { kind: "section-order", target: { sectionId: slot.sectionId, placement } }
      : null;
  const into: SidebarDropTarget | null = folders.canNest(sourceId, slot.sectionId)
    ? { kind: "section-into", sectionId: slot.sectionId }
    : null;
  if (header) {
    const ratio = (point.clientY - header.top) / (header.bottom - header.top);
    if (ratio < 0.25) return beside("before") ?? into;
    if (ratio > 0.75) return beside("after") ?? into;
    return into ?? beside(ratio < 0.5 ? "before" : "after");
  }
  if (y < slot.top) return beside("before");
  if (y > slot.bottom) return beside("after");
  // Fork (docs/fork/FEATURES.md #94): in a folder's rows, the folder lands before or after the row
  // under the point, a chat or a folder, as a chat does.
  if (into) {
    const hit = itemSlotAt(
      itemSlotsIn(world, slot.sectionId, (item) => item.kind === "section" && folders.isInside(item.id, sourceId)),
      point.clientY,
    );
    if (hit) {
      const placement = point.clientY < hit.centerY ? "before" : "after";
      return hit.item.kind === "chat"
        ? { kind: "chat", target: { chatId: hit.item.id, placement, sectionId: slot.sectionId } }
        : besideSection(hit.item.id, placement);
    }
  }
  return into ?? beside(y < slot.centerY ? "before" : "after");
}

function outsideFolders(
  world: SidebarDragWorld,
  folders: SidebarDragFolders,
  sourceId: string,
  y: number,
  accepts: (slot: SectionDragSlot) => boolean,
): SidebarDropTarget | null {
  if (!folders.canNest(sourceId, null)) return null;
  const top = [...world.sectionSlots.values()].filter(
    (slot) => folders.parent(slot.sectionId) === null && accepts(slot),
  );
  const first = top[0];
  const last = top[top.length - 1];
  if (last && y > last.bottom) return besideSection(last.sectionId, "after");
  if (first && y < first.top) return besideSection(first.sectionId, "before");
  return null;
}

export function reorderOffsets(
  currentIds: readonly string[],
  sourceId: string,
  target: { id: string; placement: "before" | "after" },
  slotOf: (id: string) => ReorderSlot | undefined,
  axis: "x-and-y" | "y",
): Record<string, DragOffset> {
  const desiredIds = currentIds.filter((id) => id !== sourceId);
  const targetIndex = desiredIds.indexOf(target.id);
  if (targetIndex < 0) return {};
  desiredIds.splice(targetIndex + (target.placement === "after" ? 1 : 0), 0, sourceId);
  const desiredIndexById = new Map(desiredIds.map((id, index) => [id, index]));
  const offsets: Record<string, DragOffset> = {};
  for (const id of currentIds) {
    if (id === sourceId) continue;
    const desiredIndex = desiredIndexById.get(id);
    const destinationId = desiredIndex === undefined ? undefined : currentIds[desiredIndex];
    const currentSlot = slotOf(id);
    const destinationSlot = destinationId === undefined ? undefined : slotOf(destinationId);
    if (!currentSlot || !destinationSlot) continue;
    const x = axis === "x-and-y" ? (destinationSlot.left ?? 0) - (currentSlot.left ?? 0) : 0;
    const y = destinationSlot.top - currentSlot.top;
    if (x !== 0 || y !== 0) offsets[id] = { x, y };
  }
  return offsets;
}

export function stackReorderOffsets(
  currentIds: readonly string[],
  sourceId: string,
  target: { id: string; placement: "before" | "after" },
  slotOf: (id: string) => { top: number; bottom: number } | undefined,
): Record<string, DragOffset> {
  const slots = new Map<string, { top: number; bottom: number }>();
  for (const id of currentIds) {
    const slot = slotOf(id);
    if (slot) slots.set(id, slot);
  }
  const placed = [...slots.values()];
  const desiredIds = [...slots.keys()].filter((id) => id !== sourceId);
  const targetIndex = desiredIds.indexOf(target.id);
  if (targetIndex < 0 || !slots.has(sourceId)) return {};
  desiredIds.splice(targetIndex + (target.placement === "after" ? 1 : 0), 0, sourceId);
  const offsets: Record<string, DragOffset> = {};
  let top = placed[0]?.top ?? 0;
  let previous: { top: number; bottom: number } | undefined;
  desiredIds.forEach((id, index) => {
    const slot = slots.get(id);
    if (!slot) return;
    if (previous)
      top += previous.bottom - previous.top + ((placed[index]?.top ?? 0) - (placed[index - 1]?.bottom ?? 0));
    previous = slot;
    const y = top - slot.top;
    if (Math.abs(y) >= 0.5) offsets[id] = { x: 0, y };
  });
  return offsets;
}

export function placementForSwap(
  currentIds: readonly string[],
  sourceId: string,
  targetId: string,
): "before" | "after" {
  return currentIds.indexOf(sourceId) < currentIds.indexOf(targetId) ? "after" : "before";
}
