// Fork (docs/fork/FEATURES.md #76): where WhatsApp Watch shows in the orchestrator's chat. The routing
// itself is checked by `bun scripts/fork-whatsapp-watch-main-chat-e2e.ts`; these stories show what the
// app renders for the conversations it leaves: the watched burst and its answer in the main chat, or a
// "👁️ Ichiro" side thread.

import type { AgentTask, ConversationMessage, ConversationSnapshot } from "@openbot/contracts/ipc";
import { LOCAL_SERVER_ID } from "@openbot/contracts/ipc";
import { onSettled } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { STORY_AGENT_SUMMARIES, STORY_SNAPSHOTS } from "../src/preview/fixtures";
import type { MockOpenBotOptions } from "../src/preview/mock-openbot";
import { AGENT_ID, TABS_KEY } from "./agent-threads-fixtures";
import { createAppDom, openChat, PrototypeApp } from "./prototype-support";
import "./agent-threads-story.css";

function message(id: string, author: "user" | "assistant", text: string, createdAt: string): ConversationMessage {
  return { id, author, source: author, text, createdAt, status: "completed" };
}

const BEFORE: ConversationMessage[] = [
  message("desk-1", "user", "Desk, route Ichiro's reviews to Zito from now on.", "2026-11-12T09:58:00.000Z"),
  message("desk-2", "assistant", "Got it: Ichiro's reviews go to Zito.", "2026-11-12T09:58:20.000Z"),
];

const WATCHED: ConversationMessage[] = [
  ...BEFORE,
  message(
    "desk-3",
    "user",
    "👁️ Ichiro: new review is up: https://f.io/abc123\n👁️ Ichiro: frame 1280 the logo pops too early\n👁️ You → Ichiro: thanks, on it tomorrow",
    "2026-11-12T10:04:00.000Z",
  ),
  message("desk-4", "assistant", "Ichiro sent a Frame.io review → Zito ✓", "2026-11-12T10:04:30.000Z"),
  message("desk-5", "user", "what did Ichiro send?", "2026-11-12T10:06:00.000Z"),
  message(
    "desk-6",
    "assistant",
    "A Frame.io review (https://f.io/abc123): the logo pops too early at frame 1280. Zito has it.",
    "2026-11-12T10:06:20.000Z",
  ),
];

function chiefSnapshot(): ConversationSnapshot {
  const snapshot = STORY_SNAPSHOTS[AGENT_ID];
  if (!snapshot) throw new Error("No story snapshot for Chief.");
  return snapshot;
}

function mainChat(messages: ConversationMessage[]): Record<string, ConversationSnapshot> {
  return { ...STORY_SNAPSHOTS, [AGENT_ID]: { ...chiefSnapshot(), messages } };
}

const AGENTS = STORY_AGENT_SUMMARIES.map((agent) =>
  agent.id === AGENT_ID ? { ...agent, name: "Desk", title: "WhatsApp Orchestrator" } : agent,
);

const WATCH_THREAD: AgentTask = {
  id: "watch-ichiro",
  agentId: AGENT_ID,
  threadId: "thread-watch-ichiro",
  origin: "agent",
  title: "👁️ Ichiro",
  state: "idle",
  outcome: "completed",
  hold: null,
  activeTurnId: null,
  progress: null,
  error: null,
  queuedMessages: [],
  createdAt: "2026-11-12T10:04:00.000Z",
  updatedAt: "2026-11-12T10:04:30.000Z",
  closedAt: null,
};

const OPTIONS = {
  before: { agents: AGENTS, snapshots: mainChat(BEFORE) },
  main: { agents: AGENTS, snapshots: mainChat(WATCHED) },
  thread: {
    agents: AGENTS,
    snapshots: mainChat(BEFORE),
    tasks: { [AGENT_ID]: [WATCH_THREAD] },
    taskConversations: {
      [WATCH_THREAD.id]: {
        agentId: AGENT_ID,
        threadId: WATCH_THREAD.threadId,
        activeTurnId: null,
        revision: 1,
        messages: WATCHED.slice(2, 4),
      },
    },
  },
} satisfies Record<string, MockOpenBotOptions>;

function WatchApp(props: { options: MockOpenBotOptions; open?: string[]; active?: string | null }) {
  localStorage.setItem(
    TABS_KEY,
    JSON.stringify({ [LOCAL_SERVER_ID]: { [AGENT_ID]: { open: props.open ?? [], active: props.active ?? null } } }),
  );
  const app = createAppDom();
  onSettled(() => {
    const root = app.dom.root;
    if (!root) return;
    const observer = new MutationObserver(() => {
      if (openChat(root, AGENT_ID)) observer.disconnect();
    });
    observer.observe(root, { subtree: true, childList: true });
    return () => observer.disconnect();
  });
  return (
    <div class="agent-threads-story" ref={app.attach}>
      <PrototypeApp options={props.options} />
    </div>
  );
}

const meta = {
  title: "Conversation/WhatsApp Watch (fork #76)",
  parameters: { layout: "fullscreen" },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

/** Before #76: the orchestrator's own chat never shows the watched chats; they live in a hidden thread. */
export const MainChatBefore: Story = { render: () => <WatchApp options={OPTIONS.before} /> };

/** "Main chat" (the default): the watched burst, the answer, and a question about it, in the own chat. */
export const MainChat: Story = { render: () => <WatchApp options={OPTIONS.main} /> };

/** "Own thread": the watched conversation in a "👁️ Ichiro" tab of the orchestrator's chat. */
export const OwnThread: Story = {
  render: () => <WatchApp options={OPTIONS.thread} open={[WATCH_THREAD.id]} active={WATCH_THREAD.id} />,
};
