import type { AgentMessage } from "@openbot/ui/data";
import { MarkdownMessageText } from "@openbot/ui/features/conversation/MarkdownMessageText";
import { MessageBody } from "@openbot/ui/features/conversation/MessageRendering";
import { messageTextSelection } from "@openbot/ui/features/conversation/SelectionActions";
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import "katex/contrib/copy-tex";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import "../../selection-copy";

const EULER = String.raw`e^{i\pi} + 1 = 0`;
const NORM = String.raw`\|v\|_2`;
const TABLE = ["| Name | Formula |", "|---|---|", `| Euler | $${EULER}$ |`, `| Norm | $${NORM}$ for $v$ |`].join("\n");
const PROSE = [
  "Area is $x^2$ here.",
  "",
  "- one $a_1$",
  "- two",
  "",
  "$$",
  String.raw`\frac{a}{b}`,
  "$$",
  "",
  "End.",
].join("\n");

function renderReply(body: string) {
  const message: AgentMessage = { id: "math-text-reply", author: "agent", body, time: "11:21", attachments: [] };
  return render(() => (
    <MessageBody
      message={message}
      agents={[]}
      onSelectAgent={vi.fn()}
      onOpenLink={vi.fn()}
      onPreview={vi.fn()}
      onAttachmentAction={vi.fn()}
    />
  ));
}

function select(start: Node, end: Node = start): Selection {
  const range = document.createRange();
  range.setStartBefore(start);
  range.setEndAfter(end);
  return selected(range);
}

function selectContents(node: Node): Selection {
  const range = document.createRange();
  range.selectNodeContents(node);
  return selected(range);
}

function selected(range: Range): Selection {
  const selection = window.getSelection();
  if (!selection) throw new Error("no selection");
  selection.removeAllRanges();
  selection.addRange(range);
  return selection;
}

function copiedPlainText(): string {
  const data = new Map<string, string>();
  const clipboardData = {
    setData: (type: string, value: string) => data.set(type, value),
    getData: (type: string) => data.get(type) ?? "",
  };
  const event = new Event("copy", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: clipboardData });
  document.body.dispatchEvent(event);
  return data.get("text/plain") ?? "";
}

function element(container: HTMLElement, selector: string): Element {
  const found = container.querySelector(selector);
  if (!found) throw new Error(`no ${selector}`);
  return found;
}

beforeAll(async () => {
  Object.defineProperty(HTMLElement.prototype, "innerText", {
    configurable: true,
    get(this: HTMLElement) {
      return this.textContent ?? "";
    },
  });
  const { container } = render(() => (
    <MarkdownMessageText body="$x$" agents={[]} onSelectAgent={vi.fn()} onOpenLink={vi.fn()} />
  ));
  await waitFor(() => expect(container.querySelector("annotation")).not.toBeNull());
  cleanup();
});

afterAll(() => {
  Reflect.deleteProperty(HTMLElement.prototype, "innerText");
});

describe("Copy as CSV of a reply's table with math", () => {
  it("copies each formula as it was written", async () => {
    const writeText = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    renderReply(TABLE);
    fireEvent.click(screen.getByText("Copy as CSV"));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText.mock.calls[0]?.[0]).toBe(
      ["Name,Formula", `Euler,$${EULER}$`, `Norm,$${NORM}$ for $v$`].join("\n"),
    );
  });
});

describe("the selection actions' text of a selection with math", () => {
  it("takes each formula as it was written, with the line breaks", () => {
    const { container } = renderReply(PROSE);
    const blocks = element(container, ".message-markdown");
    const text = messageTextSelection(selectContents(blocks))?.text;
    expect(text).toBe(
      ["Area is $x^2$ here.", "", "one $a_1$", "two", String.raw`$$\frac{a}{b}$$`, "", "End."].join("\n"),
    );
  });

  it("takes a formula alone when only it is selected", () => {
    const { container } = renderReply("Area is $x^2$ here.");
    expect(messageTextSelection(select(element(container, ".katex")))?.text).toBe("$x^2$");
  });

  it("takes the formulas of a selection across table cells", () => {
    const { container } = renderReply(TABLE);
    const cells = container.querySelectorAll("tbody td");
    const first = cells[0];
    const last = cells[3];
    if (!first || !last) throw new Error("no cells");
    expect(messageTextSelection(select(first, last))?.text).toBe(
      [`Euler · $${EULER}$`, `Norm · $${NORM}$ for $v$`].join("\n"),
    );
  });
});

describe("a selection copy with math", () => {
  it("keeps the line breaks between the blocks", () => {
    const { container } = renderReply(PROSE);
    selectContents(element(container, ".message-markdown"));
    expect(copiedPlainText()).toBe(
      ["Area is $x^2$ here.", "", "one $a_1$", "two", String.raw`$$\frac{a}{b}$$`, "", "End."].join("\n"),
    );
  });
});
