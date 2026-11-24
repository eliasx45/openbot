import { describe, expect, it } from "vitest";
import { mobileSearchSnippet } from "./mobile-search";

describe("a search snippet on the phone", () => {
  it("does not start inside an emoji", () => {
    const snippet = mobileSearchSnippet(`${"🙂".repeat(40)}一二三四五cache layer`, "cache layer");
    expect(snippet.charCodeAt(1)).not.toBeGreaterThanOrEqual(0xdc00);
    expect(snippet.endsWith("cache layer")).toBe(true);
  });
});
