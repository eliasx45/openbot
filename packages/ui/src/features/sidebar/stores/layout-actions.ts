import {
  SIDEBAR_PEOPLE_SECTION_ID,
  SIDEBAR_UNASSIGNED_SECTION_ID,
  type SidebarFolderItem,
  type SidebarLayoutAction,
  type TeamPresenceMember,
} from "@openbot/contracts/ipc";
import { currentText } from "../../../text";
import { teamMemberName } from "../../team/TeamPersonAvatar";
import type {
  ChatDropTarget,
  PersonDropTarget,
  SectionDropTarget,
  SidebarDragSource,
  SidebarDropTarget,
} from "../sidebar-drag-model";
import { type SidebarPinnedItem, sidebarPinnedItemKey } from "../sidebar-pins";
import { type SidebarChatItem, type SidebarProps, sidebarChatOrderSortsSections } from "../sidebar-types";

export function createSidebarLayoutActions(deps: {
  chatPinnedItems: () => SidebarPinnedItem[];
  announce: (message: string) => void;
  announceError: (cause: unknown) => void;
  assignedSectionId: (chatId: string) => string;
  canPinDraggedSidebarItem: () => boolean;
  chatName: (chatId: string) => string;
  draggedSidebarItem: () => SidebarPinnedItem | null;
  filteredChatsBySection: () => Map<string, SidebarChatItem[]>;
  foldersSupported: () => boolean;
  layoutMutable: () => boolean;
  orderedPeople: () => TeamPresenceMember[];
  personById: () => Map<string, TeamPresenceMember>;
  props: SidebarProps;
  sectionCanNest: (sectionId: string, parentId: string | null) => boolean;
  sectionChildren: (parentId: string | null) => string[];
  /** The chats and folders in a section, in the order they show (fork #94). */
  sectionItems: (sectionId: string) => SidebarFolderItem[];
  sectionLabel: (sectionId: string) => string;
  sectionParent: (sectionId: string) => string | null;
  visiblePinnedKeys: () => string[];
  visibleSectionIds: () => string[];
}) {
  const {
    announce,
    announceError,
    assignedSectionId,
    canPinDraggedSidebarItem,
    chatName,
    chatPinnedItems,
    draggedSidebarItem,
    filteredChatsBySection,
    foldersSupported,
    layoutMutable,
    orderedPeople,
    personById,
    props,
    sectionCanNest,
    sectionChildren,
    sectionItems,
    sectionLabel,
    sectionParent,
    visiblePinnedKeys,
    visibleSectionIds,
  } = deps;

  /** A folder of the user's, which can hold chats and folders side by side. */
  const isFolder = (sectionId: string | null): sectionId is string =>
    sectionId !== null && sectionId !== SIDEBAR_UNASSIGNED_SECTION_ID && sectionId !== SIDEBAR_PEOPLE_SECTION_ID;

  /**
   * Fork (docs/fork/FEATURES.md #94): the action that puts a chat or folder in a folder right before or
   * after one of its rows, the place the drag showed.
   */
  function placeAction(
    item: SidebarFolderItem,
    parentId: string,
    beside: SidebarFolderItem,
    placement: "before" | "after",
  ): SidebarLayoutAction | null {
    const items = sectionItems(parentId).filter(
      (candidate) => candidate.kind !== item.kind || candidate.id !== item.id,
    );
    const index = items.findIndex((candidate) => candidate.kind === beside.kind && candidate.id === beside.id);
    if (index < 0) return null;
    const after = items.slice(index + (placement === "after" ? 1 : 0));
    return {
      type: "place",
      item,
      parentId,
      beforeAgentId: after.find((candidate) => candidate.kind === "chat")?.id ?? null,
      beforeSectionId: after.find((candidate) => candidate.kind === "section")?.id ?? null,
    };
  }

  function commitPlace(
    item: SidebarFolderItem,
    parentId: string,
    beside: SidebarFolderItem,
    placement: "before" | "after",
  ): void {
    const action = placeAction(item, parentId, beside, placement);
    if (!action) return;
    const name = item.kind === "chat" ? chatName(item.id) : sectionLabel(item.id);
    void props
      .onMutateLayout(action)
      .then(() => announce(t("sidebar.announce.movedIn", { name, section: sectionLabel(parentId) })), announceError);
  }
  const { t } = currentText();

  function sectionSiblingIndex(sectionId: string): { index: number; total: number } {
    const siblings = foldersSupported() ? sectionChildren(sectionParent(sectionId)) : visibleSectionIds();
    return { index: siblings.indexOf(sectionId), total: siblings.length };
  }

  function nestSection(sectionId: string, parentId: string | null, beforeSectionId: string | null): void {
    if (!sectionCanNest(sectionId, parentId)) return;
    void props.onMutateLayout({ type: "nest", sectionId, parentId, beforeSectionId }).then(() => {
      const siblings = sectionChildren(parentId);
      announce(
        t("sidebar.announce.movedToPosition", {
          name: sectionLabel(sectionId),
          position: siblings.indexOf(sectionId) + 1,
          total: siblings.length,
        }),
      );
    }, announceError);
  }

  function moveFolderTo(sectionId: string, parentId: string | null): void {
    if (sectionParent(sectionId) === parentId) return;
    nestSection(sectionId, parentId, null);
  }

  function moveSection(sectionId: string, direction: "up" | "down"): void {
    if (foldersSupported()) {
      const parentId = sectionParent(sectionId);
      const siblings = sectionChildren(parentId);
      const index = siblings.indexOf(sectionId);
      if (index < 0) return;
      if (direction === "up") {
        const before = siblings[index - 1];
        if (before) nestSection(sectionId, parentId, before);
      } else if (index + 1 < siblings.length) {
        nestSection(sectionId, parentId, siblings[index + 2] ?? null);
      }
      return;
    }
    const visibleOrder = visibleSectionIds();
    const index = visibleOrder.indexOf(sectionId);
    const targetSectionId = visibleOrder[index + (direction === "up" ? -1 : 1)];
    const rawIndex = props.layout.order.indexOf(sectionId);
    const rawTargetIndex = targetSectionId ? props.layout.order.indexOf(targetSectionId) : -1;
    if (index < 0 || rawIndex < 0 || rawTargetIndex < 0) return;
    const steps = Math.abs(rawTargetIndex - rawIndex);
    void props.onMutateLayout({ type: "move", sectionId, direction, steps }).catch(announceError);
  }

  function duplicateSection(sectionId: string): void {
    void props.onDuplicateSection?.(sectionId).catch(announceError);
  }

  function assignChatSection(chatId: string, sectionId: string | null): void {
    void props.onMutateLayout({ type: "assign", agentId: chatId, sectionId }).catch(announceError);
  }

  function sectionChatIdsWithout(sectionId: string, chatId: string): string[] {
    return (filteredChatsBySection().get(sectionId) ?? [])
      .map((item) => item.id)
      .filter((candidate) => candidate !== chatId);
  }

  function reorderDraggedPerson(sourceMemberId: string, target: PersonDropTarget): void {
    const memberIds = orderedPeople()
      .map((member) => member.id)
      .filter((memberId) => memberId !== sourceMemberId);
    const targetIndex = memberIds.indexOf(target.memberId);
    if (targetIndex < 0) return;
    memberIds.splice(targetIndex + (target.placement === "after" ? 1 : 0), 0, sourceMemberId);
    props.onReorderPeople(memberIds);
    const position = memberIds.indexOf(sourceMemberId) + 1;
    const member = personById().get(sourceMemberId);
    announce(
      t("sidebar.announce.movedToPosition", {
        name: member ? teamMemberName(member) : t("sidebar.announce.personFallback"),
        position,
        total: memberIds.length,
      }),
    );
  }

  function movePersonByKeyboard(memberId: string, direction: -1 | 1): void {
    const visibleMemberIds = orderedPeople().map((member) => member.id);
    const index = visibleMemberIds.indexOf(memberId);
    const targetMemberId = visibleMemberIds[index + direction];
    if (index < 0 || !targetMemberId) return;
    reorderDraggedPerson(memberId, {
      memberId: targetMemberId,
      placement: direction < 0 ? "before" : "after",
    });
  }

  function moveDraggedChat(chatId: string, target: ChatDropTarget): void {
    const action = moveChatAction(chatId, target);
    if (!action) return;
    void props
      .onMutateLayout(action)
      .then(
        () =>
          announce(t("sidebar.announce.movedIn", { name: chatName(chatId), section: sectionLabel(target.sectionId) })),
        announceError,
      );
  }

  function reorderDraggedSection(sourceSectionId: string, target: SectionDropTarget): void {
    if (sourceSectionId === target.sectionId) return;
    if (foldersSupported()) {
      const parentId = sectionParent(target.sectionId);
      const siblings = sectionChildren(parentId).filter((sectionId) => sectionId !== sourceSectionId);
      const index = siblings.indexOf(target.sectionId);
      if (index < 0) return;
      nestSection(
        sourceSectionId,
        parentId,
        target.placement === "before" ? target.sectionId : (siblings[index + 1] ?? null),
      );
      return;
    }
    const sourceIndex = props.layout.order.indexOf(sourceSectionId);
    if (sourceIndex < 0) return;
    const orderWithoutSource = props.layout.order.filter((sectionId) => sectionId !== sourceSectionId);
    const targetIndex = orderWithoutSource.indexOf(target.sectionId);
    if (targetIndex < 0) return;
    const insertionIndex = targetIndex + (target.placement === "after" ? 1 : 0);
    const steps = Math.abs(insertionIndex - sourceIndex);
    if (steps === 0) return;
    const direction = insertionIndex < sourceIndex ? "up" : "down";

    const visibleOrder = visibleSectionIds().filter((sectionId) => sectionId !== sourceSectionId);
    const visibleTargetIndex = visibleOrder.indexOf(target.sectionId);
    const visibleInsertionIndex = visibleTargetIndex + (target.placement === "after" ? 1 : 0);
    void props.onMutateLayout({ type: "move", sectionId: sourceSectionId, direction, steps }).then(
      () =>
        announce(
          t("sidebar.announce.movedToPosition", {
            name: sectionLabel(sourceSectionId),
            position: visibleInsertionIndex + 1,
            total: visibleOrder.length + 1,
          }),
        ),
      announceError,
    );
  }

  function pinDraggedSidebarItem(): boolean {
    const item = draggedSidebarItem();
    if (!item || !canPinDraggedSidebarItem()) return false;
    props.onPin(item);
    announce(t("sidebar.announce.pinned", { name: chatName(item.id) }));
    return true;
  }

  function moveChatAction(chatId: string, target: ChatDropTarget): SidebarLayoutAction | null {
    if (sidebarChatOrderSortsSections(props.chatOrder)) return appendChatAction(chatId, target.sectionId);
    const idsWithoutSource = sectionChatIdsWithout(target.sectionId, chatId);
    const targetIndex = idsWithoutSource.indexOf(target.chatId);
    if (targetIndex < 0) return null;
    return {
      type: "move-agent",
      agentId: chatId,
      sectionId: target.sectionId === SIDEBAR_UNASSIGNED_SECTION_ID ? null : target.sectionId,
      beforeAgentId: target.placement === "before" ? target.chatId : (idsWithoutSource[targetIndex + 1] ?? null),
    };
  }

  function appendChatAction(chatId: string, sectionId: string): SidebarLayoutAction {
    return {
      type: "move-agent",
      agentId: chatId,
      sectionId: sectionId === SIDEBAR_UNASSIGNED_SECTION_ID ? null : sectionId,
      beforeAgentId: null,
    };
  }

  function pinnedRef(key: string): SidebarPinnedItem | undefined {
    return chatPinnedItems().find((item) => sidebarPinnedItemKey(item) === key);
  }

  async function commitPinnedChatDrop(
    source: Extract<SidebarDragSource, { kind: "pinned" }>,
    target: SidebarDropTarget | null,
  ) {
    if (target && target.kind !== "pinned" && !layoutMutable()) {
      announce(t("sidebar.section.layoutUnsupported"));
      return;
    }
    let action: SidebarLayoutAction | null = null;
    let sectionId = assignedSectionId(source.id);
    if (target?.kind === "chat") {
      action = moveChatAction(source.id, target.target);
      sectionId = target.target.sectionId;
    } else if (target?.kind === "section") {
      sectionId = target.sectionId;
      if (assignedSectionId(source.id) !== target.sectionId) action = appendChatAction(source.id, target.sectionId);
    }
    const ref = pinnedRef(source.key);
    if (!ref) return;
    try {
      if (action) await props.onMutateLayout(action);
      props.onUnpin(ref);
      announce(t("sidebar.announce.movedTo", { name: chatName(source.id), section: sectionLabel(sectionId) }));
    } catch (error) {
      announceError(error);
    }
  }

  function commitSidebarDrop(source: SidebarDragSource, target: SidebarDropTarget | null): void {
    if ("origin" in source && source.origin === "pinned") {
      if (target?.kind === "pinned") {
        if (target.key) reorderPinnedItem(source.key, target.key);
      } else {
        void commitPinnedChatDrop(source, target);
      }
      return;
    }

    if (source.kind === "chat") {
      const chat: SidebarFolderItem = { kind: "chat", id: source.id };
      if (target?.kind === "pinned") pinDraggedSidebarItem();
      else if (target?.kind === "chat" && foldersSupported() && isFolder(target.target.sectionId))
        commitPlace(chat, target.target.sectionId, { kind: "chat", id: target.target.chatId }, target.target.placement);
      else if (target?.kind === "chat") moveDraggedChat(source.id, target.target);
      else if (target?.kind === "section-order") {
        const parentId = sectionParent(target.target.sectionId);
        if (isFolder(parentId))
          commitPlace(chat, parentId, { kind: "section", id: target.target.sectionId }, target.target.placement);
      } else if (target?.kind === "section") {
        void props
          .onMutateLayout(appendChatAction(source.id, target.sectionId))
          .then(
            () =>
              announce(
                t("sidebar.announce.movedTo", { name: chatName(source.id), section: sectionLabel(target.sectionId) }),
              ),
            announceError,
          );
      }
      return;
    }

    if (source.kind === "person") {
      if (target?.kind === "person") reorderDraggedPerson(source.id, target.target);
      return;
    }

    const folder: SidebarFolderItem = { kind: "section", id: source.id };
    if (target?.kind === "chat")
      commitPlace(folder, target.target.sectionId, { kind: "chat", id: target.target.chatId }, target.target.placement);
    else if (target?.kind === "section-order") {
      const parentId = sectionParent(target.target.sectionId);
      if (foldersSupported() && isFolder(parentId))
        commitPlace(folder, parentId, { kind: "section", id: target.target.sectionId }, target.target.placement);
      else reorderDraggedSection(source.id, target.target);
    } else if (target?.kind === "section-into") nestSection(source.id, target.sectionId, null);
  }

  function reorderPinnedItem(sourceKey: string, targetKey: string): void {
    if (sourceKey === targetKey) return;
    const items = [...chatPinnedItems()];
    const sourceIndex = items.findIndex((item) => sidebarPinnedItemKey(item) === sourceKey);
    const targetIndex = items.findIndex((item) => sidebarPinnedItemKey(item) === targetKey);
    if (sourceIndex < 0 || targetIndex < 0) return;
    const [source] = items.splice(sourceIndex, 1);
    if (!source) return;
    items.splice(targetIndex, 0, source);
    props.onReorderPinned(items);
    const position = visiblePinnedKeys().indexOf(targetKey) + 1;
    announce(t("sidebar.announce.movedPinned", { position, total: visiblePinnedKeys().length }));
  }

  function movePinnedItem(key: string, direction: -1 | 1): void {
    const keys = visiblePinnedKeys();
    const index = keys.indexOf(key);
    const targetKey = keys[index + direction];
    if (index < 0 || targetKey === undefined) return;
    reorderPinnedItem(key, targetKey);
  }

  return {
    assignChatSection,
    commitSidebarDrop,
    duplicateSection,
    moveDraggedChat,
    moveFolderTo,
    movePersonByKeyboard,
    movePinnedItem,
    moveSection,
    pinDraggedSidebarItem,
    reorderDraggedPerson,
    reorderDraggedSection,
    reorderPinnedItem,
    sectionSiblingIndex,
  };
}
