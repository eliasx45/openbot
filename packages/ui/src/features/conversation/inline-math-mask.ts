import { chatMathStart } from "@openbot/contracts/chat-math";
import { codeSpanLength, mathAt } from "@openbot/contracts/chat-table-math";

interface MaskedSource {
  source: string;
  masked: string;
  result: string;
}

const MASK_CACHE_LIMIT = 8;
const maskedSources: MaskedSource[] = [];

export function maskEmphasisInMath(source: string, masked: string): string {
  if (chatMathStart(source) === undefined) return masked;
  const known = maskedSources.find(
    (entry) =>
      entry.masked === masked &&
      entry.source.length >= source.length &&
      entry.source.slice(entry.source.length - source.length) === source,
  );
  if (known) return known.result.slice(known.result.length - source.length);
  const result = maskedMath(source, masked.slice(masked.length - source.length));
  if (maskedSources.unshift({ source, masked, result }) > MASK_CACHE_LIMIT) maskedSources.pop();
  return result;
}

function maskedMath(source: string, tail: string): string {
  const candidates = /[$\\`]/gu;
  const parts: string[] = [];
  let copied = 0;
  for (let match = candidates.exec(source); match; match = candidates.exec(source)) {
    const index = match.index;
    const math = mathAt(source, index);
    if (math) {
      const end = index + math.length;
      parts.push(tail.slice(copied, index), tail.slice(index, end).replace(/[*_~]/gu, "a"));
      copied = end;
      candidates.lastIndex = end;
      continue;
    }
    candidates.lastIndex = index + (codeSpanLength(source, index) ?? (source[index] === "\\" ? 2 : 1));
  }
  parts.push(tail.slice(copied));
  return parts.join("");
}
