// @vitest-environment node
// Fork (docs/fork/FEATURES.md #73): in the docked "Agent settings" pane, the routine editor ran past the
// pane's right edge. Its grid had one `auto` track, which grows to the min-content of the widest row:
// the Active switch with Delete, "Copy run command" and "Test run" side by side is wider than the
// pane's 360 px minimum. The track now stays inside the pane and the buttons wrap.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(
  resolve(__dirname, "../../../packages/ui/src/features/conversation/styles/agent-settings.css"),
  "utf8",
);

/** The declarations of every rule whose selector is exactly `selector`, joined. */
function declarations(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(^|\\n)${escaped}\\s*\\{([^}]*)\\}`, "g");
  return [...css.matchAll(pattern)].map((match) => match[2]).join("\n");
}

describe("the routine editor in the settings pane", () => {
  it("keeps its one grid track inside the pane", () => {
    expect(declarations(".agent-routine-editor")).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  });

  it("wraps the action buttons instead of widening the pane's content", () => {
    expect(declarations(".agent-routine-editor-actions")).toMatch(/flex-wrap:\s*wrap/);
    expect(declarations(".agent-routine-action-buttons")).toMatch(/flex-wrap:\s*wrap/);
    expect(declarations(".agent-routine-action-buttons")).not.toMatch(/flex-wrap:\s*nowrap/);
  });
});
