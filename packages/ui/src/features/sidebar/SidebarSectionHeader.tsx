import { SIDEBAR_FOLDER_LEVELS } from "@openbot/contracts/ipc";
import {
  ArrowDown,
  ArrowUp,
  Badge,
  buttonVariants,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  ContextMenu,
  Copy,
  Folder,
  FolderInput,
  FolderOpen,
  FolderPlus,
  Pencil,
  Trash2,
} from "@openbot/ui";
import { createMemo, For, Show, untrack } from "solid-js";
import { useText } from "../../text";
import { SidebarSectionEditor } from "./SidebarSectionEditor";
import { useSidebarScope } from "./sidebar-scope";

/**
 * How long the list ignores clicks after Mark read: the item closes the menu, and a fast second click
 * would otherwise open the folder or the chat under it. macOS counts two clicks in 0.5 s as one double
 * click by default.
 */
const MENU_DOUBLE_CLICK_MS = 500;

/**
 * Mark read in a folder's menu: marks each unread agent in the folder and in the folders in it read,
 * through the agent menu's Mark read (its own chat and its side threads).
 *
 * The menu mounts this at each opening, and it decides there whether it shows. The marks clear the
 * unread set while the menu plays its close motion; an item that went away then would move Rename up
 * under the pointer, and a fast second click would rename the folder. The item also marks once per
 * opening, because the reads are still on their way at a second click, and it makes the list ignore
 * that click when it lands on the row or folder under the closed menu.
 */
function SectionMarkReadItem(itemProps: { sectionId: string }) {
  const { props, sectionUnreadAgentIds, suppressSidebarClicks } = useSidebarScope();
  const { t } = useText();
  const shown = untrack(() => sectionUnreadAgentIds(itemProps.sectionId).length > 0);
  let marked = false;
  const markRead = (markAgentRead: (agentId: string) => void) => {
    if (marked) return;
    marked = true;
    suppressSidebarClicks(MENU_DOUBLE_CLICK_MS);
    for (const agentId of sectionUnreadAgentIds(itemProps.sectionId)) markAgentRead(agentId);
  };
  return (
    <Show when={shown && props.onMarkAgentRead}>
      {(markAgentRead) => (
        <ContextMenu.Item onSelect={() => markRead(markAgentRead())}>
          <CheckCheck class="agent-context-icon size-4" aria-hidden="true" />
          <span>{t("sidebar.agentMenu.markRead")}</span>
        </ContextMenu.Item>
      )}
    </Show>
  );
}

export function SidebarSectionHeader(headerProps: { sectionId: string; name: string; depth?: number }) {
  const {
    customSectionById,
    duplicateSection,
    filteredChatsBySection,
    foldersSupported,
    layoutMutable,
    listFiltered,
    moveFolderTo,
    moveSection,
    openDelete,
    pending,
    props,
    sectionCanNest,
    sectionChatCount,
    sectionChildren,
    sectionIsCollapsed,
    sectionLabel,
    sectionParent,
    sectionSiblingIndex,
    sectionUnreadCount,
    sidebarClickIsSuppressed,
    startCreateSection,
    startRenameSection,
    startSectionDragging,
    stopSidebarDragging,
    visibleSectionIds,
    layoutDraggable,
  } = useSidebarScope();
  const { t } = useText();
  const editing = () => {
    const target = pending.sectionEditor?.target;
    return target?.kind === "rename" && target.sectionId === headerProps.sectionId;
  };
  const collapsed = () => sectionIsCollapsed(headerProps.sectionId);
  const custom = () => customSectionById().has(headerProps.sectionId);
  const sibling = () => sectionSiblingIndex(headerProps.sectionId);
  const depth = () => headerProps.depth ?? 0;
  const parentId = () => sectionParent(headerProps.sectionId);
  /** The parent folder shows no header while a filter shows it only for the folders in it. */
  const parentHeadless = () => {
    const parent = parentId();
    return parent !== null && listFiltered() && (filteredChatsBySection().get(parent)?.length ?? 0) === 0;
  };
  const parentName = () => (parentHeadless() ? customSectionById().get(parentId() ?? "")?.name : undefined);
  const unread = () => (collapsed() ? sectionUnreadCount(headerProps.sectionId) : 0);
  const hidden = createMemo(() => (collapsed() ? sectionChatCount(headerProps.sectionId) : 0));
  const empty = () =>
    (filteredChatsBySection().get(headerProps.sectionId)?.length ?? 0) === 0 &&
    sectionChildren(headerProps.sectionId).length === 0;
  const canHoldFolder = () => depth() + 1 < SIDEBAR_FOLDER_LEVELS;
  const destinations = () =>
    visibleSectionIds().filter(
      (sectionId) =>
        customSectionById().has(sectionId) &&
        sectionId !== parentId() &&
        sectionCanNest(headerProps.sectionId, sectionId),
    );
  const createInside = () => {
    if (collapsed()) props.onToggleSection(headerProps.sectionId);
    startCreateSection(undefined, headerProps.sectionId);
  };
  return (
    <Show when={!editing()} fallback={<SidebarSectionEditor />}>
      <header>
        <ContextMenu.Root modal={false}>
          <ContextMenu.Trigger
            as="button"
            type="button"
            class={buttonVariants({
              variant: "ghost",
              class: "sidebar-section-toggle sidebar-section-drag-handle",
            })}
            draggable={!layoutDraggable() || props.compact ? "false" : "true"}
            title={!layoutMutable() ? t("sidebar.section.layoutUnsupported") : undefined}
            aria-expanded={collapsed() ? "false" : "true"}
            aria-controls={`sidebar-section-body-${headerProps.sectionId}`}
            data-cuelume-open={collapsed() ? "" : undefined}
            data-cuelume-close={collapsed() ? undefined : ""}
            data-cuelume-emphasis="subtle"
            onClick={(event: MouseEvent) => {
              if (!sidebarClickIsSuppressed(event)) props.onToggleSection(headerProps.sectionId);
            }}
            onDragStart={(event: DragEvent & { currentTarget: HTMLElement }) =>
              startSectionDragging(event, headerProps.sectionId)
            }
            onDragEnd={stopSidebarDragging}
          >
            <span
              class="sidebar-section-name"
              title={custom() ? sectionLabel(headerProps.sectionId) : headerProps.name}
            >
              <Show when={custom() ? parentName() : undefined}>
                {(name) => <span class="sidebar-folder-parent">{name()} / </span>}
              </Show>
              {headerProps.name}
            </span>
            <Show when={hidden() > 0}>
              <span class="sidebar-section-count" aria-hidden="true">
                {t("sidebar.section.count", { count: hidden() })}
              </span>
              <span class="sr-only">{t("sidebar.section.chatCount", { count: hidden() })}</span>
            </Show>
            <span class="sidebar-folder-end">
              <Show when={unread() > 0}>
                <Badge class="sidebar-folder-unread" variant="primary-light" aria-hidden="true">
                  {Math.min(unread(), 99)}
                </Badge>
                <span class="sr-only">{t("sidebar.folder.unread", { count: unread() })}</span>
              </Show>
              <Show
                when={custom()}
                fallback={
                  <ChevronDown
                    class={`sidebar-section-chevron size-4${collapsed() ? " sidebar-section-chevron-collapsed" : ""}`}
                    aria-hidden="true"
                  />
                }
              >
                <Show
                  when={collapsed() || empty()}
                  fallback={<FolderOpen class="sidebar-folder-icon size-4" aria-hidden="true" />}
                >
                  <Folder class="sidebar-folder-icon size-4" aria-hidden="true" />
                </Show>
              </Show>
            </span>
          </ContextMenu.Trigger>
          <Show when={layoutMutable()}>
            <ContextMenu.Portal>
              <ContextMenu.Content class="agent-context-menu" aria-label={t("sidebar.section.actions")}>
                <SectionMarkReadItem sectionId={headerProps.sectionId} />
                <Show when={custom()}>
                  <ContextMenu.Item onSelectAfterClose={() => startRenameSection(headerProps.sectionId)}>
                    <Pencil class="agent-context-icon size-4" aria-hidden="true" />
                    <span>{t("common.rename")}</span>
                  </ContextMenu.Item>
                  <Show when={foldersSupported()}>
                    <ContextMenu.Item disabled={!canHoldFolder()} onSelectAfterClose={createInside}>
                      <FolderPlus class="agent-context-icon size-4" aria-hidden="true" />
                      <span>{t("sidebar.folder.newInside")}</span>
                    </ContextMenu.Item>
                  </Show>
                  <Show when={props.sectionDuplicateSupported && props.onDuplicateSection}>
                    <ContextMenu.Item
                      disabled={props.duplicatingSectionIds?.has(headerProps.sectionId) ?? false}
                      onSelect={() => duplicateSection(headerProps.sectionId)}
                    >
                      <Copy class="agent-context-icon size-4" aria-hidden="true" />
                      <span>
                        {props.duplicatingSectionIds?.has(headerProps.sectionId)
                          ? t("sidebar.section.duplicating")
                          : t("sidebar.section.duplicate")}
                      </span>
                    </ContextMenu.Item>
                  </Show>
                </Show>
                <Show when={custom() && foldersSupported() && (parentId() !== null || destinations().length > 0)}>
                  <ContextMenu.Sub>
                    <ContextMenu.SubTrigger>
                      <FolderInput class="agent-context-icon size-4" aria-hidden="true" />
                      <span>{t("sidebar.moveTo")}</span>
                      <ChevronRight class="agent-context-submenu-chevron size-4" aria-hidden="true" />
                    </ContextMenu.SubTrigger>
                    <ContextMenu.Portal>
                      <ContextMenu.SubContent
                        class="ui-action-menu agent-context-menu agent-context-submenu"
                        aria-label={t("sidebar.moveTo")}
                      >
                        <Show when={parentId() !== null}>
                          <ContextMenu.Item onSelect={() => moveFolderTo(headerProps.sectionId, null)}>
                            <FolderOpen class="agent-context-icon size-4" aria-hidden="true" />
                            <span>{t("sidebar.folder.topLevel")}</span>
                          </ContextMenu.Item>
                        </Show>
                        <For each={destinations()}>
                          {(sectionId) => (
                            <ContextMenu.Item onSelect={() => moveFolderTo(headerProps.sectionId, sectionId)}>
                              <Folder class="agent-context-icon size-4" aria-hidden="true" />
                              <span>{sectionLabel(sectionId)}</span>
                            </ContextMenu.Item>
                          )}
                        </For>
                      </ContextMenu.SubContent>
                    </ContextMenu.Portal>
                  </ContextMenu.Sub>
                </Show>
                <ContextMenu.Item
                  disabled={sibling().index <= 0}
                  onSelect={() => moveSection(headerProps.sectionId, "up")}
                >
                  <ArrowUp class="agent-context-icon size-4" aria-hidden="true" />
                  <span>{t("sidebar.section.moveUp")}</span>
                </ContextMenu.Item>
                <ContextMenu.Item
                  disabled={sibling().index < 0 || sibling().index >= sibling().total - 1}
                  onSelect={() => moveSection(headerProps.sectionId, "down")}
                >
                  <ArrowDown class="agent-context-icon size-4" aria-hidden="true" />
                  <span>{t("sidebar.section.moveDown")}</span>
                </ContextMenu.Item>
                <Show when={custom()}>
                  <ContextMenu.Separator />
                  <ContextMenu.Item
                    class="ui-action-menu-danger agent-context-danger"
                    onSelect={() => openDelete("section", headerProps.sectionId)}
                  >
                    <Trash2 class="agent-context-icon agent-context-danger-icon size-4" aria-hidden="true" />
                    <span>{t("common.delete")}</span>
                  </ContextMenu.Item>
                </Show>
              </ContextMenu.Content>
            </ContextMenu.Portal>
          </Show>
        </ContextMenu.Root>
      </header>
    </Show>
  );
}
