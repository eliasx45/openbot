import { DataTable, type DataTableBlock } from "@openbot/ui/features/conversation/DataTable";
import { MessageSelectionActions } from "@openbot/ui/features/conversation/SelectionActions";
import { fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

// Fork #80: text selected in a reply's table opens the same selection bar as text in a paragraph.
const table: DataTableBlock = {
  type: "table",
  headers: ["Part", "Now"],
  alignments: ["left", "left"],
  rows: [
    ["Camera slides ×1.10", "measuring YT-3's moves"],
    ["Pops + whooshes", "listen-test file done"],
  ],
};

function renderReplyTable() {
  const onQuote = vi.fn();
  const onSend = vi.fn(async (_messageId: string, _body: string) => true);
  render(() => (
    <>
      <DataTable table={table} selectionMessageId="message-1" />
      <MessageSelectionActions contextKey="chat" disabled={false} onSend={onSend} onQuote={onQuote} />
    </>
  ));
  return { onQuote, onSend };
}

function cellText(text: string): Text {
  const cell = screen.getByText(text);
  const node = cell.firstChild;
  if (!(node instanceof Text)) throw new Error(`no text in the cell ${text}`);
  return node;
}

function select(start: Text, startOffset: number, end: Text, endOffset: number) {
  const range = document.createRange();
  range.setStart(start, startOffset);
  range.setEnd(end, endOffset);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  fireEvent.pointerUp(document.body);
}

describe("selection actions on a reply table", () => {
  afterEach(() => window.getSelection()?.removeAllRanges());

  it("shows the bar for text in one cell and quotes that text", async () => {
    const { onQuote } = renderReplyTable();
    const cell = cellText("Camera slides ×1.10");
    select(cell, 0, cell, cell.length);

    expect(await screen.findByRole("toolbar")).toBeInTheDocument();
    expect(screen.getByLabelText("Explain")).toBeInTheDocument();
    expect(screen.getByLabelText("Improve")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Quote"));
    expect(onQuote).toHaveBeenCalledWith("message-1", "Camera slides ×1.10");
  });

  it("quotes a selection across cells and rows as one line per row, cells joined with a dot", async () => {
    const { onQuote } = renderReplyTable();
    select(cellText("Camera slides ×1.10"), 7, cellText("Pops + whooshes"), 4);

    expect(await screen.findByRole("toolbar")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Quote"));
    expect(onQuote).toHaveBeenCalledWith("message-1", "slides ×1.10 · measuring YT-3's moves\nPops");
  });

  it("sends Explain with the table text quoted", async () => {
    const { onSend } = renderReplyTable();
    select(cellText("Pops + whooshes"), 0, cellText("listen-test file done"), 11);

    fireEvent.click(await screen.findByLabelText("Explain"));
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith("message-1", expect.stringContaining("> Pops + whooshes · listen-test"));
  });
});
