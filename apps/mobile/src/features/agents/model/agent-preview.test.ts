import { describe, expect, it } from "vitest";
import { agentPreviewLine } from "./agent-preview";

describe("an agent's last message in the phone's lists", () => {
  it("shows a Codex reply's citations as the desktop sidebar does", () => {
    expect(
      agentPreviewLine(
        'Fixed **the parser** in :codex-file-citation{path="/repo/src/parser.ts" line_range_start=3}\u{e200}cite\u{e202}turn0search1\u{e201}.',
      ),
    ).toBe("Fixed the parser in parser.ts.");
  });
});
