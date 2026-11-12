/**
 * The New menu: a new agent, channel or section. Upstream (#7830) puts it at the end of the search field;
 * the fork's expanded sidebar has no search field row, so its top bar shows the menu next to Search
 * (docs/fork/FEATURES.md, "Search sits in the sidebar's top bar").
 */

import { Bot, DropdownMenu, FolderPlus, Hash } from "@openbot/ui";
import { Show } from "solid-js";
import { useText } from "../../text";
import { PlusIcon } from "./SidebarIcons";
import { useSidebarScope } from "./sidebar-scope";

export function SidebarNewMenu() {
  const { layoutMutable, props, startCreateSection } = useSidebarScope();
  const { t } = useText();
  return (
    <Show when={props.createSupported !== false || props.onCreateChannel || layoutMutable()}>
      <DropdownMenu.Root placement="bottom-end" gutter={4}>
        <DropdownMenu.Trigger
          class="sidebar-icon-button sidebar-new-button no-drag"
          aria-label={props.onCreateChannel ? t("sidebar.new.menuWithChannel") : t("sidebar.new.menu")}
          aria-hidden={props.compact ? "true" : undefined}
          tabindex={props.compact ? -1 : 0}
        >
          <PlusIcon />
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content>
            <Show when={props.createSupported !== false}>
              <DropdownMenu.Item onSelectAfterClose={props.onCreateAgent}>
                <Bot aria-hidden="true" />
                {t("sidebar.new.agent")}
              </DropdownMenu.Item>
            </Show>
            <Show when={props.onCreateChannel}>
              <DropdownMenu.Item onSelectAfterClose={() => props.onCreateChannel?.()}>
                <Hash aria-hidden="true" />
                {t("sidebar.new.channel")}
              </DropdownMenu.Item>
            </Show>
            <Show when={layoutMutable()}>
              <DropdownMenu.Item onSelectAfterClose={() => startCreateSection()}>
                <FolderPlus aria-hidden="true" />
                {t("sidebar.new.section")}
              </DropdownMenu.Item>
            </Show>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </Show>
  );
}
