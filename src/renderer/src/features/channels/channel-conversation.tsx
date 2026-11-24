import { channelThreads } from "@openbot/contracts/fork-channel-threads";
import {
  type AgentApproval,
  type AgentEvent,
  type BrowserTakeoverRequest,
  type CentralAuthUser,
  channelBrowserAgent,
} from "@openbot/contracts/ipc";
import type { AgentMessage } from "@openbot/ui/data";
import { unloadedHistory } from "@openbot/ui/features/conversation/ChatScrollRail";
import { useText } from "@openbot/ui/text";
import { createEffect, createMemo, createSignal, Show } from "solid-js";
import { actionToast } from "../../action-toast";
import { agentMessagesEqual } from "../../app-message-projection";
import { channelAwaitingReplies } from "../../awaiting-replies";
import type {
  AgentSettingsRequest,
  ConversationChannelSource,
  PromptAnswerOptions,
  SendMessageResult,
} from "../conversation/conversation-types";
import { readerCanDeleteMessage } from "../conversation/message-delete-access";
import {
  ChannelAboveComposer,
  ChannelEmptyState,
  ChannelHeaderTitle,
  type ChannelRoutineHost,
  ChannelSettingsPane,
} from "./ChannelConversationParts";
import { type ChannelFeedModel, ChannelFeedToggle, ChannelFeedView } from "./ChannelFeedView";
import {
  activeChannelRuns,
  channelApproval,
  channelBrowserTakeover,
  channelConversationRows,
  channelMessageHasContent,
  channelWorkers,
  channelWorkingTurns,
  firstUnreadChannelMessageId,
  liveChannelPrompt,
  sentChannelMessageId,
  waitingChannelPrompt,
} from "./channel-conversation-rows";
import {
  channelFeedChosen,
  channelSendCommand,
  feedThreadToOpen,
  feedWindowWide,
  setChannelFeedChosen,
} from "./channel-feed";
import { useChannels } from "./channels-context";

export interface ChannelConversationEnvironment {
  channelId: string;
  isOwnSender: (senderId: string) => boolean;
  connectionReady: () => boolean;
  routines: ChannelRoutineHost;
  approvals: () => readonly AgentApproval[];
  takeovers: () => readonly BrowserTakeoverRequest[];
  prompts: () => readonly Extract<AgentEvent, { type: "prompt" }>[];
  pausedAgentIds: () => ReadonlySet<string>;
  feed?: { account: () => CentralAuthUser } | undefined;
}

export function createChannelConversation(env: ChannelConversationEnvironment) {
  const channels = useChannels();
  const { t, errorDetails, errorMessage, sourceText } = useText();
  const channelId = env.channelId;
  const page = () => {
    const current = channels.state.page;
    return current?.channel.id === channelId ? current : null;
  };
  const summary = () => channels.state.channels.find((channel) => channel.id === channelId);
  const threads = () => summary()?.threads;
  const readOnly = () => page()?.channel.archived === true;
  const memberThreadIds = createMemo(() => new Set(threads()?.map((thread) => thread.threadId)));
  const memberAgentIds = createMemo(() => new Set(page()?.channel.members.map((member) => member.agentId)));
  const browserOwner = createMemo(() => {
    const channel = page()?.channel;
    const allowed = channel ? channelBrowserAgent(channel) : false;
    if (!channel || allowed === false) return null;
    const paused = env.pausedAgentIds();
    const owners = channel.members.flatMap((member) => {
      const threadId = threads()?.find((thread) => thread.agentId === member.agentId)?.threadId;
      return threadId && !paused.has(member.agentId) ? [{ agentId: member.agentId, threadId }] : [];
    });
    if (typeof allowed === "string") return owners.find((owner) => owner.agentId === allowed) ?? null;
    return owners.find((owner) => owner.agentId === channel.leadAgentId) ?? owners[0] ?? null;
  });
  const agentName = (agentId: string | null | undefined) => {
    const agent = channels.agents().find((candidate) => candidate.id === agentId);
    const authored = page()?.messages.find((entry) => entry.author.id === agentId);
    return agent?.name ?? authored?.author.name ?? t("chat.message.agentFallback");
  };

  const entries = createMemo(() => page()?.messages.filter(channelMessageHasContent) ?? []);
  const feedThreads = createMemo(() => {
    const current = page();
    return current ? channelThreads(current.messages, current.tasks) : null;
  });
  const feedShown = () => env.feed !== undefined && feedWindowWide() && channelFeedChosen(channelId);
  const [openRoot, setOpenRoot] = createSignal<string | null>(null);
  const [panelFocus, setPanelFocus] = createSignal(0);
  const [chatFocus, setChatFocus] = createSignal<{ agentId: string; messageId: string; nonce: number } | null>(null);
  const openThread = (rootId: string, focus: boolean) => {
    setOpenRoot(rootId);
    if (focus) setPanelFocus((current) => current + 1);
  };
  createEffect(feedShown, (shown) => {
    if (!shown) setOpenRoot(null);
  });

  let rowsById = new Map<string, AgentMessage>();
  let drawn = false;
  const ownRow = (row: AgentMessage) =>
    row.author === "you" && row.senderMember !== undefined && env.isOwnSender(row.senderMember.id);
  const messages = createMemo((): AgentMessage[] => {
    const current = page();
    if (!current) return [];
    const next = new Map<string, AgentMessage>();
    const mappedRows = channelConversationRows(entries(), current.tasks, sourceText);
    const lastKnown = mappedRows.findLastIndex((mapped) => rowsById.has(mapped.id));
    const rows = mappedRows.map((mapped, index) => {
      const known = rowsById.get(mapped.id);
      const live = known ? known.animate === true : drawn && index > lastKnown && !ownRow(mapped);
      const fresh = live ? { ...mapped, animate: true } : mapped;
      const row = known && agentMessagesEqual(known, fresh) ? known : fresh;
      next.set(row.id, row);
      return row;
    });
    rowsById = next;
    drawn = true;
    return rows;
  });
  const unreadCount = () => summary()?.unreadCount ?? 0;
  const stoppedTurns = new Set<string>();
  const workingTurns = createMemo(() => {
    const current = page();
    return current ? channelWorkingTurns(current, stoppedTurns) : [];
  });

  const waiting = createMemo(() => {
    const current = page();
    return current ? waitingChannelPrompt(current, threads(), env.prompts()) : null;
  });
  const prompt = createMemo((): Extract<AgentEvent, { type: "prompt" }> | undefined => {
    const found = waiting();
    if (!found) {
      const current = page();
      return current ? liveChannelPrompt(current, threads(), env.prompts()) : undefined;
    }
    const agentId = found.entry.author.id;
    return {
      type: "prompt",
      requestId: found.prompt.requestId,
      agentId,
      threadId: threads()?.find((thread) => thread.agentId === agentId)?.threadId ?? "",
      turnId: found.entry.message.turnId ?? "",
      questions: found.prompt.questions,
    };
  });
  const approval = createMemo(() => {
    const current = page();
    return current ? channelApproval(current, threads(), env.approvals()) : undefined;
  });
  const browserTakeover = createMemo(() => {
    const current = page();
    return current ? channelBrowserTakeover(current, threads(), env.takeovers()) : undefined;
  });
  const activeRuns = createMemo(() => {
    const current = page();
    return current ? activeChannelRuns(current) : [];
  });

  let settingsNonce = 0;
  const settingsRequest = createMemo<AgentSettingsRequest | null>((previous) => {
    if (channels.state.editing !== "settings" || channels.state.selectedId !== channelId) return previous ?? null;
    settingsNonce += 1;
    return { agentId: channelId, nonce: settingsNonce };
  });
  createEffect(
    () => channels.state.editing === "settings" && channels.state.selectedId === channelId,
    (requested) => {
      if (requested) channels.closeEditor();
    },
  );

  async function sendMessage(
    body: string,
    attachmentDraftIds: string[],
    replyToMessageId: string | null,
    _target?: unknown,
    clientMessageId?: string,
  ): Promise<SendMessageResult> {
    if (!env.connectionReady() || readOnly()) return { error: t("channel.error.action") };
    const sequenceBefore = page()?.throughSequence ?? 0;
    const startsThread = feedShown();
    try {
      const after = await channels.send(
        channelSendCommand({
          channelId,
          text: body,
          operationId: clientMessageId ?? crypto.randomUUID(),
          replyToMessageId,
          attachmentDraftIds,
        }),
      );
      const messageId = sentChannelMessageId(after, sequenceBefore, body, env.isOwnSender);
      if (messageId && startsThread && feedShown())
        openThread(feedThreadToOpen(messageId, feedThreads()?.rootOf), false);
      return messageId ? { messageId } : { error: t("channel.error.action") };
    } catch (error) {
      const details = errorDetails(error, t("channel.error.action"));
      return { error: details.message, reference: details.reference };
    }
  }

  async function sendThreadReply(rootId: string, text: string): Promise<boolean> {
    if (!env.connectionReady() || readOnly()) return false;
    try {
      await channels.send(
        channelSendCommand({
          channelId,
          text,
          operationId: crypto.randomUUID(),
          replyToMessageId: rootId,
          attachmentDraftIds: [],
        }),
      );
      return true;
    } catch (error) {
      actionToast.error(errorMessage(error, t("channel.error.action")), {
        report: { operation: "other", source: "action", cause_code: "unknown" },
      });
      return false;
    }
  }

  async function respond(action: () => Promise<void>, options?: PromptAnswerOptions): Promise<boolean> {
    if (!env.connectionReady() || readOnly()) return false;
    let failed = false;
    const done = await channels.perform(async () => {
      try {
        await action();
      } catch (error) {
        if (!options?.onError) throw error;
        failed = true;
        options.onError(error);
      }
    });
    return done && !failed;
  }

  let rowStopping = false;
  async function stopWork() {
    if (!env.connectionReady()) return;
    for (const taskId of activeRuns()) {
      const stopped = await channels.command({
        type: "stop",
        operationId: crypto.randomUUID(),
        channelId,
        taskId,
        recipientAgentId: null,
      });
      if (!stopped) return;
    }
  }

  const feedEnvironment = env.feed;
  const source: ConversationChannelSource = {
    id: channelId,
    name: () => page()?.channel.name ?? summary()?.name ?? "",
    readOnly,
    ownMessage: ownRow,
    author: (message) => {
      const id = message.senderAgentId ?? "";
      return {
        kind: "agent",
        name: agentName(id),
        agent: channels.agents().find((candidate) => candidate.id === id),
        avatarSeed: id,
      };
    },
    workers: () => {
      const current = page();
      return current
        ? channelWorkers(current, channels.agents(), t("chat.activity.agentFallback"), env.pausedAgentIds())
        : [];
    },
    memberThreadIds,
    memberAgentIds,
    browserOwner,
    workingTurns,
    interactionAgentName: () => {
      const agentId = approval()?.agentId ?? browserTakeover()?.agentId ?? prompt()?.agentId;
      return agentId ? agentName(agentId) : undefined;
    },
    awaitingReplies: () => {
      const current = page();
      if (!current || current.channel.archived) return [];
      return channelAwaitingReplies({
        tasks: current.tasks,
        agents: channels.agents(),
        name: (id) => (id ? agentName(id) : t("sidebar.section.unassigned")),
      });
    },
    stopAwaitingReply: (taskId) => {
      if (rowStopping || !env.connectionReady() || readOnly()) return;
      rowStopping = true;
      void channels
        .command({ type: "stop", operationId: crypto.randomUUID(), channelId, taskId, recipientAgentId: null })
        .finally(() => {
          rowStopping = false;
        });
    },
    HeaderTitle: (props) => (
      <>
        <ChannelHeaderTitle channelId={channelId} onOpenSettings={props.onOpenSettings} />
        <Show when={env.feed && feedWindowWide()}>
          <ChannelFeedToggle
            feed={channelFeedChosen(channelId)}
            onChange={(feed) => setChannelFeedChosen(channelId, feed)}
          />
        </Show>
      </>
    ),
    SettingsPane: (props) => (
      <ChannelSettingsPane
        channelId={channelId}
        routines={env.routines}
        maxWidth={props.maxWidth}
        onWidthChange={props.onWidthChange}
        onClose={props.onClose}
      />
    ),
    AboveComposer: () => <ChannelAboveComposer channelId={channelId} />,
    EmptyState: () => <ChannelEmptyState channelId={channelId} />,
    feed: feedEnvironment
      ? {
          shown: feedShown,
          composerPlaceholder: () => t("channel.feed.startThread", { name: source.name() }),
          View: () => <ChannelFeedView model={feedModel(feedEnvironment)} />,
        }
      : undefined,
  };
  function feedModel(feed: NonNullable<ChannelConversationEnvironment["feed"]>): ChannelFeedModel {
    return {
      channelId,
      name: () => source.name(),
      readOnly,
      threads: feedThreads,
      rows: messages,
      openRoot,
      open: openThread,
      close: () => setOpenRoot(null),
      panelFocus,
      sendReply: sendThreadReply,
      mentionAgents: () => {
        const members = memberAgentIds();
        return channels.agents().filter((agent) => members.has(agent.id));
      },
      account: feed.account,
      showInChat: (rootId) => {
        setOpenRoot(null);
        setChannelFeedChosen(channelId, false);
        setChatFocus({ agentId: channelId, messageId: rootId, nonce: Date.now() });
      },
      hasOlder: () => Boolean(page()?.olderCursor),
      loadOlder: () => void channels.loadOlder(),
    };
  }

  const deleteMessage = (messageId: string) => channels.deleteMessage(channelId, messageId);
  const canDeleteMessage = (message: AgentMessage) =>
    !readOnly() &&
    readerCanDeleteMessage(message, { deleteAny: channels.deletesAnyMessage(), isOwnSender: env.isOwnSender });

  return {
    source,
    loaded: () => page() !== null,
    messages,
    unreadCount,
    firstUnreadMessageId: () => firstUnreadChannelMessageId(entries(), unreadCount(), env.isOwnSender),
    hasOlder: () => Boolean(page()?.olderCursor),
    unloadedHistory: () => unloadedHistory(page()),
    mentionAgents: () => {
      const members = memberAgentIds();
      return channels.agents().filter((agent) => members.has(agent.id));
    },
    activeTurnId: () => activeRuns()[0] ?? null,
    prompt,
    promptUiBlock: () => waiting()?.entry.message.uiBlock,
    approval,
    browserTakeover,
    settingsRequest,
    chatFocus,
    onSendMessage: sendMessage,
    onMarkRead: async () => {
      const current = page();
      if (!current || !env.connectionReady()) return;
      await channels.command({
        type: "read",
        channelId,
        throughSequence: current.throughSequence,
        operationId: crypto.randomUUID(),
      });
    },
    onLoadOlder: () => void channels.loadOlder(),
    onAnswerPrompt: (answers: Record<string, string[]>, options?: PromptAnswerOptions) => {
      const requestId = prompt()?.requestId;
      if (requestId === undefined) return Promise.resolve(false);
      return respond(() => channels.port().agent.respondToPrompt({ requestId, answers }), options);
    },
    onRespondToApproval: (decision: "accept" | "decline") => {
      const requestId = approval()?.requestId;
      if (requestId === undefined) return Promise.resolve(false);
      return respond(() => channels.port().agent.respondToApproval({ requestId, decision }));
    },
    onRespondToBrowserTakeover: (decision: "complete" | "cancel") => {
      const requestId = browserTakeover()?.requestId;
      if (requestId === undefined) return Promise.resolve(false);
      return respond(() => channels.port().agent.respondToBrowserTakeover({ requestId, decision }));
    },
    onStop: () => void stopWork(),
    deleteMessageAction: () => (channels.messageDeletionSupported() ? deleteMessage : undefined),
    canDeleteMessage,
  };
}
