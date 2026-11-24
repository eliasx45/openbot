import type { ConversationMessage } from "@openbot/contracts/ipc";
import { describe, expect, it, vi } from "vitest";
import { projectChatMessages } from "./chat-messages";

vi.mock(
  "@/features/marketplace/model/plugin-catalog.generated",
  () => import("../../marketplace/model/plugin-catalog.generated"),
);
vi.mock("@/features/servers/model/connectors", () => import("../../servers/model/connectors"));
vi.mock("@/features/workspace/model/turn-step-lines", () => import("../../workspace/model/turn-step-lines"));

const CITED =
  'See :codex-file-citation{path="/repo/src/app.ts" line_range_start=3} for details\u{e200}cite\u{e202}turn0search1\u{e201}.';

function message(
  id: string,
  author: ConversationMessage["author"],
  text: string,
  itemType?: string,
): ConversationMessage {
  return {
    id,
    turnId: "turn-1",
    author,
    text,
    status: "completed",
    ...(itemType ? { itemType } : {}),
    createdAt: `2026-11-24T10:00:0${id.length % 10}.000Z`,
  };
}

describe("an agent's citations on the phone", () => {
  it("shows a file citation as a link and drops a search citation, as the desktop does", () => {
    const rows = projectChatMessages([message("a", "assistant", CITED)]);
    const reply = rows.find((row) => row.kind === "message");
    expect(reply?.kind === "message" ? reply.body : undefined).toBe("See [app.ts](</repo/src/app.ts>) for details.");
  });

  it("cleans a work step too", () => {
    const rows = projectChatMessages([message("bb", "assistant", CITED, "commentary")]);
    const thinking = rows.find((row) => row.kind === "thinking");
    expect(thinking?.kind === "thinking" ? thinking.steps.map((step) => step.text) : []).toEqual([
      "See [app.ts](</repo/src/app.ts>) for details.",
    ]);
  });

  it("keeps a user's own text as written", () => {
    const rows = projectChatMessages([message("ccc", "user", CITED)]);
    const sent = rows.find((row) => row.kind === "message");
    expect(sent?.kind === "message" ? sent.body : undefined).toBe(CITED);
  });
});
