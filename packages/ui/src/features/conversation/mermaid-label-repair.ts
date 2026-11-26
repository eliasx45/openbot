// Fork #122: agents often write flowchart labels such as `MAIL[hello@site.com]` or `-->|a@b|`.
// Mermaid reads `@` (and other characters) as syntax unless the label is quoted, so the whole
// diagram fails. When a flowchart does not parse, the chat retries once with every unquoted
// node and edge label wrapped in quotes, which Mermaid always reads as plain text.

const SHAPES: ReadonlyArray<readonly [string, string]> = [
  ["[[", "]]"],
  ["[(", ")]"],
  ["((", "))"],
  ["([", "])"],
  ["{{", "}}"],
  ["[", "]"],
  ["(", ")"],
  ["{", "}"],
];

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const shapePattern = SHAPES.map(([open, close]) => `${escapeRegExp(open)}(?!")([^"\\n]*?)${escapeRegExp(close)}`).join(
  "|",
);

// A quoted string is matched first and kept as is, so text inside quotes is never rewritten.
const TOKEN = new RegExp(`"[^"\\n]*"|\\b([A-Za-z0-9_]+)(?:${shapePattern})|\\|(?!")([^|"\\n]+)\\|`, "g");

const FLOWCHART_HEADER = /^\s*(?:flowchart|graph)\b/;

function isFlowchart(source: string): boolean {
  const body = source.replace(/^\s*---\n[\s\S]*?\n---\s*\n/, "");
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("%%")) continue;
    return FLOWCHART_HEADER.test(trimmed);
  }
  return false;
}

/** Returns the flowchart with its unquoted labels quoted, or undefined when nothing would change. */
export function quoteFlowchartLabels(source: string): string | undefined {
  if (!isFlowchart(source)) return undefined;
  let changed = false;
  const repaired = source.replace(TOKEN, (match: string, ...groups: unknown[]) => {
    if (match.startsWith('"')) return match;
    const id = groups[0];
    if (typeof id === "string") {
      for (const [index, [open, close]] of SHAPES.entries()) {
        const label = groups[index + 1];
        if (typeof label !== "string") continue;
        if (label.trim() === "") return match;
        changed = true;
        return `${id}${open}"${label}"${close}`;
      }
      return match;
    }
    const edge = groups[SHAPES.length + 1];
    if (typeof edge !== "string" || edge.trim() === "") return match;
    changed = true;
    return `|"${edge}"|`;
  });
  return changed ? repaired : undefined;
}
