import { Marked, type Token, type Tokens } from "marked";
import { attachmentReferenceAt } from "./attachment-references";
import { blockChatMath, chatMathBlockStart, chatMathStart, inlineChatMath } from "./chat-math";
import { chatTagReferences, expandChatTagReferences } from "./chat-tag-references";
import { texPreviewText } from "./tex-preview-text";

const markdown = new Marked({
  gfm: true,
  breaks: true,
  extensions: [
    {
      name: "blockMath",
      level: "block",
      start: chatMathBlockStart,
      tokenizer(source) {
        const math = blockChatMath(source);
        if (math) return { type: "blockMath", raw: math.raw, text: math.tex };
      },
    },
    {
      name: "inlineMath",
      level: "inline",
      start: chatMathStart,
      tokenizer(source) {
        const math = inlineChatMath(source);
        if (math) return { type: "inlineMath", raw: math.raw, text: math.tex };
      },
    },
    {
      name: "chatTag",
      level: "inline",
      start: (source) => source.indexOf("@["),
      tokenizer(source) {
        const file = attachmentReferenceAt(source);
        if (file) return { type: "chatTag", raw: file.marker, text: file.name };
        const reference = chatTagReferences(source)[0];
        if (reference?.start !== 0) return undefined;
        const raw = source.slice(0, reference.end);
        const text = reference.kind === "quote" ? `“${reference.name}”` : expandChatTagReferences(raw);
        return { type: "chatTag", raw, text };
      },
    },
  ],
});

const WORD_CHARACTER = /[\p{L}\p{N}]/u;

type MathText = (tex: string) => string;

const texSource: MathText = (tex) => tex;

function plainText(token: Token, lineBreak = " ", math: MathText = texSource): string {
  switch (token.type) {
    case "space":
    case "hr":
    case "def":
    case "checkbox":
      return "";
    case "br":
      return lineBreak;
    case "html":
      return token.raw.replace(/<[^>]*>/gu, " ");
    case "inlineMath":
    case "blockMath":
      return math(typeof token.text === "string" ? token.text : token.raw);
    case "list":
      return token.items.map((item: Tokens.ListItem) => plainText(item, " ", math)).join(" ");
    case "blockquote":
    case "list_item":
      return (token.tokens ?? []).map((child) => plainText(child, " ", math)).join(" ");
    case "table":
      return [token.header, ...token.rows]
        .flat()
        .map((cell) => inlineText(cell.tokens, " ", math))
        .join(" ");
  }
  if ("tokens" in token && Array.isArray(token.tokens)) return inlineText(token.tokens, lineBreak, math);
  return "text" in token && typeof token.text === "string" ? token.text : token.raw;
}

function plainTextOf(cell: { tokens: Token[] }): string {
  return inlineText(cell.tokens);
}

function inlineText(tokens: Token[], lineBreak = " ", math: MathText = texSource): string {
  let text = "";
  for (const [index, token] of tokens.entries()) {
    const next = tokens[index + 1];
    const intraword =
      token.type === "em" &&
      token.raw.startsWith("*") &&
      (WORD_CHARACTER.test(text.at(-1) ?? "") || WORD_CHARACTER.test(next?.raw.at(0) ?? ""));
    text += intraword ? token.raw : plainText(token, lineBreak, math);
  }
  return text;
}

export function markdownPreviewText(body: string): string {
  return markdown
    .lexer(body)
    .map((token) => plainText(token, " ", texPreviewText))
    .join(" ")
    .replace(/\s+/gu, " ")
    .trim();
}

const PREVIEW_SOURCE_FACTOR = 16;
const PREVIEW_ELLIPSIS = "…";
const graphemeSegmenter =
  typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : undefined;

export function textPrefix(text: string, limit: number): string {
  if (text.length <= limit) return text;
  if (!graphemeSegmenter) {
    const end = /[\uDC00-\uDFFF]/u.test(text.charAt(limit)) ? limit - 1 : limit;
    return text.slice(0, end);
  }
  let end = 0;
  for (const { index, segment } of graphemeSegmenter.segment(text)) {
    if (index + segment.length > limit) break;
    end = index + segment.length;
  }
  return text.slice(0, end);
}

export function markdownPreviewSource(body: string, limit: number): string {
  if (body.length <= limit) return body;
  const room = limit - PREVIEW_ELLIPSIS.length;
  const whole = markdownPreviewText(body.slice(0, limit * PREVIEW_SOURCE_FACTOR));
  const fallback = textPrefix(whole, room).trimEnd();
  for (let end = textPrefix(body, room).length; end > 0; end = body.slice(0, end).search(/\s+\S*$/u)) {
    const text = markdownPreviewText(body.slice(0, end));
    if (!whole.startsWith(text)) continue;
    if (text.length * 2 < fallback.length) break;
    return text === whole ? body.slice(0, end).trimEnd() : `${body.slice(0, end).trimEnd()}${PREVIEW_ELLIPSIS}`;
  }
  return fallback === whole ? fallback : `${fallback}${PREVIEW_ELLIPSIS}`;
}

const PLAIN_INLINE_TOKENS = new Set(["text", "escape", "br"]);

export function markdownSpanRanges(body: string): [number, number][] {
  const ranges: [number, number][] = [];
  let offset = 0;
  for (const token of new markdown.Lexer(markdown.defaults).inlineTokens(body)) {
    if (!PLAIN_INLINE_TOKENS.has(token.type)) ranges.push([offset, offset + token.raw.length]);
    offset += token.raw.length;
  }
  return ranges;
}

export function markdownInlinePlainText(body: string): string {
  return inlineText(new markdown.Lexer(markdown.defaults).inlineTokens(body)).replace(/\s+/gu, " ").trim();
}

function listLines(token: Tokens.List, depth: number): string[] {
  const start = typeof token.start === "number" ? token.start : 1;
  return token.items.flatMap((item, index) => {
    const marker = token.ordered ? `${start + index}.` : "•";
    const indent = "  ".repeat(depth);
    const nested = item.tokens.filter(isList);
    const text = inlineText(item.tokens.filter((child) => !isList(child)))
      .replace(/\n+/gu, " ")
      .trim();
    return [`${indent}${marker} ${text}`, ...nested.flatMap((list) => listLines(list, depth + 1))];
  });
}

function isList(token: Token): token is Tokens.List {
  return token.type === "list";
}

function blockText(token: Token): string {
  if (isList(token)) return listLines(token, 0).join("\n");
  switch (token.type) {
    case "code":
    case "blockMath":
      return typeof token.text === "string" ? token.text : token.raw;
    case "blockquote":
      return (token.tokens ?? []).map(blockText).filter(Boolean).join("\n");
    case "table":
      return [token.header, ...token.rows].map((row) => row.map(plainTextOf).join("\t")).join("\n");
    case "paragraph":
    case "heading":
    case "text":
      return inlineText(token.tokens ?? [], "\n");
  }
  return plainText(token).trim();
}

export function markdownPlainText(body: string): string {
  return markdown
    .lexer(body)
    .map(blockText)
    .filter((text) => text.trim())
    .join("\n\n")
    .trim();
}
