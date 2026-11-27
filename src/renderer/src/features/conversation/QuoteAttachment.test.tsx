// Fork (docs/fork/FEATURES.md #128): Elias could not answer about a video or a file of a message
// (Owl chat, 27 Nov 2026): a selected file name got no Quote, and a video had no Quote at all.
import { fileQuoteTarget } from "@openbot/contracts/chat-tag-references";
import type { AttachmentSummary } from "@openbot/contracts/ipc";
import type { AgentMessage } from "@openbot/ui/data";
import { MessageBody } from "@openbot/ui/features/conversation/MessageRendering";
import { messageTextSelection } from "@openbot/ui/features/conversation/SelectionActions";
import { fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  document.body.innerHTML = "";
});

const file = (id: string, name: string, mimeType: string, previewUrl: string | null = null): AttachmentSummary => ({
  id,
  name,
  size: 3_500_000,
  kind: "file",
  mimeType,
  previewKind: mimeType === "application/pdf" ? "pdf" : "none",
  previewUrl,
});

function renderMessage(attachments: AttachmentSummary[], onQuote?: (messageId: string, text: string) => void) {
  const message: AgentMessage = { id: "owl-video", author: "agent", body: "Here it is.", time: "14:17", attachments };
  return render(() => (
    <MessageBody
      message={message}
      agents={[]}
      onSelectAgent={vi.fn()}
      onOpenLink={vi.fn()}
      onPreview={vi.fn()}
      onAttachmentAction={vi.fn()}
      onQuote={onQuote}
    />
  ));
}

describe("quote a file of a message", () => {
  it("a file card's Quote quotes it as an attached file", () => {
    const onQuote = vi.fn();
    renderMessage([file("a-1", "Recall-Sheet.pdf", "application/pdf")], onQuote);
    const button = screen.getByRole("button", { name: "Quote Recall-Sheet.pdf" });
    fireEvent.click(button);
    // A fast second click is the same quote, not a second chip.
    fireEvent.click(button);
    expect(onQuote).toHaveBeenCalledTimes(1);
    expect(onQuote.mock.calls[0]?.[1]).toBe("Recall-Sheet.pdf");
    expect(fileQuoteTarget(onQuote.mock.calls[0]?.[0])).toMatchObject({ source: "attachment", attachmentId: "a-1" });
  });

  it("a video player's caption has Quote", () => {
    const onQuote = vi.fn();
    renderMessage(
      [file("v-1", "How-to-find-dim-ker.mp4", "video/mp4", "openbot-attachment://v-1/How-to-find-dim-ker.mp4")],
      onQuote,
    );
    const [first] = screen.getAllByRole("button", { name: "Quote How-to-find-dim-ker.mp4" });
    if (first) fireEvent.click(first);
    expect(onQuote.mock.calls[0]?.[1]).toBe("How-to-find-dim-ker.mp4");
    expect(fileQuoteTarget(onQuote.mock.calls[0]?.[0])).toMatchObject({
      attachmentId: "v-1",
      name: "How-to-find-dim-ker.mp4",
    });
  });

  it("a selected file name opens the selection's Quote for the message", () => {
    renderMessage([file("a-1", "Recall-Sheet.pdf", "application/pdf")], vi.fn());
    const [name] = screen.getAllByText("Recall-Sheet.pdf");
    const range = document.createRange();
    if (name) range.selectNodeContents(name);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    expect(messageTextSelection(selection)).toMatchObject({ messageId: "owl-video", text: "Recall-Sheet.pdf" });
  });

  it("no Quote without a message box to quote into", () => {
    renderMessage([file("a-1", "Recall-Sheet.pdf", "application/pdf")]);
    expect(screen.queryByRole("button", { name: "Quote Recall-Sheet.pdf" })).toBeNull();
  });
});

// Fork (docs/fork/FEATURES.md #129): a picture shown as a picture has Quote too.
describe("quote a picture of a message", () => {
  const picture = (id: string, name: string): AttachmentSummary => ({
    id,
    name,
    size: 120_000,
    kind: "image",
    mimeType: "image/png",
    previewKind: "image",
    previewUrl: `openbot-attachment://${id}/${name}`,
  });

  it("a single picture's Quote quotes it as an attached file, once on a double click", () => {
    const onQuote = vi.fn();
    renderMessage([picture("i-1", "kernel-sketch.png")], onQuote);
    const button = screen.getByRole("button", { name: "Quote kernel-sketch.png" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(onQuote).toHaveBeenCalledTimes(1);
    expect(onQuote.mock.calls[0]?.[1]).toBe("kernel-sketch.png");
    expect(fileQuoteTarget(onQuote.mock.calls[0]?.[0])).toMatchObject({ source: "attachment", attachmentId: "i-1" });
  });

  it("each picture of a gallery has its own Quote", () => {
    const onQuote = vi.fn();
    renderMessage([picture("i-1", "step-1.png"), picture("i-2", "step-2.png")], onQuote);
    fireEvent.click(screen.getByRole("button", { name: "Quote step-2.png" }));
    expect(onQuote.mock.calls[0]?.[1]).toBe("step-2.png");
    expect(screen.getByRole("button", { name: "Quote step-1.png" })).toBeTruthy();
  });

  it("no Quote on a picture without a message box to quote into", () => {
    renderMessage([picture("i-1", "kernel-sketch.png")]);
    expect(screen.queryByRole("button", { name: "Quote kernel-sketch.png" })).toBeNull();
  });
});
