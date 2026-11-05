/**
 * Files dragged onto a chat row from outside the sidebar: from Finder, a screenshot tool or an image
 * in the open chat. The row shows that it takes the drop, and `onDropFiles` names the chat.
 *
 * The row does not read the files. On the desktop the preload imports them, as for a drop on the
 * composer; `data-openbot-file-drop` tells it that the row takes files. A sidebar reorder is not a
 * file drag, so the drag engine keeps it.
 */

import { createSignal } from "solid-js";
import type { SidebarFileDropChat, SidebarProps } from "../sidebar-types";

function carriesFiles(event: DragEvent): boolean {
  return event.dataTransfer?.types.includes("Files") === true;
}

export function createSidebarFileDropTargets(deps: { props: SidebarProps; dragActive: () => boolean }) {
  /**
   * Call it in the row component. Put the handlers on the element that takes the drop, and set
   * `data-openbot-file-drop` on it while `enabled()` is true.
   */
  function createFileDropTarget(chat: () => SidebarFileDropChat | undefined) {
    const [active, setActive] = createSignal(false);
    const accepts = (event: DragEvent) =>
      deps.props.onDropFiles !== undefined && chat() !== undefined && !deps.dragActive() && carriesFiles(event);
    return {
      active,
      enabled: () => deps.props.onDropFiles !== undefined && chat() !== undefined,
      onDragOver(event: DragEvent) {
        if (!accepts(event)) return;
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
        setActive(true);
      },
      onDragLeave(event: DragEvent & { currentTarget: HTMLElement }) {
        if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
        setActive(false);
      },
      onDrop(event: DragEvent) {
        setActive(false);
        const target = chat();
        if (!accepts(event) || !target) return;
        // Not stopped: the desktop preload reads the files of this drop on the window.
        event.preventDefault();
        deps.props.onDropFiles?.(target);
      },
    };
  }
  return { createFileDropTarget };
}
