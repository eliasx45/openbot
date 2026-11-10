// Fork (docs/fork/FEATURES.md, "Card media"): an ask_ui card shows the video or image it asks about.
// Elias, 10 Nov 2026: a card asked "Healthier (6:41): make its heartbeat line one smooth draw too?" and
// he could not tell which animation it meant.

import {
  type ConversationUiBlock,
  normalizeUiBlockSpec,
  UI_BLOCK_LIMITS,
  type UiBlockSpec,
  uiBlockFallbackQuestions,
  uiBlockLooksVisualWithoutMedia,
  uiBlockMediaKind,
  uiBlockMediaLines,
} from "@openbot/contracts/ui-blocks";
import { describe, expect, it } from "vitest";
import { withConversationUiBlocks } from "../../packages/contracts/src/team-protocol/ui-blocks-v1";
import { uiBlockPromptResult, VISUAL_WITHOUT_MEDIA_NUDGE } from "./agent/prompts";
import { askUiToolSchema } from "./openbot-tools";

/** The spec, or a failed test: every block here is valid unless a test says otherwise. */
function specOf(block: unknown): UiBlockSpec {
  const spec = normalizeUiBlockSpec(block);
  if (!spec) throw new Error("invalid block");
  return spec;
}

/** The JSON the agent reads from an ask_ui result. */
function resultValue(result: ReturnType<typeof uiBlockPromptResult>): {
  mediaNotShown?: string[];
  mediaNote?: string;
  mediaNudge?: string;
} {
  const item = result.contentItems[0];
  return item && item.type === "inputText" ? JSON.parse(item.text) : {};
}

interface ConfirmExtra {
  title?: string;
  preview?: string;
  fields?: unknown[];
  media?: unknown[];
}

const confirm = (extra: ConfirmExtra = {}) => ({
  type: "confirm",
  title: "Healthier (6:41): make its heartbeat line one smooth draw too?",
  actions: [
    { id: "keep", label: "Keep" },
    { id: "smooth", label: "One smooth draw", style: "primary" },
  ],
  ...extra,
});

describe("media in the contract", () => {
  it("keeps media on every block type", () => {
    const media = [{ path: "/tmp/heartbeat.mp4", caption: "The gold line", start: 2, end: 5 }];
    const blocks = [
      confirm({ media }),
      { type: "choice", title: "Which?", options: [{ id: "a", label: "A" }], media },
      { type: "quick_replies", options: [{ id: "a", label: "A" }], media },
      { type: "form", title: "Notes", fields: [{ id: "n", kind: "text", label: "Note" }], media },
    ];
    for (const block of blocks) expect(normalizeUiBlockSpec(block)?.media).toEqual(media);
  });

  it("types a file by its extension and refuses other files", () => {
    expect(uiBlockMediaKind("/a/b.MOV")).toBe("video");
    expect(uiBlockMediaKind("/a/b.webm")).toBe("video");
    expect(uiBlockMediaKind("/a/b.jpeg")).toBe("image");
    expect(uiBlockMediaKind("/a/b.gif")).toBe("image");
    expect(uiBlockMediaKind("/a/b.pdf")).toBeNull();
    expect(normalizeUiBlockSpec(confirm({ media: [{ path: "/a/b.pdf" }] }))).toBeNull();
    expect(normalizeUiBlockSpec(confirm({ media: [{ path: "relative.mp4" }] }))).toBeNull();
  });

  it("holds the limits: 1 to 4 items, a range after its start, a host src only", () => {
    const item = { path: "/tmp/a.mp4" };
    expect(normalizeUiBlockSpec(confirm({ media: [] }))).toBeNull();
    expect(normalizeUiBlockSpec(confirm({ media: Array(UI_BLOCK_LIMITS.media).fill(item) }))).not.toBeNull();
    expect(normalizeUiBlockSpec(confirm({ media: Array(UI_BLOCK_LIMITS.media + 1).fill(item) }))).toBeNull();
    expect(normalizeUiBlockSpec(confirm({ media: [{ ...item, start: 5, end: 2 }] }))).toBeNull();
    expect(normalizeUiBlockSpec(confirm({ media: [{ ...item, src: "https://example.com/a.mp4" }] }))).toBeNull();
    expect(
      normalizeUiBlockSpec(confirm({ media: [{ ...item, src: "openbot-attachment://file/abc_1" }] }))?.media?.[0]?.src,
    ).toBe("openbot-attachment://file/abc_1");
    expect(normalizeUiBlockSpec(confirm({ media: [{ ...item, caption: "x".repeat(201) }] }))).toBeNull();
  });

  it("drops a range on an image", () => {
    expect(normalizeUiBlockSpec(confirm({ media: [{ path: "/tmp/a.png", start: 1, end: 2 }] }))?.media).toEqual([
      { path: "/tmp/a.png" },
    ]);
  });
});

describe("plain-text fallbacks", () => {
  it("names the files in the first fallback question", () => {
    const spec = specOf(
      confirm({
        media: [{ path: "/v/heartbeat.mp4", start: 2, end: 5.5, caption: "Gold line" }, { path: "/v/frame.png" }],
      }),
    );
    const [first] = uiBlockFallbackQuestions(spec);
    expect(first?.question).toContain("🎬 heartbeat.mp4 0:02–0:05.5 · Gold line");
    expect(first?.question).toContain("🖼️ frame.png");
    expect(uiBlockMediaLines([{ path: "/v/a.mp4", start: 61 }])).toEqual(["🎬 a.mp4 1:01–"]);
  });

  it("sends media on the v1 wire without the host's attachment ids", () => {
    const spec = specOf(confirm({ media: [{ path: "/v/a.mp4", src: "openbot-attachment://file/abc" }] }));
    const block: ConversationUiBlock = { version: 1, blockId: "b1", spec, state: { status: "pending" } };
    const projected = withConversationUiBlocks(
      { messages: [{ id: "m1" }] },
      { messages: [{ id: "m1", uiBlock: block }] },
    );
    expect(JSON.parse(JSON.stringify(projected)).messages[0].uiBlock.spec.media).toEqual([{ path: "/v/a.mp4" }]);
  });
});

describe("the ask_ui tool", () => {
  it("takes media in its schema, which the MCP tools of every provider share", () => {
    const parsed = askUiToolSchema.safeParse({
      block: { ...confirm(), media: [{ path: "/v/a.mp4", start: 1, end: 3, caption: "This one" }] },
    });
    expect(parsed.success).toBe(true);
    expect(askUiToolSchema.safeParse({ block: { ...confirm(), media: [{ path: "/v/a.txt" }] } }).success).toBe(false);
    const form = askUiToolSchema.safeParse({
      block: { type: "form", title: "x", fields: [{ id: "a", kind: "text", label: "A" }], media: [{ path: "/a.png" }] },
    });
    expect(form.success).toBe(true);
  });

  it("tells the agent which files the user did not see", () => {
    const result = uiBlockPromptResult({
      status: "answered",
      blockId: "b",
      response: { actionId: "keep" },
      mediaNotShown: ["/v/gone.mp4"],
    });
    const value = resultValue(result);
    expect(value.mediaNotShown).toEqual(["/v/gone.mp4"]);
    expect(value.mediaNote).toBeTruthy();
    const plain = resultValue(
      uiBlockPromptResult({ status: "answered", blockId: "b", response: { actionId: "keep" }, mediaNotShown: [] }),
    );
    expect(plain.mediaNotShown).toBeUndefined();
  });
});

describe("the nudge for a visual card without media", () => {
  const visual = (block: unknown) => uiBlockLooksVisualWithoutMedia(specOf(block));

  it("fires on a timecode, a frame number or a visual word", () => {
    expect(visual(confirm())).toBe(true);
    expect(visual(confirm({ title: "Move the logo at 00:12.5?" }))).toBe(true);
    expect(visual(confirm({ title: "Fix frame 1280?" }))).toBe(true);
    expect(visual(confirm({ title: "Speed up the animation?" }))).toBe(true);
    expect(visual(confirm({ title: "Keep it?", preview: "The scene cuts too early." }))).toBe(true);
    expect(visual(confirm({ title: "Keep it?", fields: [{ label: "Now", value: "how it moves is slow" }] }))).toBe(
      true,
    );
    expect(visual({ type: "choice", title: "Pick one", options: [{ id: "a", label: "Re-render the comp" }] })).toBe(
      true,
    );
  });

  it("stays quiet on plain yes/no cards and on clock times", () => {
    expect(visual(confirm({ title: "Send the letter to Ann?" }))).toBe(false);
    expect(visual(confirm({ title: "Delete 3 old branches?" }))).toBe(false);
    expect(visual(confirm({ title: "Book the call at 9:30 pm?" }))).toBe(false);
    expect(visual(confirm({ title: "Use the framework update?" }))).toBe(false);
    expect(visual(confirm({ title: "Take a screenshot of the error?" }))).toBe(false);
    expect(visual({ type: "choice", title: "Which plan?", options: [{ id: "a", label: "Starter" }] })).toBe(false);
  });

  it("stays quiet when the card shows media or a clip", () => {
    expect(visual(confirm({ media: [{ path: "/v/a.mp4" }] }))).toBe(false);
    expect(
      visual({
        type: "form",
        title: "The animation at 6:41",
        fields: [{ id: "a", kind: "text", label: "A", clip: { path: "/v/a.mp4" } }],
      }),
    ).toBe(false);
  });

  it("puts the nudge in the result without blocking", () => {
    const result = uiBlockPromptResult({
      status: "answered",
      blockId: "b",
      response: { actionId: "keep" },
      visualWithoutMedia: true,
    });
    expect(result.success).toBe(true);
    expect(resultValue(result).mediaNudge).toBe(VISUAL_WITHOUT_MEDIA_NUDGE);
  });
});
