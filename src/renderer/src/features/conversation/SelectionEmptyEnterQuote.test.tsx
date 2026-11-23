import { DataTable, type DataTableBlock } from "@openbot/ui/features/conversation/DataTable";
import { MessageSelectionActions } from "@openbot/ui/features/conversation/SelectionActions";
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

// Fork: Enter in the empty "Describe edits" field of the selection bar quotes the selection, as the
// Quote action does, so the person can write about it in the message box.
const table: DataTableBlock = {
  type: "table",
  headers: ["Part", "Now"],
  alignments: ["left", "left"],
  rows: [
    ["Camera slides ×1.10", "measuring YT-3's moves"],
    ["Pops + whooshes", "listen-test file done"],
  ],
};

function renderReplyTable(options: { quote?: boolean } = {}) {
  const onQuote = vi.fn();
  const onSend = vi.fn(async (_messageId: string, _body: string) => true);
  const onQueueNote = vi.fn((_messageId: string, _text: string, _note: string) => true);
  render(() => (
    <>
      <DataTable table={table} selectionMessageId="message-1" />
      <MessageSelectionActions
        contextKey="chat"
        disabled={false}
        onSend={onSend}
        onQuote={options.quote === false ? undefined : onQuote}
        onQueueNote={onQueueNote}
        quoteShortcut="meta"
      />
    </>
  ));
  return { onQuote, onSend, onQueueNote };
}

function cellText(text: string): Text {
  const node = screen.getByText(text).firstChild;
  if (!(node instanceof Text)) throw new Error(`no text in the cell ${text}`);
  return node;
}

function select(start: Text, startOffset: number, end: Text, endOffset: number) {
  fireEvent.pointerDown(document.body);
  const range = document.createRange();
  range.setStart(start, startOffset);
  range.setEnd(end, endOffset);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  fireEvent.pointerUp(document.body);
}

async function describeField(): Promise<HTMLInputElement> {
  const field = await screen.findByLabelText("Describe edits");
  if (!(field instanceof HTMLInputElement)) throw new Error("the describe field is not an input");
  return field;
}

function formOf(field: HTMLInputElement): HTMLFormElement {
  if (!field.form) throw new Error("the describe field has no form");
  return field.form;
}

/** Enter as a browser gives it to a one-line field: the key, then the form's implicit submission. */
function pressEnter(field: HTMLInputElement, init: KeyboardEventInit = {}) {
  const sent = fireEvent.keyDown(field, { key: "Enter", code: "Enter", ...init });
  if (sent && !init.isComposing && !init.metaKey && !init.ctrlKey) fireEvent.submit(formOf(field));
  fireEvent.keyUp(field, { key: "Enter", code: "Enter", ...init });
}

describe("Enter in the empty describe field of the selection bar", () => {
  afterEach(() => window.getSelection()?.removeAllRanges());

  it("quotes a one-cell selection, the same as the Quote action, and closes the bar", async () => {
    const { onQuote, onQueueNote, onSend } = renderReplyTable();
    const cell = cellText("Camera slides ×1.10");
    select(cell, 0, cell, cell.length);

    pressEnter(await describeField());
    expect(onQuote).toHaveBeenCalledTimes(1);
    expect(onQuote).toHaveBeenCalledWith("message-1", "Camera slides ×1.10");
    expect(onQueueNote).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("toolbar")).not.toBeInTheDocument());
  });

  it("gives the same quote as the Quote action for a selection across cells and rows", async () => {
    const first = renderReplyTable();
    select(cellText("Camera slides ×1.10"), 7, cellText("Pops + whooshes"), 4);
    fireEvent.click(await screen.findByLabelText("Quote"));
    const clicked = first.onQuote.mock.calls[0];
    expect(clicked).toEqual(["message-1", "slides ×1.10 · measuring YT-3's moves\nPops"]);

    select(cellText("Camera slides ×1.10"), 7, cellText("Pops + whooshes"), 4);
    pressEnter(await describeField());
    expect(first.onQuote).toHaveBeenCalledTimes(2);
    expect(first.onQuote.mock.calls[1]).toEqual(clicked);
  });

  it("quotes when the field holds only spaces", async () => {
    const { onQuote, onQueueNote } = renderReplyTable();
    const cell = cellText("Pops + whooshes");
    select(cell, 0, cell, cell.length);
    const field = await describeField();
    fireEvent.input(field, { target: { value: "   " } });

    pressEnter(field);
    expect(onQuote).toHaveBeenCalledWith("message-1", "Pops + whooshes");
    expect(onQueueNote).not.toHaveBeenCalled();
  });

  it("quotes on Shift+Enter too, as a one-line field has no new line", async () => {
    const { onQuote } = renderReplyTable();
    const cell = cellText("Pops + whooshes");
    select(cell, 0, cell, cell.length);

    pressEnter(await describeField(), { shiftKey: true });
    expect(onQuote).toHaveBeenCalledTimes(1);
  });

  it("keeps a typed note as before: Enter adds the note, not a bare quote", async () => {
    const { onQuote, onQueueNote, onSend } = renderReplyTable();
    const cell = cellText("Camera slides ×1.10");
    select(cell, 0, cell, cell.length);
    const field = await describeField();
    fireEvent.input(field, { target: { value: "make this 1.2" } });

    pressEnter(field);
    expect(onQueueNote).toHaveBeenCalledWith("message-1", "Camera slides ×1.10", "make this 1.2");
    expect(onQuote).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
  });

  it("keeps Command+Enter with a typed note as an instant send", async () => {
    const { onQuote, onQueueNote, onSend } = renderReplyTable();
    const cell = cellText("Camera slides ×1.10");
    select(cell, 0, cell, cell.length);
    const field = await describeField();
    fireEvent.input(field, { target: { value: "shorter" } });

    pressEnter(field, { metaKey: true });
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onQueueNote).not.toHaveBeenCalled();
    expect(onQuote).not.toHaveBeenCalled();
  });

  it("does nothing on an empty Command+Enter, as before", async () => {
    const { onQuote, onSend } = renderReplyTable();
    const cell = cellText("Camera slides ×1.10");
    select(cell, 0, cell, cell.length);

    pressEnter(await describeField(), { metaKey: true });
    expect(onSend).not.toHaveBeenCalled();
    expect(onQuote).not.toHaveBeenCalled();
    expect(screen.getByRole("toolbar")).toBeInTheDocument();
  });

  it("does not quote on the Enter that ends an input method composition", async () => {
    const { onQuote } = renderReplyTable();
    const cell = cellText("Camera slides ×1.10");
    select(cell, 0, cell, cell.length);
    const field = await describeField();

    fireEvent.keyDown(field, { key: "Enter", code: "Enter", isComposing: true });
    fireEvent.keyDown(field, { key: "Enter", code: "Enter", keyCode: 229 });
    // A browser that still submits the form after such an Enter.
    fireEvent.submit(formOf(field));
    expect(onQuote).not.toHaveBeenCalled();
    expect(screen.getByRole("toolbar")).toBeInTheDocument();

    pressEnter(field);
    expect(onQuote).toHaveBeenCalledTimes(1);
  });

  it("closes the bar on Escape without quoting", async () => {
    const { onQuote } = renderReplyTable();
    const cell = cellText("Camera slides ×1.10");
    select(cell, 0, cell, cell.length);
    const field = await describeField();

    fireEvent.keyUp(field, { key: "Escape", code: "Escape" });
    await waitFor(() => expect(screen.queryByRole("toolbar")).not.toBeInTheDocument());
    expect(onQuote).not.toHaveBeenCalled();
  });

  it("lets a held or fast second Enter do nothing in the message box, then Enter works again", async () => {
    const { onQuote } = renderReplyTable();
    const box = document.createElement("div");
    box.contentEditable = "true";
    document.body.append(box);
    const cell = cellText("Camera slides ×1.10");
    select(cell, 0, cell, cell.length);
    const field = await describeField();
    fireEvent.keyDown(field, { key: "Enter", code: "Enter" });
    fireEvent.submit(formOf(field));
    expect(onQuote).toHaveBeenCalledTimes(1);

    // The key is still down: its repeat does not reach the message box.
    expect(fireEvent.keyDown(box, { key: "Enter", code: "Enter", repeat: true })).toBe(false);
    fireEvent.keyUp(box, { key: "Enter", code: "Enter" });
    // A fast second press does not either.
    expect(fireEvent.keyDown(box, { key: "Enter", code: "Enter" })).toBe(false);
    fireEvent.keyUp(box, { key: "Enter", code: "Enter" });
    // Other keys are typed as usual.
    expect(fireEvent.keyDown(box, { key: "a", code: "KeyA" })).toBe(true);

    // The hold ends a moment after the key is released.
    await vi.waitFor(() => expect(fireEvent.keyDown(box, { key: "Enter", code: "Enter" })).toBe(true), {
      timeout: 2_000,
    });
    box.remove();
  });

  it("does nothing where the bar has no Quote action", async () => {
    const { onQuote, onQueueNote, onSend } = renderReplyTable({ quote: false });
    const cell = cellText("Camera slides ×1.10");
    select(cell, 0, cell, cell.length);

    pressEnter(await describeField());
    expect(onQuote).not.toHaveBeenCalled();
    expect(onQueueNote).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByRole("toolbar")).toBeInTheDocument();
  });
});
