/**
 * The imperative half of the sidebar's drag&drop: the pointer pipeline, the slot caches, the
 * auto-scroll and the resolve path that decides what a drop would land on.
 *
 * `dragSession`, `dragTarget` and the slot caches are plain locals because the pipeline reads its
 * own writes inside one tick, and neither a signal nor a store publishes a write before the next
 * flush. The reactive half the rows render from is `drag-state-store`, and this file is handed only
 * its writers: anything deciding where a drag lands takes the source from `dragSession`, and taking
 * it from `drag.source` instead would bring back exactly the one-frame staleness this split exists
 * to avoid. `commitSidebarDrop` is passed that source for the same reason.
 */

import type { SidebarFolderItem, TeamPresenceMember } from "@openbot/contracts/ipc";
import { createBoundedDragPreview } from "../../components/createBoundedDragPreview";
import type { createScrollFades } from "../../components/createScrollFades";

import {
  clearSidebarDragDecorations,
  createSidebarChatDragCard,
  createSidebarFolderDragCard,
  measureSidebarDragSlots,
} from "./sidebar-drag-dom";
import {
  type ChatDragSlot,
  type DragOffset,
  type DragSlot,
  type PersonDragSlot,
  placementForSwap,
  pointInRect,
  reorderOffsets,
  type SectionDragSlot,
  type SidebarDragFolders,
  type SidebarDragGeometry,
  type SidebarDragPoint,
  type SidebarDragSession,
  type SidebarDragSource,
  type SidebarDragWorld,
  type SidebarDropTarget,
  type SidebarNativeDragStart,
  sidebarDropTargetAt,
  sidebarDropTargetsEqual,
  stackReorderOffsets,
} from "./sidebar-drag-model";
import type { SidebarPinnedItem } from "./sidebar-pins";
import { type createSidebarRowMotion, sidebarRowKey } from "./sidebar-row-motion";
import type { SidebarProps } from "./sidebar-types";
import type { SidebarDragWriters } from "./stores/drag-state-store";

export interface SidebarDragEngineDeps {
  chatPinnedItems: () => SidebarPinnedItem[];
  assignedSectionId: (chatId: string) => string;
  commitSidebarDrop: (source: SidebarDragSource, target: SidebarDropTarget | null) => void;
  /** Read on the resolve path, so it is a predicate over the pin count - never a read of the source. */
  canPinDraggedItem: () => boolean;
  dragState: SidebarDragWriters;
  orderedPeople: () => TeamPresenceMember[];
  getAgentList: () => HTMLElement | undefined;
  /** Which kind of chat an id names, or null when it names none: only a known chat can be pinned. */
  chatKind: (chatId: string) => "agent" | "channel" | null;
  props: SidebarProps;
  scrollFades: ReturnType<typeof createScrollFades>;
  sectionAcceptsChat: (sectionId: string) => boolean;
  /** The folder rules for a dragged folder. Null when the host keeps sections flat. */
  folders: () => SidebarDragFolders | null;
  /** Holds the rows where a drop leaves them until the new order is in, then slides them there. */
  rowMotion?: ReturnType<typeof createSidebarRowMotion>;
  /** Whether a section is closed, so a drag that rests on it can open it. */
  sectionIsCollapsed: (sectionId: string) => boolean;
  /** The sections in a folder, or at the top of the list for null, in order. */
  sectionChildren: (parentId: string | null) => string[];
  /** The chats and folders in a section, in the order they show (fork #94). */
  sectionItems: (sectionId: string) => SidebarFolderItem[];
  visiblePinnedKeys: () => string[];
  visibleSectionIds: () => string[];
}

/** A drag that rests this long on a closed folder opens it. */
const SPRING_OPEN_MS = 700;

/** After the empty pin area opens, a drag aims at nothing until the pointer moves this far from its start. */
const DRAG_AIM_DISTANCE_PX = 6;

export function createSidebarDragEngine(deps: SidebarDragEngineDeps) {
  const {
    assignedSectionId,
    canPinDraggedItem,
    chatKind,
    chatPinnedItems,
    commitSidebarDrop,
    dragState,
    orderedPeople,
    scrollFades,
    sectionAcceptsChat,
    visiblePinnedKeys,
    visibleSectionIds,
  } = deps;

  let pinnedDragSlots: DragSlot[] = [];

  let chatDragSlots = new Map<string, ChatDragSlot>();

  let chatDragStartScrollTop = 0;

  let sectionDragSlots = new Map<string, SectionDragSlot>();

  let sectionDragStartScrollTop = 0;

  /**
   * Fork (docs/fork/FEATURES.md #94): how far each sibling of a dragged folder slid, with the dragged
   * folder's own gap, by section id. The drop resolver reads the folders where they show.
   */
  let sectionOffsets: Record<string, DragOffset> = {};

  let dragSession: SidebarDragSession | null = null;

  let dragGeometry: SidebarDragGeometry = { list: null, pinned: null };

  let dragPoint: SidebarDragPoint | null = null;

  /** Where a drag that opened the empty pin area started, until the pointer moves away from it. */
  let dragOrigin: SidebarDragPoint | null = null;

  let dragTarget: SidebarDropTarget | null = null;

  let dragTargetFrame: number | null = null;

  let dragScrollFrame: number | null = null;

  let dragScrollSpeed = 0;

  let personDragSlots = new Map<string, PersonDragSlot>();

  let suppressSidebarClickUntil = 0;

  let springOpen: { sectionId: string; timer: number } | null = null;

  const dragPreview = createBoundedDragPreview();

  function stopSidebarDragging(): void {
    if (dragTargetFrame !== null) cancelAnimationFrame(dragTargetFrame);
    if (dragScrollFrame !== null) cancelAnimationFrame(dragScrollFrame);
    window.removeEventListener("blur", stopSidebarDragging);
    deps.getAgentList()?.removeEventListener("transitionend", remeasureAfterTransition);
    stopSpringOpen();
    dragSession = null;
    dragPoint = null;
    dragOrigin = null;
    dragTarget = null;
    dragTargetFrame = null;
    dragScrollFrame = null;
    dragScrollSpeed = 0;
    dragGeometry = { list: null, pinned: null };
    sectionOffsets = {};
    dragState.resetDrag();
    clearSidebarDragDecorations(deps.getAgentList());
    for (const slot of personDragSlots.values()) slot.element.classList.remove("sidebar-person-item-dragging");
    chatDragSlots.clear();
    personDragSlots.clear();
    sectionDragSlots.clear();
    pinnedDragSlots = [];
    dragPreview.stop();
  }

  function stopSpringOpen(): void {
    if (springOpen) clearTimeout(springOpen.timer);
    springOpen = null;
  }

  /** Waits to open the closed section that the drag now aims at, and forgets any other. */
  function updateSpringOpen(target: SidebarDropTarget | null): void {
    const sectionId = target?.kind === "section" || target?.kind === "section-into" ? target.sectionId : null;
    if (!sectionId || !deps.sectionIsCollapsed(sectionId)) {
      stopSpringOpen();
      return;
    }
    if (springOpen?.sectionId === sectionId) return;
    stopSpringOpen();
    springOpen = {
      sectionId,
      timer: window.setTimeout(() => {
        springOpen = null;
        if (dragSession && deps.sectionIsCollapsed(sectionId)) deps.props.onToggleSection(sectionId);
      }, SPRING_OPEN_MS),
    };
  }

  /** A section that opens or closes during a drag moves the rows under it: measure them again. */
  function remeasureAfterTransition(event: TransitionEvent): void {
    if (!dragSession || event.propertyName !== "grid-template-rows") return;
    measureSidebarDragTargets();
    // The rows that slid aside slide to the places the new measure gives.
    sectionOffsets = itemReorderOffsets(dragTarget);
    dragState.setDragOffsets(sidebarDragOffsets(dragTarget));
    if (dragPoint) scheduleSidebarDragTarget(dragPoint);
  }

  /**
   * Fork #91: ignores the clicks on the list for a moment after a menu action, so that the second click
   * of a fast double click on a menu item does not open the row or the folder under the closed menu.
   */
  function suppressSidebarClicks(ms: number): void {
    suppressSidebarClickUntil = Math.max(suppressSidebarClickUntil, Date.now() + ms);
  }

  function sidebarClickIsSuppressed(event: MouseEvent): boolean {
    if (Date.now() >= suppressSidebarClickUntil) return false;
    event.preventDefault();
    event.stopPropagation();
    return true;
  }

  /**
   * Resets the caches and both drag-start scroll tops before anything can fail, then measures. The
   * early return matters: with no list there are no slots, but `dragGeometry` keeps its previous
   * value, and `resolveSidebarDropTarget` rejects every point once that becomes `{list: null}`.
   */
  function measureSidebarDragTargets(): void {
    sectionDragSlots = new Map();
    chatDragSlots = new Map();
    personDragSlots = new Map();
    pinnedDragSlots = [];
    const list = deps.getAgentList();
    const startScrollTop = list?.scrollTop ?? 0;
    sectionDragStartScrollTop = startScrollTop;
    chatDragStartScrollTop = startScrollTop;
    if (!list) return;
    const measurement = measureSidebarDragSlots(list, assignedSectionId);
    sectionDragSlots = measurement.sections;
    chatDragSlots = measurement.chats;
    personDragSlots = measurement.people;
    pinnedDragSlots = measurement.pinned;
    dragGeometry = measurement.geometry;
  }

  function startNativeItemDragging(
    event: DragEvent & { currentTarget: HTMLElement },
    options: SidebarNativeDragStart,
  ): void {
    if (deps.props.compact) {
      event.preventDefault();
      return;
    }
    event.dataTransfer?.setData("text/plain", options.data);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
    dragSession = { source: options.source, startScrollTop: deps.getAgentList()?.scrollTop ?? 0 };
    dragPoint = { clientX: event.clientX, clientY: event.clientY };
    dragTarget = null;
    dragState.beginDrag(options.source);
    measureSidebarDragTargets();
    const list = deps.getAgentList();
    if (!list) return;
    dragPreview.start({
      bounds: list,
      className: options.className,
      createPreview: options.createPreview,
      event,
      horizontal: options.horizontal,
      previewSize: options.previewSize,
      source: event.currentTarget,
    });
    list.addEventListener("transitionend", remeasureAfterTransition);
    window.addEventListener("blur", stopSidebarDragging, { once: true });
  }

  /** One drag for both row kinds: `chatId` is an agent id or a channel id. */
  function startChatDragging(event: DragEvent & { currentTarget: HTMLElement }, chatId: string): void {
    if (deps.props.compact) return;
    startNativeItemDragging(event, {
      className: "sidebar-agent-drag-preview",
      createPreview: createSidebarChatDragCard,
      data: `openbot-chat:${chatId}`,
      previewSize: { height: 102, width: 72 },
      source: { kind: "chat", id: chatId, origin: "section" },
    });
  }

  function startPersonDragging(event: DragEvent & { currentTarget: HTMLElement }, member: TeamPresenceMember): void {
    startNativeItemDragging(event, {
      className: "sidebar-person-drag-preview",
      createPreview: createSidebarChatDragCard,
      data: `openbot-person:${member.id}`,
      previewSize: { height: 102, width: 72 },
      source: { kind: "person", id: member.id, origin: "people" },
    });
    personDragSlots.get(member.id)?.element.classList.add("sidebar-person-item-dragging");
  }

  /** Fork (docs/fork/FEATURES.md #94): a folder lifts as the same card as a chat, and moves the same way. */
  function startSectionDragging(event: DragEvent & { currentTarget: HTMLElement }, sectionId: string): void {
    startNativeItemDragging(event, {
      className: "sidebar-agent-drag-preview",
      createPreview: createSidebarFolderDragCard,
      data: `openbot-section:${sectionId}`,
      previewSize: { height: 102, width: 72 },
      source: { kind: "section", id: sectionId },
    });
  }

  /**
   * The imperative half of the drag, snapshotted for the pure resolver. The three scroll deltas stay
   * separate because `dragSession.startScrollTop` is set on its own: they hold the same number
   * today, and one shared field would hide the day they stop.
   */
  function sidebarDragWorld(session: SidebarDragSession): SidebarDragWorld {
    const scrollTop = deps.getAgentList()?.scrollTop ?? 0;
    const folders = deps.folders();
    const sourceGap = session.source.kind === "section" ? sectionOffsets[session.source.id] : undefined;
    return {
      heldSectionTarget: sourceGap ? dragTarget : null,
      chatScrollDelta: scrollTop - chatDragStartScrollTop,
      chatSlots: folders && session.source.kind === "section" ? shiftedChatSlots(folders) : chatDragSlots,
      canPinDraggedItem,
      geometry: dragGeometry,
      personSlots: personDragSlots,
      pinnedSlots: pinnedDragSlots,
      sectionAcceptsChat,
      sectionScrollDelta: scrollTop - sectionDragStartScrollTop,
      sectionSlots: folders && session.source.kind === "section" ? shiftedSectionSlots(folders) : sectionDragSlots,
      folders,
      folderItems: folders ? deps.sectionItems : undefined,
      sectionIsCollapsed: deps.sectionIsCollapsed,
      session,
      sessionScrollDelta: scrollTop - session.startScrollTop,
    };
  }

  /**
   * Fork (docs/fork/FEATURES.md #94): the slots where the rows show while the rows around a dragged
   * folder slide aside. A row in a folder moves with every folder it is in.
   */
  function shiftOf(folders: SidebarDragFolders, sectionId: string | null, ownOffset: number): number {
    let y = ownOffset;
    for (let id = sectionId; id !== null; id = folders.parent(id)) y += sectionOffsets[id]?.y ?? 0;
    return y;
  }

  function shiftedSectionSlots(folders: SidebarDragFolders): Map<string, SectionDragSlot> {
    if (Object.keys(sectionOffsets).length === 0) return sectionDragSlots;
    const shifted = new Map<string, SectionDragSlot>();
    for (const [sectionId, slot] of sectionDragSlots) {
      const y = shiftOf(folders, sectionId, 0);
      shifted.set(
        sectionId,
        y === 0 ? slot : { ...slot, bottom: slot.bottom + y, centerY: slot.centerY + y, top: slot.top + y },
      );
    }
    return shifted;
  }

  function shiftedChatSlots(folders: SidebarDragFolders): Map<string, ChatDragSlot> {
    if (Object.keys(sectionOffsets).length === 0) return chatDragSlots;
    const shifted = new Map<string, ChatDragSlot>();
    for (const [chatId, slot] of chatDragSlots) {
      const y = shiftOf(folders, slot.sectionId, sectionOffsets[chatId]?.y ?? 0);
      shifted.set(
        chatId,
        y === 0 ? slot : { ...slot, bottom: slot.bottom + y, centerY: slot.centerY + y, top: slot.top + y },
      );
    }
    return shifted;
  }

  /** The section a dragged chat or folder is in now; null for a folder at the top of the list. */
  function sourceContainer(source: SidebarDragSource): string | null | undefined {
    if (source.kind === "chat") return assignedSectionId(source.id);
    if (source.kind === "section") return deps.folders()?.parent(source.id) ?? null;
    return undefined;
  }

  /** The section a target puts the dragged item in, beside the row it names. */
  function targetContainer(
    target: SidebarDropTarget,
  ): { container: string | null; id: string; placement: "before" | "after" } | null {
    if (target.kind === "chat")
      return { container: target.target.sectionId, id: target.target.chatId, placement: target.target.placement };
    if (target.kind === "section-order")
      return {
        container: deps.folders()?.parent(target.target.sectionId) ?? null,
        id: target.target.sectionId,
        placement: target.target.placement,
      };
    return null;
  }

  /**
   * Fork (docs/fork/FEATURES.md #94): a chat or folder dropped beside a row of its own section is a
   * reorder: the rows between slide by the height of the dragged row, chats and folders alike. A drop
   * into another section is a move and slides nothing; it keeps its drop line or folder outline. The
   * result has the dragged row's gap too, which the resolver of a folder drag reads.
   */
  function itemReorderOffsets(target: SidebarDropTarget | null): Record<string, DragOffset> {
    const source = dragSession?.source;
    const aim = target ? targetContainer(target) : null;
    if (!source || !aim) return {};
    const container = sourceContainer(source);
    if (container === undefined || container !== aim.container) return {};
    const items: SidebarFolderItem[] =
      container === null
        ? (deps.folders() ? deps.sectionChildren(null) : visibleSectionIds()).map((id) => ({ kind: "section", id }))
        : deps.sectionItems(container);
    const slots = new Map(
      items.map((item) => [item.id, item.kind === "chat" ? chatDragSlots.get(item.id) : sectionDragSlots.get(item.id)]),
    );
    return stackReorderOffsets(
      items.map((item) => item.id),
      source.id,
      { id: aim.id, placement: aim.placement },
      (id) => slots.get(id),
    );
  }

  function pointerIsAtDragOrigin(point: SidebarDragPoint): boolean {
    if (!dragOrigin) return false;
    return Math.hypot(point.clientX - dragOrigin.clientX, point.clientY - dragOrigin.clientY) < DRAG_AIM_DISTANCE_PX;
  }

  function resolveSidebarDropTarget(point: SidebarDragPoint): SidebarDropTarget | null {
    const session = dragSession;
    if (!session || pointerIsAtDragOrigin(point)) return null;
    return sidebarDropTargetAt(sidebarDragWorld(session), point);
  }

  /**
   * Which rows shift, and by how much, for the target now in flight. The source comes from
   * `dragSession` rather than from `drag.source`: this runs in the same tick as the target write
   * that drives it, and a store publishes a write only at the next flush.
   *
   * One computation for all four regions - see `reorderOffsets`. The guards below are the only part
   * that stays per-region, because each one names a different pairing of source and target that can
   * be hovered but not reordered: a tile being pinned from the list, an agent aimed at another
   * section, a person aimed at an agent.
   */
  function sidebarDragOffsets(target: SidebarDropTarget | null): Record<string, DragOffset> {
    const source = dragSession?.source;
    if (!source || !target) return {};
    switch (target.kind) {
      case "pinned": {
        if (source.kind !== "pinned" || !target.key) return {};
        const keys = visiblePinnedKeys();
        return reorderOffsets(
          keys,
          source.key,
          { id: target.key, placement: placementForSwap(keys, source.key, target.key) },
          (key) => pinnedDragSlots[keys.indexOf(key)],
          "x-and-y",
        );
      }
      case "chat":
      case "section-order": {
        // A chat or folder only pushes its own neighbours: aimed at another section it is a move.
        // Its own gap is for the resolver only: the dragged row does not show.
        const offsets = itemReorderOffsets(target);
        delete offsets[source.id];
        return offsets;
      }
      case "person": {
        if (source.kind !== "person") return {};
        return reorderOffsets(
          orderedPeople().map((member) => member.id),
          source.id,
          { id: target.target.memberId, placement: target.target.placement },
          (memberId) => personDragSlots.get(memberId),
          "y",
        );
      }
      default:
        return {};
    }
  }

  function applySidebarDropTarget(target: SidebarDropTarget | null): void {
    if (sidebarDropTargetsEqual(dragTarget, target)) return;
    dragTarget = target;
    updateSpringOpen(target);
    sectionOffsets = itemReorderOffsets(target);
    dragState.setDragTarget(target);
    dragState.setDragOffsets(sidebarDragOffsets(target));
  }

  function runSidebarDragTargetFrame(): void {
    dragTargetFrame = null;
    if (!dragPoint || !dragSession) return;
    applySidebarDropTarget(resolveSidebarDropTarget(dragPoint));
    updateSidebarDragAutoScroll(dragPoint.clientY);
  }

  function scheduleSidebarDragTarget(point: SidebarDragPoint): void {
    dragPoint = point;
    if (dragTargetFrame === null) dragTargetFrame = requestAnimationFrame(runSidebarDragTargetFrame);
  }

  function flushSidebarDragTarget(point: SidebarDragPoint): SidebarDropTarget | null {
    if (dragTargetFrame !== null) cancelAnimationFrame(dragTargetFrame);
    dragTargetFrame = null;
    dragPoint = point;
    const target = resolveSidebarDropTarget(point);
    applySidebarDropTarget(target);
    return target;
  }

  function runSidebarDragAutoScroll(): void {
    dragScrollFrame = null;
    const list = deps.getAgentList();
    if (!list || !dragSession || !dragPoint || dragScrollSpeed === 0) return;
    const previousScrollTop = list.scrollTop;
    list.scrollTop += dragScrollSpeed;
    if (list.scrollTop === previousScrollTop) {
      dragScrollSpeed = 0;
      return;
    }
    // The list moved under the pointer, so the pointer now aims at another row.
    dragOrigin = null;
    applySidebarDropTarget(resolveSidebarDropTarget(dragPoint));
    scrollFades.measure();
    dragScrollFrame = requestAnimationFrame(runSidebarDragAutoScroll);
  }

  function updateSidebarDragAutoScroll(clientY: number): void {
    const bounds = dragGeometry.list;
    if (!bounds) return;
    const edgeSize = Math.min(40, bounds.height / 4);
    if (clientY < bounds.top + edgeSize) {
      dragScrollSpeed = -Math.min(12, Math.ceil(((bounds.top + edgeSize - clientY) / edgeSize) * 12));
    } else if (clientY > bounds.bottom - edgeSize) {
      dragScrollSpeed = Math.min(12, Math.ceil(((clientY - (bounds.bottom - edgeSize)) / edgeSize) * 12));
    } else dragScrollSpeed = 0;
    if (dragScrollSpeed !== 0 && dragScrollFrame === null) {
      dragScrollFrame = requestAnimationFrame(runSidebarDragAutoScroll);
    } else if (dragScrollSpeed === 0 && dragScrollFrame !== null) {
      cancelAnimationFrame(dragScrollFrame);
      dragScrollFrame = null;
    }
  }

  function updateSidebarNativeDrag(event: DragEvent): void {
    if (!dragSession) return;
    if (
      !dragState.emptyPinnedDropVisible() &&
      chatPinnedItems().length === 0 &&
      dragSession.source.kind === "chat" &&
      chatKind(dragSession.source.id) !== null
    ) {
      const activeSession = dragSession;
      // The area pushes every row down under a still pointer. Until the pointer moves, the drag aims at
      // nothing, so a drop in place keeps the order. `dragPoint` is still the drag start here.
      dragOrigin = dragPoint;
      dragState.setEmptyPinnedDropVisible(true);
      queueMicrotask(() => {
        if (dragSession !== activeSession) return;
        measureSidebarDragTargets();
        if (dragPoint) scheduleSidebarDragTarget(dragPoint);
      });
    }
    const point = { clientX: event.clientX, clientY: event.clientY };
    if (!pointerIsAtDragOrigin(point)) dragOrigin = null;
    if (pointInRect(point, dragGeometry.list)) {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    }
    dragPreview.move(event.clientX, event.clientY);
    scheduleSidebarDragTarget(point);
  }

  function dropSidebarNativeDrag(event: DragEvent): void {
    if (!dragSession) return;
    event.preventDefault();
    event.stopPropagation();
    const animatedPinnedTarget =
      dragState.emptyPinnedDropVisible() && dragTarget?.kind === "pinned" ? dragTarget : null;
    if (dragState.emptyPinnedDropVisible() && !animatedPinnedTarget) measureSidebarDragTargets();
    const target = animatedPinnedTarget ?? flushSidebarDragTarget({ clientX: event.clientX, clientY: event.clientY });
    const source = dragSession.source;
    // Fork (docs/fork/FEATURES.md #94): a folder settles where it drops as a chat does.
    if (
      (source.kind === "chat" || source.kind === "section") &&
      target &&
      target.kind !== "pinned" &&
      target.kind !== "person"
    ) {
      deps.rowMotion?.beginDropSettle({
        key: sidebarRowKey(source.kind, source.id),
        clientY: event.clientY,
        expectsChange: dropChangesOrder(source, target),
      });
    }
    commitSidebarDrop(source, target);
    suppressSidebarClickUntil = Date.now() + 250;
    stopSidebarDragging();
  }

  /** Whether a chat or folder dropped on this target ends up somewhere else than where it is. */
  function dropChangesOrder(source: SidebarDragSource, target: SidebarDropTarget): boolean {
    const from = sourceContainer(source);
    if (target.kind === "section" || target.kind === "section-into") {
      if (target.sectionId !== from) return true;
      const items = deps.sectionItems(target.sectionId);
      const last = items[items.length - 1];
      // A chat goes after the last chat; a folder after everything.
      if (source.kind === "chat") return items.filter((item) => item.kind === "chat").at(-1)?.id !== source.id;
      return last?.id !== source.id;
    }
    const aim = targetContainer(target);
    if (!aim || aim.container !== from) return true;
    return Object.keys(itemReorderOffsets(target)).length > 0;
  }

  function endChatDragging(event: DragEvent): void {
    const session = dragSession;
    const canCommitAnimatedPin =
      dragState.emptyPinnedDropVisible() &&
      session?.source.kind === "chat" &&
      dragTarget?.kind === "pinned" &&
      (event.clientX !== 0 || event.clientY !== 0) &&
      pointInRect({ clientX: event.clientX, clientY: event.clientY }, dragGeometry.list);
    if (session && canCommitAnimatedPin) {
      commitSidebarDrop(session.source, dragTarget);
      suppressSidebarClickUntil = Date.now() + 250;
    }
    stopSidebarDragging();
  }

  /** The pointer left the list. Still inside it means a child boundary, not a leave. */
  function handleListDragLeave(event: DragEvent): void {
    const point = { clientX: event.clientX, clientY: event.clientY };
    if (pointInRect(point, dragGeometry.list)) return;
    scheduleSidebarDragTarget(point);
  }

  return {
    dropSidebarNativeDrag,
    endChatDragging,
    handleListDragLeave,
    sidebarClickIsSuppressed,
    startChatDragging,
    startNativeItemDragging,
    startPersonDragging,
    startSectionDragging,
    stopSidebarDragging,
    suppressSidebarClicks,
    updateSidebarNativeDrag,
  };
}
