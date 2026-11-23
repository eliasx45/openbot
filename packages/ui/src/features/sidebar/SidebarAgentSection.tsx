/**
 * One section - the unassigned one included. A custom section is a folder: it stays visible while
 * empty so it can be dropped into, and it shows its chats first, then the folders in it.
 *
 * Fork (docs/fork/FEATURES.md #94): a folder can stand between its parent's chats (`sectionItems`).
 *
 * The unassigned section keeps its heading only once a custom section exists. Before that it is the
 * whole list, and "Unassigned" names it against nothing.
 */

import { SIDEBAR_UNASSIGNED_SECTION_ID } from "@openbot/contracts/ipc";
import { For, Match, Show, Switch } from "solid-js";
import { useText } from "../../text";
import { SidebarAgentRow } from "./SidebarAgentRow";
import { SidebarChannelRow } from "./SidebarChannelRow";
import { SidebarSectionDraft } from "./SidebarSectionEditor";
import { SidebarSectionHeader } from "./SidebarSectionHeader";
import { useSidebarScope } from "./sidebar-scope";
import type { SidebarChatItem } from "./sidebar-types";

const chatAgent = (chat: SidebarChatItem) => (chat.kind === "agent" ? chat.agent : undefined);
const chatChannel = (chat: SidebarChatItem) => (chat.kind === "channel" ? chat.channel : undefined);

export function SidebarAgentSection(sectionProps: { sectionId: string; depth: number }) {
  const {
    customSectionById,
    dragOffset,
    filteredChatsBySection,
    listFiltered,
    props,
    sectionDragClasses,
    sectionIsCollapsed,
    sectionItems,
    sectionLabel,
  } = useSidebarScope();
  const { t } = useText();
  const sectionId = () => sectionProps.sectionId;
  const chats = () => filteredChatsBySection().get(sectionId()) ?? [];
  const custom = () => customSectionById().get(sectionId());
  const chatById = () => new Map(chats().map((chat) => [chat.id, chat]));
  /** Keys, not items: a key stays the same object across a change, so each row keeps its element. */
  const itemKeys = () => sectionItems(sectionId()).map((item) => `${item.kind}:${item.id}`);
  const name = () =>
    sectionId() === SIDEBAR_UNASSIGNED_SECTION_ID ? t("sidebar.section.unassigned") : (custom()?.name ?? "");
  /**
   * While a filter is set, a folder that shows only for a folder in it has no header: the header of
   * the inner folder names the chats. It does not collapse then, because nothing could open it.
   * Fork (FEATURES.md #96): it is marked `data-headless` then, so it does not indent its body on a
   * tree line either.
   */
  const headed = () =>
    (Boolean(custom()) || props.layout.sections.length > 0) && !(listFiltered() && custom() && chats().length === 0);
  const collapsed = () => headed() && sectionIsCollapsed(sectionId());
  return (
    <Show when={name() && (chats().length > 0 || custom())}>
      <section
        class={[
          "sidebar-chat-group sidebar-section",
          { "sidebar-folder": Boolean(custom()) },
          sectionDragClasses(sectionId()),
        ]}
        style={`--sidebar-drag-y: ${dragOffset(sectionId()).y}px;`}
        aria-label={custom() ? sectionLabel(sectionId()) : name()}
        data-section-id={sectionId()}
        data-depth={custom() ? String(sectionProps.depth) : undefined}
        data-headless={headed() ? undefined : ""}
      >
        <Show when={headed()}>
          <SidebarSectionHeader sectionId={sectionId()} name={name()} depth={sectionProps.depth} />
        </Show>
        <div
          class="sidebar-section-collapse"
          data-collapsed={collapsed() ? "" : undefined}
          aria-hidden={collapsed() ? "true" : undefined}
          inert={collapsed() ? true : undefined}
        >
          <div id={`sidebar-section-body-${sectionId()}`} class="sidebar-section-body">
            <For each={itemKeys()}>
              {(key) => {
                const id = key.slice(key.indexOf(":") + 1);
                return key.startsWith("section:") ? (
                  <SidebarAgentSection sectionId={id} depth={sectionProps.depth + 1} />
                ) : (
                  <Show when={chatById().get(id)}>
                    {(chat) => (
                      <Switch>
                        <Match when={chatAgent(chat())}>{(agent) => <SidebarAgentRow agent={agent()} />}</Match>
                        <Match when={chatChannel(chat())}>
                          {(channel) => <SidebarChannelRow channel={channel()} />}
                        </Match>
                      </Switch>
                    )}
                  </Show>
                );
              }}
            </For>
            <Show when={custom()}>
              <SidebarSectionDraft parentId={sectionId()} />
            </Show>
          </div>
        </div>
      </section>
    </Show>
  );
}
