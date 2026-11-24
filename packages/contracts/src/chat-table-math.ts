import type { Lexer, Tokens } from "marked";
import { inlineChatMath } from "./chat-math";

export function splitTableRow(source: string): string[] {
  const cells: string[] = [];
  let start = 0;
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\\") {
      index += 1;
    } else if (source[index] === "|") {
      cells.push(source.slice(start, index));
      start = index + 1;
    }
  }
  cells.push(source.slice(start));
  return cells;
}

export function mapTextOutsideMath(cell: string, mapText: (text: string) => string): string {
  let result = "";
  let text = "";
  let index = 0;
  while (index < cell.length) {
    const math = mathAt(cell, index);
    if (math) {
      result += mapText(text) + math;
      text = "";
      index += math.length;
      continue;
    }
    const length = codeSpanLength(cell, index) ?? (cell[index] === "\\" ? 2 : 1);
    text += cell.slice(index, index + length);
    index += length;
  }
  return result + mapText(text);
}

export function keepMathInTableCells(table: Tokens.Table, lexer: Lexer): void {
  const lines = table.raw.split("\n");
  [table.header, ...table.rows].forEach((cells, row) => {
    const line = lines[row === 0 ? 0 : row + 1];
    if (!line?.includes("\\|")) return;
    const sources = markdownRowCells(line);
    cells.forEach((cell, column) => {
      const source = sources[column];
      if (source === undefined || markdownCellText(source) !== cell.text) return;
      const text = mapTextOutsideMath(source, markdownCellText);
      if (text === cell.text) return;
      cell.text = text;
      cell.tokens = lexer.inline(text);
    });
  });
}

function mathAt(cell: string, index: number): string | undefined {
  if (cell[index] !== "$" && !cell.startsWith("\\(", index) && !cell.startsWith("\\[", index)) return undefined;
  return inlineChatMath(cell.slice(index))?.raw;
}

function codeSpanLength(cell: string, index: number): number | undefined {
  if (cell[index] !== "`") return undefined;
  let fence = index;
  while (cell[fence] === "`") fence += 1;
  const width = fence - index;
  for (let cursor = fence; cursor < cell.length; ) {
    if (cell[cursor] !== "`") {
      cursor += 1;
      continue;
    }
    let end = cursor;
    while (cell[end] === "`") end += 1;
    if (end - cursor === width) return end - index;
    cursor = end;
  }
  return width;
}

function markdownRowCells(line: string): string[] {
  const cells = splitTableRow(line);
  if (!cells[0]?.trim()) cells.shift();
  if (!cells.at(-1)?.trim()) cells.pop();
  return cells.map((cell) => cell.trim());
}

function markdownCellText(source: string): string {
  return source.replace(/\\\|/gu, "|");
}
