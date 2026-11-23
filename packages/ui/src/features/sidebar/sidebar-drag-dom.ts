/**
 * The DOM half of the sidebar drag: what it queries, what it measures, and the drag card it builds.
 * Kept apart from the model so the geometry can be produced in one place and read as plain values.
 */

import type {
  ChatDragSlot,
  DragSlot,
  PersonDragSlot,
  SectionDragSlot,
  SidebarDragGeometry,
} from "./sidebar-drag-model";

/**
 * Everything `measureSidebarDragSlots` asks the list for. Each name is emitted by exactly one JSX
 * site: `sectionRegion` by the People and agent sections, `chatRow` by the agent and channel rows, `personRow`
 * by the people section, `pinnedTile` by the pinned group. Renaming one here without renaming the
 * emitter leaves an empty slot map behind: the drag starts, tracks nothing and drops nowhere, and
 * no test fails loudly on it.
 */
export const SIDEBAR_DRAG_SELECTORS = {
  chatRow: "[data-chat-id]",
  closedBody: ".sidebar-section-collapse[data-collapsed]",
  personRow: "[data-person-id]",
  pinnedEmptyDrop: ".sidebar-pinned-empty-drop",
  pinnedGroup: ".sidebar-pinned-group",
  pinnedTile: "[data-pinned-key]",
  section: ".sidebar-section",
  sectionRegion: "[data-section-id]",
} as const;

/** One pass over the list: every slot cache plus the two rectangles the drop resolver guards on. */
export interface SidebarDragMeasurement {
  chats: Map<string, ChatDragSlot>;
  geometry: SidebarDragGeometry;
  people: Map<string, PersonDragSlot>;
  pinned: DragSlot[];
  sections: Map<string, SectionDragSlot>;
}

/**
 * The empty pin area slides open inside the pinned group, which clips it. Its own box has the full
 * height from the first frame, so it would cover the rows that have not moved down yet.
 */
function visiblePinnedBounds(group: HTMLElement, target: HTMLElement): DOMRect {
  const bounds = target.getBoundingClientRect();
  if (target === group) return bounds;
  const clip = group.getBoundingClientRect();
  const top = Math.max(bounds.top, clip.top);
  const bottom = Math.min(bounds.bottom, clip.bottom);
  return new DOMRect(bounds.left, top, bounds.width, Math.max(0, bottom - top));
}

export function measureSidebarDragSlots(
  list: HTMLElement,
  assignedSectionId: (chatId: string) => string,
): SidebarDragMeasurement {
  const sections = new Map<string, SectionDragSlot>();
  const chats = new Map<string, ChatDragSlot>();
  const people = new Map<string, PersonDragSlot>();
  const pinned: DragSlot[] = [];
  const pinnedGroup = list.querySelector<HTMLElement>(SIDEBAR_DRAG_SELECTORS.pinnedGroup);
  const pinnedTarget = pinnedGroup?.querySelector<HTMLElement>(SIDEBAR_DRAG_SELECTORS.pinnedEmptyDrop) ?? pinnedGroup;
  const listBounds = list.getBoundingClientRect();
  const geometry: SidebarDragGeometry = {
    list: listBounds,
    pinned: pinnedGroup && pinnedTarget ? visiblePinnedBounds(pinnedGroup, pinnedTarget) : null,
  };
  for (const section of list.querySelectorAll<HTMLElement>(SIDEBAR_DRAG_SELECTORS.sectionRegion)) {
    const sectionId = section.dataset.sectionId;
    if (!sectionId || isInClosedSection(section)) continue;
    const bounds = layoutBounds(section, list);
    const header = section.querySelector<HTMLElement>(":scope > header");
    // A stuck header is not at the top of its section, so its line comes from its style, not its box.
    const headerStyle = header ? getComputedStyle(header) : null;
    const stickOffset = headerStyle?.position === "sticky" ? Number.parseFloat(headerStyle.top) : Number.NaN;
    sections.set(sectionId, {
      bottom: bounds.bottom,
      sectionId,
      top: bounds.top,
      centerY: bounds.top + bounds.height / 2,
      header: header
        ? {
            height: header.offsetHeight,
            stickTop: Number.isFinite(stickOffset) ? listBounds.top + list.clientTop + stickOffset : null,
          }
        : null,
    });
  }
  for (const row of list.querySelectorAll<HTMLElement>(SIDEBAR_DRAG_SELECTORS.chatRow)) {
    const chatId = row.dataset.chatId;
    if (!chatId || isInClosedSection(row)) continue;
    const bounds = row.getBoundingClientRect();
    chats.set(chatId, {
      bottom: bounds.bottom,
      centerY: bounds.top + bounds.height / 2,
      chatId,
      element: row,
      height: bounds.height,
      sectionId: assignedSectionId(chatId),
      top: bounds.top,
    });
  }
  for (const row of list.querySelectorAll<HTMLElement>(SIDEBAR_DRAG_SELECTORS.personRow)) {
    const memberId = row.dataset.personId;
    if (!memberId) continue;
    const bounds = row.getBoundingClientRect();
    people.set(memberId, {
      bottom: bounds.bottom,
      centerY: bounds.top + bounds.height / 2,
      element: row,
      memberId,
      top: bounds.top,
    });
  }
  for (const item of list.querySelectorAll<HTMLElement>(SIDEBAR_DRAG_SELECTORS.pinnedTile)) {
    const key = item.dataset.pinnedKey;
    if (!key) continue;
    const bounds = item.getBoundingClientRect();
    pinned.push({
      bottom: bounds.bottom,
      centerX: bounds.left + bounds.width / 2,
      centerY: bounds.top + bounds.height / 2,
      key,
      left: bounds.left,
      right: bounds.right,
      top: bounds.top,
    });
  }
  return { chats, geometry, people, pinned, sections };
}

/**
 * Fork (docs/fork/FEATURES.md #94): a section's box without the slide it and the sections around it
 * show now. A folder that opens during a folder drag makes the drag measure again while its siblings
 * are moved aside; their slots must stay where the layout puts them.
 */
function layoutBounds(section: HTMLElement, list: HTMLElement): DOMRect {
  const bounds = section.getBoundingClientRect();
  let shift = 0;
  for (let element: HTMLElement | null = section; element && element !== list; element = element.parentElement) {
    if (!element.matches(SIDEBAR_DRAG_SELECTORS.sectionRegion)) continue;
    const transform = getComputedStyle(element).transform;
    if (transform && transform !== "none") shift += new DOMMatrixReadOnly(transform).m42;
  }
  return shift === 0 ? bounds : new DOMRect(bounds.left, bounds.top - shift, bounds.width, bounds.height);
}

/**
 * A closed section keeps its rows and its folders in the DOM, at a height of zero. They take no drop,
 * so a drop there goes to the closed section itself.
 */
function isInClosedSection(element: HTMLElement): boolean {
  return Boolean(element.parentElement?.closest(SIDEBAR_DRAG_SELECTORS.closedBody));
}

/** Takes the drop highlight off every section and off the pinned group. */
export function clearSidebarDragDecorations(list: HTMLElement | undefined): void {
  list?.querySelector(SIDEBAR_DRAG_SELECTORS.pinnedGroup)?.classList.remove("sidebar-pinned-group-agent-drop-target");
  for (const section of list?.querySelectorAll<HTMLElement>(SIDEBAR_DRAG_SELECTORS.section) ?? []) {
    section.classList.remove(
      "sidebar-section-agent-drop-target",
      "sidebar-section-drop-before",
      "sidebar-section-drop-after",
      "sidebar-section-drop-into",
    );
  }
}

export function createSidebarChatDragCard(source: HTMLElement): HTMLElement {
  const sourceAvatar = source.querySelector(".agent-row-avatar")?.cloneNode(true);
  return createSidebarDragCard(
    sourceAvatar instanceof HTMLElement ? sourceAvatar : null,
    source
      .querySelector(".sidebar-pinned-name, .agent-row-title strong, .agent-row-heading > strong")
      ?.textContent?.trim() ?? "Chat",
    source.querySelector(".sidebar-pinned-title, .agent-role-badge")?.textContent?.trim(),
  );
}

/**
 * Fork (docs/fork/FEATURES.md #94): a dragged folder lifts as the same card as a dragged chat, with
 * the folder icon of its header in place of the avatar.
 */
export function createSidebarFolderDragCard(source: HTMLElement): HTMLElement {
  const avatar = document.createElement("span");
  avatar.className = "agent-row-avatar sidebar-folder-drag-avatar";
  const icon = source.querySelector(".sidebar-folder-icon, .sidebar-section-chevron")?.cloneNode(true);
  if (icon instanceof SVGElement) {
    icon.removeAttribute("class");
    avatar.append(icon);
  }
  const name = source.querySelector(".sidebar-section-name");
  const ownName = [...(name?.childNodes ?? [])]
    .filter((node) => node.nodeType === Node.TEXT_NODE)
    .map((node) => node.textContent ?? "")
    .join("")
    .trim();
  return createSidebarDragCard(avatar, ownName || name?.textContent?.trim() || "Folder", undefined);
}

function createSidebarDragCard(avatar: HTMLElement | null, nameText: string, titleText: string | undefined) {
  const card = document.createElement("div");
  card.className = "agent-row sidebar-pinned-row sidebar-agent-drag-card";

  if (avatar) {
    avatar.classList.add("sidebar-pinned-avatar");
    card.append(avatar);
  }

  const copy = document.createElement("span");
  copy.className = "agent-row-copy sidebar-pinned-copy";
  const name = document.createElement("strong");
  name.className = "sidebar-pinned-name";
  name.textContent = nameText;
  copy.append(name);

  if (titleText) {
    const title = document.createElement("span");
    title.className = "z-badge z-badge-variant-secondary sidebar-pinned-title";
    title.dataset.slot = "badge";
    title.dataset.variant = "secondary";
    title.dataset.size = "sm";
    const label = document.createElement("span");
    label.textContent = titleText;
    title.append(label);
    copy.append(title);
  }

  card.append(copy);
  return card;
}
