// @vitest-environment node
// Fork (docs/fork/FEATURES.md, "Card media"): ask_ui attaches the card's files to the turn, so a remote
// client can still open them. The local chat shows them on the card, not a second time above it.
import type { ConversationMessage } from "@openbot/contracts/ipc";
import { describe, expect, it } from "vitest";
import { toAgentMessages } from "./app-message-projection";

const attachment = (id: string, name: string) => ({
  id,
  name,
  size: 10,
  kind: "file" as const,
  mimeType: "video/mp4",
  previewKind: "none" as const,
  previewUrl: null,
});

const files = (ids: string[]): ConversationMessage => ({
  id: "files",
  turnId: "t1",
  author: "assistant",
  source: "assistant",
  text: "",
  createdAt: "2026-11-10T21:00:00.000Z",
  status: "completed",
  itemType: "agent_attachment",
  attachments: ids.map((id) => attachment(id, `${id}.mp4`)),
});

const card = (src?: string): ConversationMessage => ({
  id: "card",
  turnId: "t1",
  author: "assistant",
  text: "",
  createdAt: "2026-11-10T21:00:01.000Z",
  status: "completed",
  uiBlock: {
    version: 1,
    blockId: "b1",
    spec: {
      type: "confirm",
      title: "This one?",
      actions: [{ id: "yes", label: "Yes" }],
      media: [{ path: "/v/a.mp4", ...(src ? { src } : {}) }],
    },
    state: { status: "pending" },
  },
});

describe("card media in the chat", () => {
  it("hides the attachment message whose files the card shows", () => {
    const rows = toAgentMessages([files(["a1"]), card("openbot-attachment://file/a1")], "bot");
    expect(rows.map((row) => row.id)).toEqual(["card"]);
  });

  it("keeps it when the card has no src (a remote client) or the message has other files", () => {
    expect(toAgentMessages([files(["a1"]), card()], "bot").map((row) => row.id)).toEqual(["files", "card"]);
    expect(
      toAgentMessages([files(["a1", "a2"]), card("openbot-attachment://file/a1")], "bot").map((row) => row.id),
    ).toEqual(["files", "card"]);
  });
});
