import {
  type ChannelThreadSummary,
  type ChannelThreads,
  channelThreadEntryIds,
} from "@openbot/contracts/fork-channel-threads";
import type { CentralAuthUser, ChannelMessage } from "@openbot/contracts/ipc";
import { markdownPreviewText } from "@openbot/contracts/markdown-preview-text";
import { Button, buttonVariants, DropdownMenu, Ellipsis, IconButton, MessageSquareReply, toast, X } from "@openbot/ui";
import { PanelResizer } from "@openbot/ui/components/PanelResizer";
import type { AgentMessage, AgentProfile } from "@openbot/ui/data";
import { AgentAvatar } from "@openbot/ui/features/agents/AgentAvatar";
import { ChannelActivityIndicator } from "@openbot/ui/features/channels/ChannelActivityIndicator";
import { ChatActionMarker } from "@openbot/ui/features/conversation/ChatActionMarker";
import { type ChatMessageAuthor, ChatMessageRow } from "@openbot/ui/features/conversation/ChatMessageRow";
import { ComposerEditor } from "@openbot/ui/features/conversation/ComposerEditor";
import { ComposerSendControl } from "@openbot/ui/features/conversation/ComposerSendControl";
import { ApprovalCard } from "@openbot/ui/features/conversation/ConversationPrompts";
import { ownMessageAuthor } from "@openbot/ui/features/conversation/own-bubble";
import { RichMessageText } from "@openbot/ui/features/conversation/RichMessageText";
import { TeamPersonAvatar, teamMemberName } from "@openbot/ui/features/team/TeamPersonAvatar";
import { useText } from "@openbot/ui/text";
import { UserAvatar } from "@openbot/ui/user-avatar";
import { createEffect, createMemo, createSignal, For, onCleanup, onSettled, Show, untrack } from "solid-js";
import { useShowAgentSteps } from "../../agent-steps-preference";
import { deviceSendShortcut } from "../../send-shortcut-preference";
import { ConversationBrowserTakeover } from "../conversation/ConversationBrowserTakeover";
import { ConversationQuestionPrompt } from "../conversation/ConversationQuestionPrompt";
import { useConversationViewScope } from "../conversation/conversation-scope";
import {
  escClosesThread,
  FEED_MIN,
  feedRelativeTime,
  readThreadPanelWidth,
  resetThreadPanelWidth,
  saveThreadDraft,
  saveThreadPanelWidth,
  THREAD_PANEL_DEFAULT,
  THREAD_PANEL_MIN,
  threadDraft,
  threadPanelMaxWidth,
} from "./channel-feed";

export interface ChannelFeedModel {
  channelId: string;
  name: () => string;
  readOnly: () => boolean;
  threads: () => ChannelThreads | null;
  rows: () => readonly AgentMessage[];
  openRoot: () => string | null;
  open: (rootId: string, focus: boolean) => void;
  close: () => void;
  panelFocus: () => number;
  sendReply: (rootId: string, text: string) => Promise<boolean>;
  mentionAgents: () => AgentProfile[];
  account: () => CentralAuthUser;
  showInChat: (rootId: string) => void;
  hasOlder: () => boolean;
  loadOlder: () => void;
}

const FOOT_PX = 48;
const OLDER_PX = 240;
const OLDER_WAIT_MS = 3_000;
const INTENT_MS = 1_000;
const LONG_CHARS = 280;
const LONG_LINES = 4;
const CLOCK_MS = 30_000;

const [clock, setClock] = createSignal(Date.now());
let clockUsers = 0;
let clockTimer: number | undefined;

function useFeedClock(): () => number {
  clockUsers += 1;
  if (clockTimer === undefined) clockTimer = window.setInterval(() => setClock(Date.now()), CLOCK_MS);
  onCleanup(() => {
    clockUsers -= 1;
    if (clockUsers === 0 && clockTimer !== undefined) {
      window.clearInterval(clockTimer);
      clockTimer = undefined;
    }
  });
  return clock;
}

function shownInPanel(row: AgentMessage): boolean {
  if (row.kind === "thinking" || row.kind === "memory-changes" || row.itemType === "subagents") return false;
  return (
    row.author === "you" ||
    row.streaming === true ||
    row.body.trim().length > 0 ||
    (row.attachments?.length ?? 0) > 0 ||
    row.questionPrompt !== undefined ||
    row.plan !== undefined ||
    row.actionMarker !== undefined
  );
}

function useFeedAuthors() {
  const { props: view } = useConversationViewScope();
  const { t } = useText();
  const agent = (id: string) => view.agents.find((candidate) => candidate.id === id);
  const member = (id: string) => view.presence.members.find((candidate) => candidate.id === id);
  const own = (author: ChannelMessage["author"]) => author.kind === "member" && view.isOwnSender(author.id);
  const name = (author: ChannelMessage["author"]) => {
    if (own(author)) return t("chat.message.you");
    if (author.kind === "agent") return agent(author.id)?.name ?? author.name;
    const found = member(author.id);
    return (found ? teamMemberName(found) : author.name.trim()) || t("chat.message.memberFallback");
  };
  return { agent, member, own, name };
}

function FeedFace(props: { author: ChannelMessage["author"]; account: CentralAuthUser; small?: boolean }) {
  const authors = useFeedAuthors();
  const size = () => (props.small ? "channel-feed-face channel-feed-face-small" : "channel-feed-face");
  return (
    <Show
      when={props.author.kind === "agent"}
      fallback={
        <Show
          when={authors.own(props.author)}
          fallback={
            <Show
              when={authors.member(props.author.id)}
              fallback={
                <span class={size()} aria-hidden="true">
                  <AgentAvatar seed={props.author.id} motion="idle" />
                </span>
              }
            >
              {(member) => (
                <span class={size()}>
                  <TeamPersonAvatar member={member()} />
                </span>
              )}
            </Show>
          }
        >
          <UserAvatar user={props.account} class={`${size()} channel-feed-face-user`} decorative />
        </Show>
      }
    >
      <span class={size()} aria-hidden="true">
        <AgentAvatar agent={authors.agent(props.author.id)} seed={props.author.id} motion="idle" />
      </span>
    </Show>
  );
}

function FeedRow(props: {
  root: ChannelMessage;
  row: AgentMessage | undefined;
  summary: ChannelThreadSummary | undefined;
  open: boolean;
  account: CentralAuthUser;
  onOpen: (focus: boolean) => void;
  setButton: (element: HTMLButtonElement) => void;
}) {
  const { t, format, locale } = useText();
  const { props: view, openExternalMessageUrl } = useConversationViewScope();
  const authors = useFeedAuthors();
  const now = useFeedClock();
  const source = () => props.row?.body ?? props.root.message.text;
  const body = () => (props.root.author.kind === "agent" ? markdownPreviewText(source()) : source());
  const attachmentOnly = () => !body().trim();
  const long = () => body().length > LONG_CHARS || body().split("\n").length > LONG_LINES;
  const author = () => authors.name(props.root.author);
  const at = () => props.root.message.createdAt;
  const time = () => {
    const date = new Date(at());
    const today = new Date(now()).toDateString() === date.toDateString();
    return format.date(
      date,
      today
        ? { hour: "numeric", minute: "2-digit" }
        : { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" },
    );
  };
  const replies = () => props.summary?.replies ?? 0;
  const repliesText = () =>
    replies() > 0 ? t("channel.feed.replies", { count: replies() }) : t("channel.feed.noReplies");
  const lastReply = () => {
    const last = props.summary?.lastReplyAt;
    return last ? feedRelativeTime(last, now(), locale(), t("channel.feed.justNow")) : "";
  };
  const label = () =>
    t("channel.feed.rowLabel", {
      author: author(),
      text: attachmentOnly() ? t("channel.feed.attachment") : markdownPreviewText(body()).slice(0, LONG_CHARS),
      replies: repliesText(),
    });
  return (
    <li class={["channel-feed-row", { "channel-feed-row-open": props.open }]} data-feed-root={props.root.id}>
      <Button
        ref={props.setButton}
        variant="ghost"
        type="button"
        class="channel-feed-row-hit"
        aria-label={label()}
        aria-current={props.open ? "true" : undefined}
        onClick={() => props.onOpen(true)}
      />
      <FeedFace author={props.root.author} account={props.account} />
      <div class="channel-feed-row-body" inert>
        <div class="channel-feed-row-head">
          <span class={["channel-feed-row-name", { "channel-feed-row-agent": props.root.author.kind === "agent" }]}>
            {author()}
          </span>
          <time class="channel-feed-row-time" datetime={at()} title={new Date(at()).toLocaleString()}>
            {time()}
          </time>
        </div>
        <Show
          when={!attachmentOnly()}
          fallback={<p class="channel-feed-row-text channel-feed-row-attachment">{t("channel.feed.attachment")}</p>}
        >
          <div class={["channel-feed-row-text", { "channel-feed-row-long": long() }]}>
            <RichMessageText
              body={body()}
              agents={view.agents}
              attachments={props.row?.attachments}
              onSelectAgent={() => undefined}
              onOpenLink={(url) => void openExternalMessageUrl(url)}
            />
          </div>
        </Show>
        <Show when={replies() > 0 && props.summary}>
          {(summary) => (
            <div class="channel-feed-row-summary">
              <span class="channel-feed-repliers" aria-hidden="true">
                <For each={summary().repliers} keyed={(replier) => `${replier.kind}:${replier.id}`}>
                  {(replier) => <FeedFace author={replier()} account={props.account} small />}
                </For>
              </span>
              <span class="channel-feed-row-count">{repliesText()}</span>
              <span class="channel-feed-row-last">{t("channel.feed.lastReply", { time: lastReply() })}</span>
            </div>
          )}
        </Show>
      </div>
      <IconButton
        variant="ghost"
        size="icon-xs"
        type="button"
        class="channel-feed-row-reply"
        label={t("channel.feed.replyInThread")}
        tabindex={-1}
        onClick={() => props.onOpen(true)}
      >
        <MessageSquareReply aria-hidden="true" />
      </IconButton>
    </li>
  );
}

export function ChannelFeedView(props: { model: ChannelFeedModel }) {
  const { t } = useText();
  const scope = useConversationViewScope();
  const { props: view, channel, registerPromptComposerAnswer, setRequiredInteractionElement } = scope;
  const showAgentSteps = useShowAgentSteps();
  const rowsById = createMemo(() => new Map(props.model.rows().map((row) => [row.id, row] as const)));
  const roots = () => props.model.threads()?.roots ?? [];
  const rowButtons = new Map<string, HTMLButtonElement>();
  let scroller: HTMLElement | undefined;
  let list: HTMLElement | undefined;
  let atFoot = true;
  let intentAt = 0;
  let olderAnchor: number | null = null;
  const loadOlder = () => {
    if (scroller && !atFoot) {
      const anchor = scroller.scrollHeight - scroller.scrollTop;
      olderAnchor = anchor;
      window.setTimeout(() => {
        if (olderAnchor === anchor) olderAnchor = null;
      }, OLDER_WAIT_MS);
    }
    props.model.loadOlder();
  };
  const intent = () => {
    intentAt = Date.now();
  };
  const toFoot = () => {
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  };
  onSettled(() => {
    const element = scroller;
    if (!element) return;
    const keep = new ResizeObserver(() => {
      if (atFoot) toFoot();
    });
    keep.observe(element);
    if (list) keep.observe(list);
    toFoot();
    return () => keep.disconnect();
  });
  const onScroll = () => {
    const element = scroller;
    if (!element) return;
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    if (distance <= FOOT_PX) atFoot = true;
    else if (Date.now() - intentAt < INTENT_MS) atFoot = false;
    if (!atFoot && element.scrollTop < OLDER_PX && olderAnchor === null && props.model.hasOlder()) loadOlder();
  };
  createEffect(
    () => roots().length,
    () => {
      const anchor = olderAnchor;
      olderAnchor = null;
      if (atFoot) requestAnimationFrame(toFoot);
      else if (anchor !== null && scroller) scroller.scrollTop = scroller.scrollHeight - anchor;
    },
  );
  const focusRow = (rootId: string, attempt = 0) => {
    const button = rowButtons.get(rootId);
    if (!button?.isConnected) return;
    button.focus({ preventScroll: false });
    if (document.activeElement !== button && attempt < 5) window.setTimeout(() => focusRow(rootId, attempt + 1), 16);
    else if (attempt === 0) window.setTimeout(() => focusRow(rootId, 1), 50);
  };
  return (
    <>
      <section
        ref={(element: HTMLElement) => {
          scroller = element;
        }}
        class="conversation-scroll channel-feed"
        aria-label={t("channel.feed.listLabel", { name: props.model.name() })}
        onScroll={onScroll}
        onWheel={intent}
        onTouchMove={intent}
        onPointerDown={intent}
        onKeyDown={intent}
      >
        <div
          class="channel-feed-column"
          ref={(element: HTMLDivElement) => {
            list = element;
          }}
        >
          <Show when={props.model.hasOlder()}>
            <div class="conversation-history-status">
              <Button type="button" variant="ghost" size="xs" onClick={loadOlder}>
                {t("channel.feed.loadOlder")}
              </Button>
            </div>
          </Show>
          <Show
            when={roots().length > 0}
            fallback={
              <Show when={props.model.threads()}>
                <p class="channel-feed-empty">{t("channel.feed.empty")}</p>
              </Show>
            }
          >
            <ol class="channel-feed-list" aria-label={t("channel.feed.listLabel", { name: props.model.name() })}>
              <For each={roots()} keyed={(root) => root.id}>
                {(root) => (
                  <FeedRow
                    root={root()}
                    row={rowsById().get(root().id)}
                    summary={props.model.threads()?.summaries.get(root().id)}
                    open={props.model.openRoot() === root().id}
                    account={props.model.account()}
                    onOpen={(focus) => props.model.open(root().id, focus)}
                    setButton={(element) => rowButtons.set(root().id, element)}
                  />
                )}
              </For>
            </ol>
          </Show>
          <div class="channel-feed-live">
            <div class="question-prompt-with-author">
              <ConversationQuestionPrompt
                elementRef={setRequiredInteractionElement}
                registerComposerAnswer={registerPromptComposerAnswer}
              />
            </div>
            <Show keyed when={view.approval}>
              {(approval) => (
                <ApprovalCard
                  approval={approval}
                  agentName={channel?.interactionAgentName()}
                  onApprove={() => view.onRespondToApproval("accept")}
                  onReject={() => view.onRespondToApproval("decline")}
                />
              )}
            </Show>
            <ConversationBrowserTakeover />
            <Show when={channel && channel.workers().length > 0 ? channel.workers() : undefined}>
              {(workers) => (
                <div class="agent-activity-slot" data-reserved="true">
                  <ChannelActivityIndicator workers={workers()} stepsOpenByDefault={showAgentSteps()} />
                </div>
              )}
            </Show>
          </div>
        </div>
      </section>
      <Show when={props.model.openRoot()} keyed>
        {(rootId) => (
          <ChannelThreadPanel
            model={props.model}
            rootId={rootId}
            onClosed={() => requestAnimationFrame(() => focusRow(rootId))}
          />
        )}
      </Show>
    </>
  );
}

function ChannelThreadPanel(props: { model: ChannelFeedModel; rootId: string; onClosed: () => void }) {
  const { t } = useText();
  const scope = useConversationViewScope();
  const {
    props: view,
    channel,
    conversationPanelElement,
    setActiveRightPanel,
    sidePanelOpen,
    openExternalMessageUrl,
    previewAttachment,
    attachmentAction,
    attachmentDownloads,
    openSharedFile,
    openWorkspaceFile,
    installedSkills,
    openTaggedReference,
  } = scope;
  const ids = createMemo(() => {
    const threads = props.model.threads();
    return threads ? channelThreadEntryIds(props.rootId, threads.rootOf) : new Set<string>();
  });
  const rows = createMemo(() => props.model.rows().filter((row) => ids().has(row.id) && shownInPanel(row)));
  const rootRow = () => rows().find((row) => row.id === props.rootId);
  const [width, setWidth] = createSignal(readThreadPanelWidth());
  const [available, setAvailable] = createSignal(0);
  const beside = () => available() >= THREAD_PANEL_MIN + FEED_MIN;
  const shownWidth = () =>
    beside()
      ? Math.round(Math.min(Math.max(width(), THREAD_PANEL_MIN), threadPanelMaxWidth(available())))
      : available();
  onSettled(() => {
    const panel = conversationPanelElement();
    if (!panel) return;
    const measure = () => setAvailable(panel.clientWidth);
    const observer = new ResizeObserver(measure);
    observer.observe(panel);
    measure();
    return () => {
      observer.disconnect();
      panel.style.removeProperty("--channel-thread-width");
      delete panel.dataset.channelThread;
    };
  });
  createEffect(
    () => ({ panel: conversationPanelElement(), width: shownWidth(), beside: beside(), measured: available() > 0 }),
    ({ panel, width, beside, measured }) => {
      if (!panel || !measured) return;
      panel.style.setProperty("--channel-thread-width", `${width}px`);
      panel.dataset.channelThread = beside ? "beside" : "over";
    },
  );
  createEffect(sidePanelOpen, (open) => {
    if (open) props.model.close();
  });
  if (untrack(sidePanelOpen)) setActiveRightPanel("none");
  const close = () => {
    props.model.close();
    props.onClosed();
  };
  onSettled(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (!escClosesThread(event.target, menuMount ?? null)) return;
      event.preventDefault();
      close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });
  let messageList: HTMLDivElement | undefined;
  let scroller: HTMLElement | undefined;
  let atEnd = true;
  let panelIntentAt = 0;
  const panelIntent = () => {
    panelIntentAt = Date.now();
  };
  onSettled(() => {
    const element = scroller;
    if (!element || !messageList) return;
    const follow = new ResizeObserver(() => {
      if (atEnd) element.scrollTop = element.scrollHeight;
    });
    follow.observe(messageList);
    element.scrollTop = element.scrollHeight;
    const intents = ["wheel", "touchmove", "pointerdown", "keydown"] as const;
    for (const type of intents) element.addEventListener(type, panelIntent, { passive: true });
    return () => {
      follow.disconnect();
      for (const type of intents) element.removeEventListener(type, panelIntent);
    };
  });
  const onScroll = () => {
    const element = scroller;
    if (!element) return;
    if (element.scrollHeight - element.scrollTop - element.clientHeight < FOOT_PX) atEnd = true;
    else if (Date.now() - panelIntentAt < INTENT_MS) atEnd = false;
  };
  const [openHandoffs, setOpenHandoffs] = createSignal<ReadonlySet<string>>(new Set());
  const toggleHandoff = (messageId: string) =>
    setOpenHandoffs((current) => {
      const next = new Set(current);
      if (!next.delete(messageId)) next.add(messageId);
      return next;
    });
  const author = (row: AgentMessage): ChatMessageAuthor => {
    if (row.author === "you") {
      const sender = row.senderMember;
      if (sender && !view.isOwnSender(sender.id)) {
        const member = view.presence.members.find((candidate) => candidate.id === sender.id);
        return {
          kind: "member",
          name: (member ? teamMemberName(member) : sender.name.trim()) || t("chat.message.memberFallback"),
          avatarSeed: sender.id,
          chatColor: member?.chatColor,
        };
      }
      return ownMessageAuthor({
        name: t("chat.message.you"),
        style: "classic",
        agent: undefined,
        chatColor: view.currentUserChatColor ?? undefined,
      });
    }
    return (
      channel?.author(row) ?? { kind: "agent", name: t("chat.message.agentFallback"), avatarSeed: row.senderAgentId }
    );
  };
  const reference = (row: AgentMessage) => {
    const id = row.replyToMessageId;
    if (!id || id === props.rootId) return undefined;
    return rows().find((candidate) => candidate.id === id);
  };
  const handoffMarker = (row: AgentMessage) => {
    const marker = row.actionMarker;
    if (marker?.kind !== "agent-message") return marker;
    if (row.body.trim() === "") return marker;
    return { ...marker, expanded: openHandoffs().has(marker.messageId) };
  };
  const handoffText = (messageId: string) => {
    const row = () => rows().find((candidate) => candidate.exchange?.messageId === messageId);
    return (
      <Show when={row()}>
        {(current) => (
          <ChatMessageRow
            message={{
              id: current().id,
              author: "agent",
              body: current().body,
              time: current().time,
              ...(current().createdAt === undefined ? {} : { createdAt: current().createdAt }),
              kind: "text",
            }}
            author={author(current())}
            showAuthor
            showTime
            agents={view.agents}
            onSelectAgent={(agentId) => view.onSelectAgent(agentId)}
            onOpenLink={(url) => void openExternalMessageUrl(url)}
            onPreview={(attachment) => void previewAttachment(attachment)}
            onAttachmentAction={attachmentAction}
          />
        )}
      </Show>
    );
  };
  const workspaceAgent = (row: AgentMessage) => (row.author === "agent" ? row.senderAgentId : undefined);
  const copyRoot = async () => {
    const text = rootRow()?.body ?? "";
    try {
      await navigator.clipboard.writeText(text);
      toast.success(t("common.copied"));
    } catch {
      toast.error(t("app.clipboard.copyFailed"));
    }
  };
  let menuMount: HTMLElement | undefined;
  return (
    <aside
      id="channel-thread-panel"
      ref={(element: HTMLElement) => {
        menuMount = element;
      }}
      class="channel-thread-panel"
      aria-label={t("channel.thread.label", { name: props.model.name() })}
      data-thread-root={props.rootId}
    >
      <Show when={beside()}>
        <PanelResizer
          class="right-panel-resizer"
          label={t("channel.thread.resize")}
          controls="channel-thread-panel"
          direction="right"
          value={shownWidth()}
          defaultValue={THREAD_PANEL_DEFAULT}
          min={THREAD_PANEL_MIN}
          max={() => threadPanelMaxWidth(available())}
          onResize={setWidth}
          onResizeEnd={(value) => {
            setWidth(value);
            saveThreadPanelWidth(value);
          }}
          onReset={() => {
            resetThreadPanelWidth();
            setWidth(THREAD_PANEL_DEFAULT);
          }}
        />
      </Show>
      <header class="channel-thread-header">
        <h2 class="channel-thread-title">
          <span>{t("channel.thread.title")}</span>
          <span class="channel-thread-channel">{props.model.name()}</span>
        </h2>
        <DropdownMenu.Root placement="bottom-end" gutter={4} modal={false}>
          <DropdownMenu.Trigger
            class={`${buttonVariants({ variant: "ghost", size: "icon-sm" })} ui-icon-button no-drag`}
            aria-label={t("channel.thread.menu")}
          >
            <Ellipsis aria-hidden="true" />
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal mount={menuMount ?? document.body}>
            <DropdownMenu.Content>
              <DropdownMenu.Item onSelect={() => props.model.showInChat(props.rootId)}>
                {t("channel.thread.openInChat")}
              </DropdownMenu.Item>
              <DropdownMenu.Item onSelect={() => void copyRoot()}>{t("channel.thread.copyText")}</DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
        <IconButton variant="ghost" class="no-drag" label={t("channel.thread.close")} onClick={close}>
          <X aria-hidden="true" />
        </IconButton>
      </header>
      <section
        ref={(element: HTMLElement) => {
          scroller = element;
        }}
        class="conversation-scroll agent-thread-scroll channel-thread-scroll"
        onScroll={onScroll}
      >
        <div
          class="virtual-chat-list virtual-chat-list-static"
          ref={(element: HTMLDivElement) => {
            messageList = element;
          }}
        >
          <Show when={rootRow()} fallback={<p class="channel-feed-empty">{t("channel.thread.unavailable")}</p>}>
            <For each={rows()} keyed={(row) => row.id}>
              {(row) => (
                <div class="virtual-chat-row">
                  <Show
                    when={row().actionMarker && handoffMarker(row())}
                    fallback={
                      <ChatMessageRow
                        message={row()}
                        author={author(row())}
                        showAuthor
                        showTime
                        agents={view.agents}
                        skills={installedSkills()}
                        referencedMessage={reference(row())}
                        onSelectAgent={(agentId) => view.onSelectAgent(agentId)}
                        onOpenLink={(url) => void openExternalMessageUrl(url)}
                        onPreview={(attachment) => void previewAttachment(attachment)}
                        onAttachmentAction={attachmentAction}
                        onOpenSharedFile={(path) => openSharedFile(path)}
                        onOpenWorkspaceFile={(path) => openWorkspaceFile(path, undefined, workspaceAgent(row()))}
                        onOpenTag={openTaggedReference}
                        onDownload={(attachment) => attachmentAction(attachment, "download")}
                        mediaSource={view.runtime?.attachmentMedia}
                        downloads={attachmentDownloads}
                        actionTime
                        macWindowControls={view.platform === "darwin"}
                        data-chat-search-message={row().id}
                      />
                    }
                  >
                    {(marker) => (
                      <article data-chat-search-message={row().id}>
                        <ChatActionMarker
                          marker={marker()}
                          agents={view.agents}
                          onSelectAgent={(agentId, tabId) => view.onSelectAgent(agentId, tabId)}
                          onToggleAgentMessage={toggleHandoff}
                          agentMessageText={handoffText}
                        />
                      </article>
                    )}
                  </Show>
                </div>
              )}
            </For>
          </Show>
        </div>
      </section>
      <Show when={!props.model.readOnly()}>
        <ThreadComposer model={props.model} rootId={props.rootId} />
      </Show>
    </aside>
  );
}

function ThreadComposer(props: { model: ChannelFeedModel; rootId: string }) {
  const { t } = useText();
  const { props: view, installedSkills, openTaggedReference } = useConversationViewScope();
  const [draft, setDraft] = createSignal(threadDraft(props.model.channelId, props.rootId));
  const editDraft = (text: string) => {
    setDraft(text);
    saveThreadDraft(props.model.channelId, props.rootId, text);
  };
  const [sending, setSending] = createSignal(false);
  const empty = () => draft().trim().length === 0;
  const send = async () => {
    const text = draft().trim();
    if (!text || sending()) return;
    setSending(true);
    try {
      if (await props.model.sendReply(props.rootId, text)) editDraft("");
    } finally {
      setSending(false);
    }
  };
  const mentionAgents = () => props.model.mentionAgents();
  return (
    <div class="composer-wrap channel-thread-composer">
      <form
        class="composer agent-thread-composer"
        data-compact="true"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <div class="composer-input-label">
          <ComposerEditor
            agentId={undefined}
            agents={mentionAgents()}
            everyoneMention={mentionAgents().length > 1}
            skills={installedSkills()}
            mcpServers={[]}
            value={draft()}
            placeholder={t("channel.thread.placeholder")}
            ariaLabel={t("channel.thread.composerLabel")}
            focusRequest={props.model.panelFocus()}
            disabled={sending()}
            sendShortcut={deviceSendShortcut(view.platform)}
            onOpenTag={openTaggedReference}
            onValueChange={editDraft}
            onSubmit={() => void send()}
          />
        </div>
        <div class="composer-toolbar">
          <div class="composer-primary-actions">
            <ComposerSendControl
              stop={false}
              onStop={() => undefined}
              label={t("composer.send.message")}
              disabled={sending() || empty()}
              busy={sending()}
            />
          </div>
        </div>
      </form>
    </div>
  );
}

export function ChannelFeedToggle(props: { feed: boolean; onChange: (feed: boolean) => void }) {
  const { t } = useText();
  return (
    <fieldset class="channel-feed-toggle no-drag" aria-label={t("channel.feed.viewLabel")}>
      <Button
        variant="ghost"
        size="xs"
        type="button"
        class="channel-feed-toggle-option"
        aria-pressed={props.feed ? "true" : "false"}
        onClick={() => props.onChange(true)}
      >
        {t("channel.feed.feed")}
      </Button>
      <Button
        variant="ghost"
        size="xs"
        type="button"
        class="channel-feed-toggle-option"
        aria-pressed={props.feed ? "false" : "true"}
        onClick={() => props.onChange(false)}
      >
        {t("channel.feed.chat")}
      </Button>
    </fieldset>
  );
}
