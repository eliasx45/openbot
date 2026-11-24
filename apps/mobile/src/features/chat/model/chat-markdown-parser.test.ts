import type { Token, Tokens } from "marked";
import { describe, expect, it } from "vitest";
import { parseFinishedChatMarkdown, parseStreamingChatMarkdown } from "./chat-markdown-parser";

const PMATRIX = String.raw`\begin{pmatrix}1&-2&-1\\-1&1&0\\-1&0&-1\end{pmatrix}`;
const BMATRIX = String.raw`\begin{bmatrix}a&b\\c&d\end{bmatrix}`;
const UNIT_BALL = String.raw`\{v \in \mathbb{R}^3 : \|v\| \le 1\}`;
const NORM = String.raw`\|x\|_2`;

function tableBody(cell: string): string {
  return ["| Matrix | Value |", "|---|---|", `| case | ${cell} |`].join("\n");
}

function bodyRow(tokens: Token[]): Tokens.TableCell[] {
  const table = tokens.find((token): token is Tokens.Table => token.type === "table");
  if (!table) throw new Error("no table");
  const row = table.rows[0];
  if (!row) throw new Error("no table row");
  return row;
}

function mathIn(cell: Tokens.TableCell | undefined): string[] {
  return (cell?.tokens ?? []).flatMap((token) => (token.type === "inlineMath" ? [String(token.text)] : []));
}

function plainIn(cell: Tokens.TableCell | undefined): string {
  return (cell?.tokens ?? []).map((token) => (token.type === "inlineMath" ? "" : token.raw)).join("");
}

describe.each([
  ["a finished reply", parseFinishedChatMarkdown],
  ["a streaming reply", parseStreamingChatMarkdown],
])("math in a table cell of %s", (_name, parse) => {
  it("keeps the escaped bars of a norm in the formula, and they do not split the cell", () => {
    const row = bodyRow(parse(tableBody(`$${UNIT_BALL}$`)));
    expect(row).toHaveLength(2);
    expect(mathIn(row[1])).toEqual([UNIT_BALL]);
  });

  it("keeps a matrix with its row breaks", () => {
    expect(mathIn(bodyRow(parse(tableBody(`$${PMATRIX}$`)))[1])).toEqual([PMATRIX]);
  });

  it("keeps two formulas in one cell", () => {
    expect(mathIn(bodyRow(parse(tableBody(`$${NORM}$ and $${BMATRIX}$`)))[1])).toEqual([NORM, BMATRIX]);
  });

  it("keeps display math in a cell", () => {
    expect(mathIn(bodyRow(parse(tableBody(`$$${NORM}$$`)))[1])).toEqual([NORM]);
  });

  it("unescapes a bar outside the formula and in a code span as before", () => {
    const cell = bodyRow(parse(tableBody(`${String.raw`a \| b, `}$${NORM}$, ${"`x\\|y`"}`)))[1];
    expect(mathIn(cell)).toEqual([NORM]);
    expect(plainIn(cell)).toBe("a | b, , `x|y`");
  });

  it("still splits the cell at a bar that is not escaped", () => {
    const row = bodyRow(parse(tableBody("$|x|$")));
    expect(row).toHaveLength(2);
    expect(row.flatMap(mathIn)).toEqual([]);
  });
});

describe("a tagged attachment in a message", () => {
  it("shows the file name without the tag marker", () => {
    const [paragraph] = parseFinishedChatMarkdown("Review @[report final.pdf](attachment:att-42) before noon");
    const tokens: Token[] = paragraph?.type === "paragraph" ? (paragraph.tokens ?? []) : [];
    expect(tokens.map((token) => token.type)).not.toContain("link");
    expect(tokens.map((token) => ("text" in token ? token.text : token.raw)).join("")).toBe(
      "Review report final.pdf before noon",
    );
  });
});
