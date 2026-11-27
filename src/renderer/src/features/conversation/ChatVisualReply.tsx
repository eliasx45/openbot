import { fileQuoteId } from "@openbot/contracts/chat-tag-references";
import { chatVisualReply } from "@openbot/contracts/chat-visual";
import type { AttachmentSummary } from "@openbot/contracts/ipc";
import type { AgentMessage } from "@openbot/ui/data";
import { ChatVisual } from "@openbot/ui/features/conversation/ChatVisual";
import { createSignal, onCleanup, untrack } from "solid-js";
import { deviceQuoteShortcut } from "../../send-shortcut-preference";
import {
  openSavedAppPage,
  pageStateHost,
  saveChatPageAsApp,
  savedApps,
  savedAppsPort,
  watchSavedApps,
} from "../saved-apps/fork-saved-apps-store";
import { isChatVisualAppShortcut } from "./chat-visual-shortcuts";
import { chatVisualPageUrl } from "./chat-visual-url";
import { conversationRuntime } from "./conversation-runtime";
import { useConversationViewScope } from "./conversation-scope";
import { useMessageBackdropAction } from "./message-backdrop";
import { draftWithPageContext, draftWithPageText } from "./stores/message-actions";

export interface ChatVisualPage {
  attachment: AttachmentSummary;
  height?: number;
}

export function shownVisualReply(
  message: AgentMessage,
  loadPage: ((attachment: AttachmentSummary) => Promise<string>) | undefined,
): ChatVisualPage | null {
  const visual = chatVisualReply(message);
  return visual && (chatVisualPageUrl(visual.attachment.previewUrl) || loadPage) ? visual : null;
}

export function ChatVisualReply(props: {
  message: AgentMessage;
  initial: ChatVisualPage;
  onMessage: (text: string) => void;
  onContext: (text: string) => void;
  onQuote: (quoteId: string, text: string) => void;
}) {
  const { props: view, openExternalMessageUrl, previewAttachment } = useConversationViewScope();
  const visual = () => chatVisualReply(props.message) ?? props.initial;
  const pageUrl = () => chatVisualPageUrl(visual().attachment.previewUrl);
  const pageQuoteId = () =>
    fileQuoteId({ source: "attachment", attachmentId: visual().attachment.id, name: visual().attachment.name });
  const loadPage = untrack(() => conversationRuntime(view).visualPage);
  const backdropAction = useMessageBackdropAction(untrack(() => conversationRuntime(view)));
  const [page, setPage] = createSignal<{ html?: string; failed?: boolean }>({});
  if (loadPage && !untrack(pageUrl)) {
    let mounted = true;
    onCleanup(() => {
      mounted = false;
    });
    void loadPage(untrack(() => props.initial.attachment)).then(
      (html) => {
        if (mounted) setPage({ html });
      },
      () => {
        if (mounted) setPage({ failed: true });
      },
    );
  }
  // Fork (docs/fork/FEATURES.md #123): the page's saved data, and "Save as app" for a page an agent made.
  const pageSource = () => {
    const agentId = props.message.senderAgentId ?? view.agent?.id;
    if (!agentId || props.message.streaming || props.message.author !== "agent") return null;
    const title = props.message.body.trim();
    return title
      ? { serverId: view.server?.id ?? "local", agentId, attachmentId: visual().attachment.id, title }
      : null;
  };
  const inChatWindow = new URLSearchParams(window.location.search).get("window") === "chat";
  const saveAsApp = () => {
    const source = pageSource();
    if (!source || !savedAppsPort()) return undefined;
    watchSavedApps();
    return {
      save: () => saveChatPageAsApp({ ...source, messageId: props.message.id }),
      savedAppId: () => {
        const page = pageSource();
        const saved = page
          ? savedApps().find(
              (app) => app.serverId === page.serverId && app.agentId === page.agentId && app.title === page.title,
            )
          : undefined;
        return saved?.id ?? null;
      },
      open: (appId: string) => {
        if (inChatWindow) void savedAppsPort()?.forkOpenSavedAppWindow(appId);
        else openSavedAppPage(appId);
      },
    };
  };
  return (
    <ChatVisual
      src={pageUrl()}
      html={page().html}
      failed={pageUrl() === undefined && (!loadPage || page().failed === true)}
      title={props.message.body}
      height={visual().height}
      onOpenLink={(url) => void openExternalMessageUrl(url)}
      onMessage={props.onMessage}
      onContext={props.onContext}
      onQuote={(text) => props.onQuote(pageQuoteId(), text)}
      quoteShortcut={deviceQuoteShortcut(view.platform)}
      onOpenInSidePanel={() => void previewAttachment(visual().attachment)}
      onUseAsBackdrop={backdropAction(props.message)}
      isAppShortcut={isChatVisualAppShortcut}
      macWindowControls={view.platform === "darwin"}
      onState={pageStateHost(pageSource)}
      saveAsApp={saveAsApp()}
    />
  );
}

export function useThreadVisualReplyCard(draftKey: () => string | undefined, focusDraft?: () => void) {
  const { props: view, threadComposer } = useConversationViewScope();
  const setDraft = (next: (draft: string) => string | undefined) => {
    const key = draftKey();
    if (!key) return;
    const text = next(threadComposer.draft(key).text);
    if (text !== undefined) threadComposer.setText(key, text);
  };
  return (message: AgentMessage, quote: (messageId: string, text: string) => void) => {
    const visual = shownVisualReply(
      message,
      untrack(() => conversationRuntime(view).visualPage),
    );
    if (!visual) return undefined;
    return (
      <article data-chat-search-message={message.id} aria-label={message.body}>
        <ChatVisualReply
          message={message}
          initial={visual}
          onMessage={(text) => {
            setDraft((draft) => draftWithPageText(draft, text));
            focusDraft?.();
          }}
          onContext={(text) => setDraft((draft) => draftWithPageContext(draft, message.id, text))}
          onQuote={quote}
        />
      </article>
    );
  };
}
