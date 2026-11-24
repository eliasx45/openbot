import { chatMathStart, inlineChatMath } from "@openbot/contracts/chat-math";
import { texPreviewText } from "@openbot/contracts/tex-preview-text";

export function liveActivityMarkdown(source: string, limit: number): string {
  return truncateMarkdown(inlineText(blockText(source)), limit);
}

function blockText(source: string): string {
  const parts: string[] = [];
  let fence: { marker: string; math: boolean; lines: string[] } | null = null;
  for (const line of source.replace(/\r\n?/gu, "\n").split("\n")) {
    const opening = /^\s{0,3}(`{3,}(?!.*`)|~{3,})\s*([\w-]*)/u.exec(line);
    if (!fence && opening?.[1]) {
      fence = { marker: opening[1], math: opening[2] === "math", lines: [] };
      continue;
    }
    if (fence) {
      if (line.trim().startsWith(fence.marker)) {
        parts.push(fenceText(fence));
        fence = null;
      } else fence.lines.push(line.trim());
      continue;
    }
    const text = blockLine(line);
    if (text) parts.push(text);
  }
  if (fence) parts.push(fenceText(fence));
  return parts.join(" ");
}

function fenceText(fence: { math: boolean; lines: string[] }): string {
  const content = fence.lines.filter(Boolean).join(" ");
  if (!content) return "";
  return fence.math ? escapeMarkdown(texPreviewText(content)) : codeSpan(content);
}

function blockLine(line: string): string {
  let text = line.trim();
  if (!text) return "";
  if (/^(?:[-*_]\s*){3,}$/u.test(text) || /^\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?$/u.test(text)) return "";
  const heading = /^#{1,6}\s+(.*?)(?:\s+#+)?$/u.exec(text);
  if (heading?.[1]) return `**${heading[1].replaceAll("**", "")}**`;
  text = text.replace(/^(?:>\s?)+/u, "");
  const task = /^[-*+]\s+\[([ xX])\]\s+/u.exec(text);
  if (task) return `${task[1] === " " ? "☐" : "☑"} ${text.slice(task[0].length)}`;
  text = text.replace(/^[-*+]\s+/u, "• ");
  if (text.startsWith("|")) {
    return text
      .replace(/^\||\|$/gu, "")
      .split("|")
      .map((cell) => cell.trim())
      .filter(Boolean)
      .join(" · ");
  }
  return text;
}

function inlineText(source: string): string {
  let result = "";
  let rest = source;
  while (rest) {
    const code = /`+/u.exec(rest);
    const math = chatMathStart(rest);
    const next = Math.min(code?.index ?? rest.length, math ?? rest.length);
    result += inlineMarks(rest.slice(0, next));
    rest = rest.slice(next);
    if (!rest) break;
    if (code && code.index === next) {
      const end = rest.indexOf(code[0], code[0].length);
      if (end > 0) {
        result += rest.slice(0, end + code[0].length);
        rest = rest.slice(end + code[0].length);
        continue;
      }
    } else {
      const found = inlineChatMath(rest);
      if (found) {
        result += escapeMarkdown(texPreviewText(found.tex));
        rest = rest.slice(found.raw.length);
        continue;
      }
    }
    result += escapeMarkdown(rest.charAt(0));
    rest = rest.slice(1);
  }
  return result.replace(/\s+/gu, " ").trim();
}

function inlineMarks(text: string): string {
  return text
    .replace(/<br\s*\/?>/giu, " ")
    .replace(/<(https?:\/\/[^>]+)>/gu, "$1")
    .replace(/<\/?[A-Za-z][^>]*>/gu, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/__(?=\S)(.+?)(?<=\S)__/gu, "**$1**");
}

function codeSpan(content: string): string {
  return content.includes("`") ? `\`\` ${content} \`\`` : `\`${content}\``;
}

function escapeMarkdown(text: string): string {
  return text.replace(/[\\*_`~[\]]/gu, (character) => `\\${character}`);
}

function truncateMarkdown(text: string, limit: number): string {
  const marks: string[] = [];
  let visible = 0;
  let index = 0;
  const total = visibleLength(text);
  if (total <= limit) return text;
  while (index < text.length && visible < limit - 1) {
    const character = text.charAt(index);
    if (character === "\\" && index + 1 < text.length) {
      index += 2;
      visible += 1;
      continue;
    }
    const run = /^`+/u.exec(text.slice(index))?.[0];
    if (run) {
      const end = text.indexOf(run, index + run.length);
      if (end > 0) {
        const content = Array.from(text.slice(index + run.length, end));
        const room = limit - 1 - visible;
        if (content.length > room) {
          return `${text.slice(0, index + run.length)}${content.slice(0, room).join("")}${run}…${closing(marks)}`;
        }
        visible += content.length;
        index = end + run.length;
        continue;
      }
    }
    const mark = text.startsWith("**", index)
      ? "**"
      : text.startsWith("~~", index)
        ? "~~"
        : character === "*"
          ? "*"
          : null;
    if (mark) {
      if (marks.at(-1) === mark) marks.pop();
      else marks.push(mark);
      index += mark.length;
      continue;
    }
    const point = text.codePointAt(index) ?? 0;
    index += point > 0xffff ? 2 : 1;
    visible += 1;
  }
  return `${text.slice(0, index).trimEnd()}…${closing(marks)}`;
}

function closing(marks: readonly string[]): string {
  return [...marks].reverse().join("");
}

function visibleLength(text: string): number {
  const plain = text
    .replace(/\\(.)/gu, "$1")
    .replace(/\*\*|~~|`+/gu, "")
    .replace(/\*/gu, "");
  return Array.from(plain).length;
}
