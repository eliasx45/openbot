import { coordinatorText } from "@openbot/contracts/coordinator-text";
import type { ChannelSummary } from "@openbot/contracts/ipc";
import { Badge, buttonVariants, ContextMenu } from "@openbot/ui";
import type { JSX } from "@solidjs/web";
import { createMemo, createSignal, Show } from "solid-js";
import { useText } from "../../text";
import { ChannelAvatar } from "../channels/ChannelAvatar";
import { SidebarAgentIndicator, SidebarWaitChip, SidebarWaitTooltip } from "./SidebarAgentIndicator";
import { SidebarChannelContextMenu, SidebarDeletedChannelContextMenu } from "./SidebarChannelContextMenu";
import { SidebarNameTooltip } from "./SidebarNameTooltip";
import { sidebarUnreadBadge } from "./sidebar-agent-states";
import { sidebarAgentStateLabel, sidebarMessageTime } from "./sidebar-filtering";
import { useSidebarScope } from "./sidebar-scope";

export function SidebarChannelRow(rowProps: { channel: ChannelSummary; waiting?: boolean }) {
  const {
    createFileDropTarget,
    dragOffset,
    draggedChatId,
    endChatDragging,
    chatsDraggable,
    props,
    sidebarClickIsSuppressed,
    startChatDragging,
  } = useSidebarScope();
  const { t, format, sourceText } = useText();
  const fileDrop = createFileDropTarget(() =>
    rowProps.channel.archived ? undefined : { kind: "channel", id: rowProps.channel.id },
  );
  const active = () => props.activeChannelId === rowProps.channel.id;
  const channelWait = () => props.channelWaits?.[rowProps.channel.id];
  const badgeState = createMemo(() => sidebarUnreadBadge(rowProps.channel.unreadCount, channelWait()));
  const wait = () => (rowProps.waiting ? channelWait() : undefined);
  const stateLabel = () => {
    const current = channelWait();
    return current ? sidebarAgentStateLabel(current, t, format) : "";
  };
  const waitLabel = () => (stateLabel() ? `. ${stateLabel()}` : "");
  const draggable = () => !rowProps.channel.archived && chatsDraggable() && !props.compact && !rowProps.waiting;
  const [menuOpen, setMenuOpen] = createSignal(false);
  const title = () => rowProps.channel.title.trim();
  const previewPending = () => props.channelPreviewsPending === true && !rowProps.channel.lastMessage;
  const time = () =>
    previewPending() ? "" : sidebarMessageTime(rowProps.channel.lastMessage?.at ?? rowProps.channel.createdAt, format);
  const working = () => Math.max(rowProps.channel.activeTasks, rowProps.channel.runningSubagents ?? 0);
  const lastMessageText = () => {
    const message = rowProps.channel.lastMessage;
    if (!message) return undefined;
    return coordinatorText(message.author, message.text, sourceText);
  };
  const preview = () => {
    const text = wait()?.detail || (lastMessageText() ?? (previewPending() ? "" : t("sidebar.channel.noMessages")));
    return working() > 0 ? t("sidebar.channel.workingPreview", { preview: text }) : text;
  };
  const labelPreview = () => (wait()?.detail && working() === 0 ? "" : `. ${preview()}`);
  const row = (): JSX.Element => (
    <ContextMenu.Root modal={false} onOpenChange={setMenuOpen}>
      <ContextMenu.Trigger
        as="button"
        type="button"
        class={[
          buttonVariants({ variant: "ghost" }),
          "agent-row channel-row",
          {
            "agent-row-active": active(),
            "sidebar-agent-row-dragging": draggedChatId() === rowProps.channel.id,
            "agent-row-file-drop-target": fileDrop.active(),
          },
        ]}
        aria-label={`${rowProps.channel.name}${title() ? `, ${title()}` : ""}${labelPreview()}${waitLabel()}`}
        aria-pressed={active() ? "true" : "false"}
        data-cuelume-navigate=""
        onClick={(event: MouseEvent) => {
          if (!sidebarClickIsSuppressed(event)) props.onSelectChannel?.(rowProps.channel.id);
        }}
      >
        <span class="agent-row-avatar">
          <ChannelAvatar
            members={rowProps.channel.members}
            agents={props.agents}
            layout="cluster"
            icon={rowProps.channel.icon}
            imageUrl={rowProps.channel.imageUrl}
          />
          <SidebarAgentIndicator state={badgeState} />
        </span>
        <span class="agent-row-copy">
          <span class="agent-row-heading">
            <span class="agent-row-title">
              <strong dir="auto">{rowProps.channel.name}</strong>
              <Show when={title()}>
                {(label) => (
                  <Badge class="agent-role-badge" title={label()}>
                    <span dir="auto">{label()}</span>
                  </Badge>
                )}
              </Show>
            </span>
            <Show
              when={wait()}
              fallback={
                <Show when={working() > 0} fallback={<span class="agent-row-time">{time()}</span>}>
                  <Badge class="channel-row-working">
                    <span class="live-work-pulse" aria-hidden="true" />
                    {t("chat.liveWork.title", { count: working() })}
                  </Badge>
                </Show>
              }
            >
              {(current) => <SidebarWaitChip reason={current().reason} />}
            </Show>
          </span>
          <span class="agent-row-preview" dir="auto">
            {preview()}
          </span>
        </span>
        <Show when={rowProps.channel.unreadCount > 0}>
          <span class="sr-only">{t("sidebar.channel.unread", { count: rowProps.channel.unreadCount })}</span>
        </Show>
      </ContextMenu.Trigger>
      <Show
        when={!rowProps.channel.archived}
        fallback={
          <Show when={props.onRestoreChannel}>
            <SidebarDeletedChannelContextMenu channel={rowProps.channel} />
          </Show>
        }
      >
        <SidebarChannelContextMenu channel={rowProps.channel} pinned={false} />
      </Show>
    </ContextMenu.Root>
  );
  return (
    /* biome-ignore lint/a11y/noStaticElementInteractions: Native drag belongs to the wrapper around the accessible button. */
    <div
      class={[
        "sidebar-agent-item",
        {
          "sidebar-agent-item-dragging": draggedChatId() === rowProps.channel.id,
          "sidebar-drag-shifting": dragOffset(rowProps.channel.id).y !== 0,
        },
      ]}
      style={`--sidebar-drag-y: ${dragOffset(rowProps.channel.id).y}px;`}
      data-chat-id={rowProps.waiting ? undefined : rowProps.channel.id}
      draggable={draggable() ? "true" : "false"}
      onDragStart={(event: DragEvent & { currentTarget: HTMLElement }) => startChatDragging(event, rowProps.channel.id)}
      onDragEnd={endChatDragging}
      data-openbot-file-drop={fileDrop.enabled() ? "" : undefined}
      onDragOver={fileDrop.onDragOver}
      onDragLeave={fileDrop.onDragLeave}
      onDrop={fileDrop.onDrop}
    >
      <Show
        when={wait()}
        fallback={
          <SidebarNameTooltip
            name={rowProps.channel.name}
            title={title()}
            preview={preview()}
            detail={stateLabel()}
            menuOpen={menuOpen()}
          >
            {row()}
          </SidebarNameTooltip>
        }
      >
        {(current) => (
          <SidebarWaitTooltip
            wait={current()}
            menuOpen={menuOpen()}
            name={props.compact ? rowProps.channel.name : undefined}
          >
            {row()}
          </SidebarWaitTooltip>
        )}
      </Show>
    </div>
  );
}
