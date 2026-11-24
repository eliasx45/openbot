import type { AgentMessage } from "@openbot/ui/data";
import { MarkdownMessageText } from "@openbot/ui/features/conversation/MarkdownMessageText";
import { MessageBody } from "@openbot/ui/features/conversation/MessageRendering";
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { beforeAll, describe, expect, it, vi } from "vitest";

const PMATRIX = String.raw`\begin{pmatrix}1&-2&-1\\-1&1&0\\-1&0&-1\end{pmatrix}`;
const BMATRIX = String.raw`\begin{bmatrix}a&b\\c&d\end{bmatrix}`;
const SCALED_MATRIX = String.raw`\frac{1}{\sqrt{2}}\begin{pmatrix}1&1\\1&-1\end{pmatrix}`;
const UNIT_BALL = String.raw`\{v \in \mathbb{R}^3 : \|v\| \le 1\}`;
const COLUMN = String.raw`\begin{bmatrix}1\\2\end{bmatrix}`;

function tableBody(cell: string): string {
  return ["| Matrix | Value |", "|---|---|", `| case | ${cell} |`].join("\n");
}

function replyMessage(body: string): AgentMessage {
  return { id: "table-math-reply", author: "agent", body, time: "11:21", attachments: [] };
}

function renderReply(body: string) {
  return render(() => (
    <MessageBody
      message={replyMessage(body)}
      agents={[]}
      onSelectAgent={vi.fn()}
      onOpenLink={vi.fn()}
      onPreview={vi.fn()}
      onAttachmentAction={vi.fn()}
    />
  ));
}

function renderMarkdown(body: string) {
  return render(() => <MarkdownMessageText body={body} agents={[]} onSelectAgent={vi.fn()} onOpenLink={vi.fn()} />);
}

function bodyRow(container: HTMLElement): HTMLTableRowElement {
  const row = container.querySelector("tbody tr");
  if (!(row instanceof HTMLTableRowElement)) throw new Error("no table row");
  return row;
}

function valueCell(container: HTMLElement): HTMLTableCellElement {
  const cell = bodyRow(container).cells[1];
  if (!cell) throw new Error("no value cell");
  return cell;
}

function typesetTex(cell: Element): string[] {
  return Array.from(cell.querySelectorAll("annotation"), (annotation) => annotation.textContent ?? "");
}

beforeAll(async () => {
  const { container } = renderMarkdown("$x$");
  await waitFor(() => expect(typesetTex(container)).toEqual(["x"]));
  cleanup();
});

describe.each([
  ["a reply's table", renderReply],
  ["a Markdown table", renderMarkdown],
])("math in %s", (_name, renderTable) => {
  it("typesets a pmatrix with its row breaks", () => {
    const { container } = renderTable(tableBody(`$${PMATRIX}$`));
    expect(typesetTex(valueCell(container))).toEqual([PMATRIX]);
    expect(valueCell(container).textContent).not.toContain("$");
  });

  it("typesets a bmatrix with its row breaks and column separators", () => {
    const { container } = renderTable(tableBody(`$${BMATRIX}$`));
    expect(typesetTex(valueCell(container))).toEqual([BMATRIX]);
  });

  it("typesets a fraction next to a matrix", () => {
    const { container } = renderTable(tableBody(`$${SCALED_MATRIX}$`));
    expect(typesetTex(valueCell(container))).toEqual([SCALED_MATRIX]);
  });

  it("keeps escaped braces and an escaped bar in the formula, and the bar does not split the cell", () => {
    const { container } = renderTable(tableBody(`$${UNIT_BALL}$`));
    expect(bodyRow(container).cells).toHaveLength(2);
    expect(typesetTex(valueCell(container))).toEqual([UNIT_BALL]);
  });

  it("typesets two formulas in one cell", () => {
    const { container } = renderTable(tableBody(`$A$ and $${BMATRIX}$`));
    expect(typesetTex(valueCell(container))).toEqual(["A", BMATRIX]);
  });

  it("typesets display math in a cell", () => {
    const { container } = renderTable(tableBody(`$$${PMATRIX}$$`));
    expect(typesetTex(valueCell(container))).toEqual([PMATRIX]);
  });

  it("keeps a backslash escape in the text outside the formula", () => {
    const { container } = renderTable(tableBody(String.raw`x \\ y, $${COLUMN}$`));
    expect(typesetTex(valueCell(container))).toEqual([COLUMN]);
    expect(valueCell(container).textContent).toMatch(/^x \\ y, /u);
  });

  it("shows escaped text without math as before", () => {
    const { container } = renderTable(tableBody(`${String.raw`a \\ b, \*not bold\* costs $5.00, `}\`a\\|b\``));
    expect(typesetTex(valueCell(container))).toEqual([]);
    expect(valueCell(container).textContent).toBe(String.raw`a \ b, *not bold* costs $5.00, a|b`);
  });

  it("still splits the cell at a bar that is not escaped", () => {
    const { container } = renderTable(tableBody("$|x|$"));
    expect(bodyRow(container).cells).toHaveLength(2);
    expect(typesetTex(bodyRow(container))).toEqual([]);
  });
});

describe("copying a reply's table with math", () => {
  it("copies the formulas as they were written", async () => {
    const writeText = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    renderReply(
      ["| Matrix | Value |", "|---|---|", `| $A$ (std) | $${PMATRIX}$ |`, `| ball | $${UNIT_BALL}$ |`].join("\n"),
    );

    fireEvent.click(screen.getByText("Copy as Markdown"));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText.mock.calls[0]?.[0]).toBe(
      ["| Matrix | Value |", "| --- | --- |", `| $A$ (std) | $${PMATRIX}$ |`, `| ball | $${UNIT_BALL}$ |`].join("\n"),
    );
  });
});
