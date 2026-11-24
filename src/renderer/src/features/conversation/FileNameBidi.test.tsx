import type { AttachmentSummary, FilePreview } from "@openbot/contracts/ipc";
import { AttachmentCards } from "@openbot/ui/features/conversation/AttachmentCards";
import { ComposerAttachmentRow } from "@openbot/ui/features/conversation/ComposerAttachmentRow";
import FilePreviewPanel from "@openbot/ui/features/conversation/FilePreviewPanel";
import { RichMessageText } from "@openbot/ui/features/conversation/RichMessageText";
import { render, screen } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";

const RIGHT_TO_LEFT_OVERRIDE = String.fromCodePoint(0x202e);
const SPOOFED = `invoice${RIGHT_TO_LEFT_OVERRIDE}fdp.command`;
const SHOWN = "invoicefdp.command";
const BIDI_CONTROLS = /[\u202A-\u202E\u2066-\u2069]/u;

const spoofed: AttachmentSummary = {
  id: "attachment-spoofed",
  name: SPOOFED,
  size: 2_048,
  kind: "file",
  mimeType: "application/octet-stream",
  previewKind: "none",
  previewUrl: null,
};

function shownText(): string {
  return document.body.textContent ?? "";
}

function labels(): string[] {
  return Array.from(document.querySelectorAll("[aria-label], [title], [alt]"), (element) =>
    ["aria-label", "title", "alt"].map((name) => element.getAttribute(name) ?? "").join(" "),
  );
}

describe("a file name with bidirectional control characters", () => {
  it("shows its real order in a message's file card", () => {
    render(() => <AttachmentCards attachments={[spoofed]} onPreview={vi.fn()} onAction={vi.fn()} />);
    expect(screen.getByText(SHOWN)).toBeTruthy();
    expect(shownText()).not.toMatch(BIDI_CONTROLS);
    expect(labels().join(" ")).not.toMatch(BIDI_CONTROLS);
  });

  it("shows its real order in the message box", () => {
    render(() => <ComposerAttachmentRow attachments={[spoofed]} onRemove={vi.fn()} />);
    expect(screen.getByText(SHOWN)).toBeTruthy();
    expect(shownText()).not.toMatch(BIDI_CONTROLS);
    expect(labels().join(" ")).not.toMatch(BIDI_CONTROLS);
  });

  it("shows its real order in a file chip inside a message", () => {
    render(() => (
      <RichMessageText
        body={`Here it is: @[${SPOOFED}](attachment:${spoofed.id})`}
        agents={[]}
        attachments={[spoofed]}
        onSelectAgent={vi.fn()}
        onOpenLink={vi.fn()}
      />
    ));
    expect(screen.getByText(SHOWN)).toBeTruthy();
    expect(shownText()).not.toMatch(BIDI_CONTROLS);
    expect(labels().join(" ")).not.toMatch(BIDI_CONTROLS);
  });

  it("shows its real order in the file panel title", () => {
    const preview: FilePreview = {
      name: SPOOFED,
      size: 2_048,
      mimeType: "application/octet-stream",
      previewKind: "none",
      bytes: null,
    };
    render(() => (
      <FilePreviewPanel
        readWidth={() => 480}
        onResizeEnd={vi.fn()}
        onResetWidth={vi.fn()}
        readWrapLines={() => false}
        onWrapLinesChange={vi.fn()}
        preview={preview}
        agents={[]}
        maxWidth={() => 900}
        onWidthChange={vi.fn()}
        onOpenLink={vi.fn()}
        onOpenSharedFile={vi.fn()}
        onOpenExternally={vi.fn()}
        onClose={vi.fn()}
      />
    ));
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe(SHOWN);
  });
});
