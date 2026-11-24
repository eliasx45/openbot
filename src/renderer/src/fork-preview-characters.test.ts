// @vitest-environment node
import { plainPreview } from "@openbot/team-client/agent-notifications";
import { describe, expect, it } from "vitest";
import { snippetAround } from "../../../packages/ui/src/components/global-search-text";

const FAMILY = "👨‍👩‍👧‍👦";

function segments(text: string): string[] {
  return Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text), (part) => part.segment);
}

describe("cutting a preview at whole characters", () => {
  it("does not split an emoji at the end of a notification", () => {
    const body = plainPreview(`${"word ".repeat(39)}ab${FAMILY} and the rest of the reply goes on for a while.`);
    expect(body?.endsWith("…")).toBe(true);
    const shown = segments(body ?? "");
    expect(shown.filter((segment) => segment.includes("👨")).every((segment) => segment === FAMILY)).toBe(true);
  });

  it("does not start a search snippet inside an emoji", () => {
    const text = `${"🙂".repeat(30)}一二三四五六七八九cache layer`;
    const snippet = snippetAround(text, "cache layer");
    expect(snippet.charCodeAt(1)).not.toBeGreaterThanOrEqual(0xdc00);
    expect(snippet.startsWith("…")).toBe(true);
    expect(snippet.endsWith("cache layer")).toBe(true);
  });
});
