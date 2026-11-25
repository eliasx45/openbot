import type { ChannelThreads } from "@openbot/contracts/fork-channel-threads";
import type { CentralAuthUser } from "@openbot/contracts/ipc";
import type { AgentMessage } from "@openbot/ui/data";
import { MessageSelectionActions } from "@openbot/ui/features/conversation/SelectionActions";
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ConversationViewScope, ConversationViewScopeContext } from "../conversation/conversation-scope";
import { type ChannelFeedModel, ChannelThreadPanel } from "./ChannelFeedView";
import { saveThreadDraft, threadDraft } from "./channel-feed";

// Fork (docs/fork/FEATURES.md #112): the selection bar of a message in the channel thread panel quotes
// into the panel's "Reply…" box and sends into that thread, not into the feed composer (a new thread).

const ANSWER = "Proxies (4× US — not included in the plan) for the cloud phones.";

const rows: AgentMessage[] = [
  {
    id: "root",
    author: "you",
    body: "what do I need in geelark for the 2 x + 2 ig accounts?",
    time: "5:22 PM",
    senderMember: { id: "me", name: "Me" },
  },
  { id: "answer", author: "agent", body: ANSWER, time: "5:23 PM", senderAgentId: "traf" },
];

const threads: ChannelThreads = {
  roots: [],
  rootOf: new Map([
    ["root", "root"],
    ["answer", "root"],
  ]),
  summaries: new Map(),
};

/** The test stubs only the parts of a type that the panel reads. */
function stubbed<T>(value: unknown): value is T {
  return value !== null;
}

function stubScope(): ConversationViewScope {
  const scope = {
    props: {
      agents: [],
      presence: { members: [] },
      isOwnSender: () => true,
      currentUserChatColor: null,
      platform: "darwin",
      onSelectAgent: () => undefined,
      runtime: undefined,
    },
    channel: { author: () => ({ kind: "agent", name: "Traf", avatarSeed: "traf" }) },
    conversationPanelElement: () => undefined,
    setActiveRightPanel: () => undefined,
    sidePanelOpen: () => false,
    openExternalMessageUrl: async () => undefined,
    previewAttachment: async () => undefined,
    attachmentAction: () => undefined,
    attachmentDownloads: undefined,
    openSharedFile: () => undefined,
    openWorkspaceFile: () => undefined,
    installedSkills: () => [],
    openTaggedReference: () => undefined,
  };
  if (!stubbed<ConversationViewScope>(scope)) throw new Error("no scope");
  return scope;
}

function renderPanel() {
  const sendReply = vi.fn(async (_rootId: string, _text: string) => true);
  const feedQuote = vi.fn();
  const feedSend = vi.fn(async (_messageId: string, _body: string) => true);
  const model: ChannelFeedModel = {
    channelId: "agency",
    name: () => "Agency",
    readOnly: () => false,
    threads: () => threads,
    rows: () => rows,
    openRoot: () => "root",
    open: () => undefined,
    close: () => undefined,
    panelFocus: () => 0,
    sendReply,
    mentionAgents: () => [],
    account: () => {
      const user = { id: "me", name: "Me" };
      if (!stubbed<CentralAuthUser>(user)) throw new Error("no user");
      return user;
    },
    showInChat: () => undefined,
    hasOlder: () => false,
    loadOlder: () => undefined,
  };
  render(() => (
    <ConversationViewScopeContext value={stubScope()}>
      {/* The conversation's own bar, as ConversationView mounts it: its quote goes to the feed composer. */}
      <MessageSelectionActions
        contextKey="agency"
        disabled={false}
        onSend={feedSend}
        onQuote={feedQuote}
        onQueueNote={() => true}
        quoteShortcut="meta"
      />
      <p data-selection-message-id="chat-message">Text outside the thread panel</p>
      <ChannelThreadPanel model={model} rootId="root" onClosed={() => undefined} />
    </ConversationViewScopeContext>
  ));
  return { sendReply, feedQuote, feedSend };
}

function selectInAnswer(word: string, messageId = "answer") {
  const block = document.querySelector<HTMLElement>(`[data-selection-message-id="${messageId}"]`);
  if (!block) throw new Error("the answer has no selectable text");
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node && !node.textContent?.includes(word)) node = walker.nextNode();
  if (!(node instanceof Text)) throw new Error(`no text node with ${word}`);
  const start = node.data.indexOf(word);
  fireEvent.pointerDown(document.body);
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, start + word.length);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  fireEvent.pointerUp(document.body);
}

function panelEditor(): HTMLElement {
  const editor = screen.getByRole("textbox", { name: "Reply in thread" });
  return editor;
}

describe("selection bar in the channel thread panel", () => {
  afterEach(() => {
    window.getSelection()?.removeAllRanges();
    saveThreadDraft("agency", "root", "");
  });

  it("Quote puts the selection in the panel's reply box and the send is a reply to the thread root", async () => {
    const { sendReply, feedQuote, feedSend } = renderPanel();
    selectInAnswer("Proxies (4× US");
    expect(await screen.findAllByRole("toolbar", { name: "Actions for selected text" })).toHaveLength(1);
    fireEvent.click(await screen.findByRole("button", { name: "Quote" }));
    expect(feedQuote).not.toHaveBeenCalled();
    const editor = panelEditor();
    await waitFor(() => expect(editor.querySelector('[data-quote-message-id="answer"]')).not.toBeNull());
    expect(threadDraft("agency", "root")).toContain("Proxies (4× US");
    const form = editor.closest("form");
    if (!form) throw new Error("the reply box has no form");
    fireEvent.submit(form);
    await waitFor(() => expect(sendReply).toHaveBeenCalledTimes(1));
    const [rootId, text] = sendReply.mock.calls[0] ?? [];
    expect(rootId).toBe("root");
    expect(text).toContain("Proxies (4× US");
    expect(text).toContain("answer");
    expect(feedSend).not.toHaveBeenCalled();
  });

  it("Explain from a panel message is sent into the thread", async () => {
    const { sendReply, feedSend, feedQuote } = renderPanel();
    selectInAnswer("4× US");
    fireEvent.click(await screen.findByRole("button", { name: "Explain" }));
    await waitFor(() => expect(sendReply).toHaveBeenCalledTimes(1));
    expect(sendReply.mock.calls[0]?.[0]).toBe("root");
    expect(sendReply.mock.calls[0]?.[1]).toContain("4× US");
    expect(feedSend).not.toHaveBeenCalled();
    expect(feedQuote).not.toHaveBeenCalled();
  });

  it("Enter in the empty describe field quotes into the panel's reply box", async () => {
    const { feedQuote } = renderPanel();
    selectInAnswer("Proxies");
    const field = await screen.findByLabelText("Describe edits");
    if (!(field instanceof HTMLInputElement) || !field.form) throw new Error("no describe field");
    fireEvent.keyDown(field, { key: "Enter", code: "Enter" });
    fireEvent.submit(field.form);
    expect(feedQuote).not.toHaveBeenCalled();
    await waitFor(() => expect(panelEditor().querySelector('[data-quote-message-id="answer"]')).not.toBeNull());
  });

  it("text outside the panel keeps the conversation's own bar", async () => {
    const { feedQuote, sendReply } = renderPanel();
    selectInAnswer("outside", "chat-message");
    fireEvent.click(await screen.findByRole("button", { name: "Quote" }));
    expect(feedQuote).toHaveBeenCalledWith("chat-message", "outside");
    expect(panelEditor().querySelector("[data-quote-message-id]")).toBeNull();
    expect(sendReply).not.toHaveBeenCalled();
  });
});
