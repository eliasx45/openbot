const BLOCK_DISPLAY = /^(block|flex|grid|flow-root|list-item|table|table-row|table-caption|table-.+-group)$/u;
const KEPT_SPACES = /^(pre|pre-wrap|break-spaces)$/u;

interface TextPart {
  text: string;
  collapsible: boolean;
}

export function formulaSource(formula: Element): string | null {
  const tex = formula.querySelector(".katex-mathml annotation")?.textContent;
  if (!tex) return null;
  return formula.parentElement?.classList.contains("katex-display") === true ? `$$${tex}$$` : `$${tex}$`;
}

export function rangeHasFormula(range: Range): boolean {
  const common = range.commonAncestorContainer;
  const root = common instanceof Element ? common : common.parentElement;
  if (!root) return false;
  if (root.closest(".katex")) return true;
  return Array.from(root.querySelectorAll(".katex")).some((formula) => range.intersectsNode(formula));
}

export function rangeTextWithFormulas(range: Range): string {
  const parts: Array<TextPart | number> = [];
  const common = range.commonAncestorContainer;
  const formula = (common instanceof Element ? common : common.parentElement)?.closest(".katex");
  if (formula) addFormula(formula, parts);
  else if (common instanceof Text) addText(common, range, parts);
  else if (common instanceof Element) addChildren(common, range, parts);
  return joinedParts(parts);
}

function addChildren(element: Element, range: Range, parts: Array<TextPart | number>): void {
  for (const child of element.childNodes) {
    if (!range.intersectsNode(child)) continue;
    if (child instanceof Text) addText(child, range, parts);
    else if (child instanceof Element) addElement(child, range, parts);
  }
}

function addElement(element: Element, range: Range, parts: Array<TextPart | number>): void {
  if (element.classList.contains("katex")) {
    addFormula(element, parts);
    return;
  }
  if (element.getAttribute("aria-hidden") === "true") return;
  const style = getComputedStyle(element);
  if (style.display === "none") return;
  if (element.localName === "br") {
    parts.push({ text: "\n", collapsible: false });
    return;
  }
  const lines = element.localName === "p" ? 2 : BLOCK_DISPLAY.test(style.display) ? 1 : 0;
  if (style.display === "table-cell" && element.previousElementSibling) parts.push({ text: "\t", collapsible: false });
  if (lines > 0) parts.push(lines);
  addChildren(element, range, parts);
  if (lines > 0) parts.push(lines);
}

function addFormula(formula: Element, parts: Array<TextPart | number>): void {
  const source = formulaSource(formula);
  if (source) parts.push({ text: source, collapsible: false });
}

function addText(node: Text, range: Range, parts: Array<TextPart | number>): void {
  const owner = node.parentElement;
  if (!owner) return;
  const style = getComputedStyle(owner);
  if (style.userSelect === "none" || style.visibility === "hidden") return;
  const start = node === range.startContainer ? range.startOffset : 0;
  const end = node === range.endContainer ? range.endOffset : node.data.length;
  const value = node.data.slice(start, end);
  if (KEPT_SPACES.test(style.whiteSpace)) parts.push({ text: value, collapsible: false });
  else if (style.whiteSpace === "pre-line") parts.push({ text: value.replace(/[\t ]+/gu, " "), collapsible: true });
  else parts.push({ text: value.replace(/\s+/gu, " "), collapsible: true });
}

function joinedParts(parts: ReadonlyArray<TextPart | number>): string {
  let text = "";
  let lineBreaks = 0;
  for (const part of parts) {
    if (typeof part === "number") {
      lineBreaks = Math.max(lineBreaks, part);
      continue;
    }
    const lineStart = !text || lineBreaks > 0 || text.endsWith("\n");
    const value = part.collapsible && (lineStart || /\s$/u.test(text)) ? part.text.replace(/^ +/u, "") : part.text;
    if (!value) continue;
    if (lineBreaks > 0 && text) text = `${text.replace(/ +$/u, "")}${"\n".repeat(lineBreaks)}`;
    lineBreaks = 0;
    text += value;
  }
  return text.replace(/ +$/u, "");
}
