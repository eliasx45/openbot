import type { AttachmentSummary } from "@openbot/contracts/ipc";
import type { AgentMessage } from "@openbot/ui/data";
import { ChatMessageRow } from "@openbot/ui/features/conversation/ChatMessageRow";
import { fn } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { STORY_AGENTS } from "./fixtures";

const clip = new URL("../../../packages/ui/src/assets/plush/fishing.webm", import.meta.url).href;

/** A video that an agent attached to its reply, as `attach_files_to_response` stores it. */
export function storyVideo(index: number, name: string, url = clip, size = 4.9 * 1024 * 1024): AttachmentSummary {
  return {
    id: `chat-video-${index}`,
    name,
    size,
    kind: "file",
    mimeType: name.endsWith(".webm") ? "video/webm" : "video/mp4",
    previewKind: "none",
    previewUrl: url,
  };
}

const PREVIEW_NAMES = [
  "1_preview.webm",
  "2_preview.webm",
  "3_preview.webm",
  "4_preview.webm",
  "4_preview_letters_alt.webm",
  "5_preview.webm",
  "6_preview.webm",
  "7_preview.webm",
  "text animations reel.webm",
];

/**
 * An agent reply with only files: the chat draws it as a ghost bubble, with the actions and the
 * steps beside it, in a chat column as wide as a full window (about 1150 px).
 */
export function VideoReply(props: { attachments: AttachmentSummary[]; width?: string }) {
  const message: AgentMessage = {
    id: "chat-video-reply",
    author: "agent",
    body: "",
    time: "14:27",
    attachments: props.attachments,
  };
  const agent = STORY_AGENTS[0];
  return (
    <main
      class="foundation-story"
      style={{ width: props.width ?? "1150px", "max-width": "calc(100vw - 32px)", padding: "16px" }}
    >
      <div class="virtual-chat-list-static">
        <div class="virtual-chat-row">
          <ChatMessageRow
            message={message}
            author={{ kind: "agent", name: agent?.name ?? "Agent", agent }}
            agents={STORY_AGENTS}
            actionsBeside
            steps={<span class="message-steps">6 steps · 13s</span>}
            onSelectAgent={fn()}
            onOpenLink={fn()}
            onPreview={fn()}
            onAttachmentAction={fn()}
          />
        </div>
      </div>
    </main>
  );
}

const meta = {
  title: "Conversation/Chat video attachments",
  component: VideoReply,
  excludeStories: ["storyVideo", "VideoReply"],
  parameters: { layout: "fullscreen" },
  args: { attachments: [storyVideo(0, PREVIEW_NAMES[0] ?? "preview.webm")] },
} satisfies Meta<typeof VideoReply>;

export default meta;
type Story = StoryObj<typeof meta>;

/** One video fills the chat column, up to a height that keeps it on screen. */
export const OneVideo: Story = { name: "One video" };

/** Several videos make a grid of large tiles, each with its name under it. */
export const NineVideos: Story = {
  name: "Nine videos",
  args: { attachments: PREVIEW_NAMES.map((name, index) => storyVideo(index, name)) },
};

/** The narrowest main window: the grid keeps one column of full-width tiles. */
export const NineVideosNarrow: Story = {
  name: "Nine videos, narrow window",
  args: { attachments: PREVIEW_NAMES.map((name, index) => storyVideo(index, name)), width: "560px" },
};

/** A video next to other files: the files keep their compact cards. */
export const VideoWithFiles: Story = {
  name: "Video with other files",
  args: {
    attachments: [
      storyVideo(0, "before-after.webm"),
      {
        id: "chat-video-notes",
        name: "edit-notes.md",
        size: 6_144,
        kind: "file",
        mimeType: "text/markdown",
        previewKind: "text",
        previewUrl: null,
      },
    ],
  },
};
