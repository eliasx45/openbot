// @vitest-environment node
// Fork (docs/fork/FEATURES.md #79): a chat dragged into another sidebar folder lit the folder with a
// blue fill, and the solid headers of the folder (and of the folders in it) cut that fill into bands.
// The drop target is now only a blue outline: no fill on the folder or its headers, the outline drawn
// by the folder's ::after and, for a folder, the top part by its header's ::before.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const styles = resolve(__dirname, "styles");
const css = ["app-shell.css", "fork-sidebar.css"].map((file) => readFileSync(resolve(styles, file), "utf8")).join("\n");

/** Every rule whose selector mentions the section drop target, as `selector { declarations }`. */
const dropRules = [...css.matchAll(/(^|\n)([^{}\n][^{}]*)\{([^}]*)\}/g)]
  .map((match) => ({ selector: (match[2] ?? "").trim(), body: match[3] ?? "" }))
  .filter((rule) => rule.selector.includes("sidebar-section-agent-drop-target"));

describe("the sidebar folder drop target", () => {
  it("has no fill on the folder or on its headers", () => {
    expect(dropRules.length).toBeGreaterThan(0);
    for (const rule of dropRules) expect(rule.body, rule.selector).not.toMatch(/background/);
  });

  it("draws the outline as a layer, so no header in the folder cuts it", () => {
    const outline = dropRules.find(
      (rule) => /::after$/.test(rule.selector) && !rule.selector.includes(".sidebar-folder"),
    );
    expect(outline?.body).toMatch(/inset:\s*0/);
    expect(outline?.body).toMatch(/box-shadow:\s*inset 0 0 0 1px var\(--sidebar-drop-outline\)/);
    expect(outline?.body).toMatch(/pointer-events:\s*none/);
  });

  it("splits a folder's outline at its 32px header, with the folder's part under a stuck header", () => {
    const header = dropRules.find((rule) => rule.selector.endsWith("> header::before"));
    const body = dropRules.find(
      (rule) => rule.selector.includes(".sidebar-folder") && rule.selector.endsWith("::after"),
    );
    expect(header?.body).toMatch(/inset 0 1px 0 var\(--sidebar-drop-outline\)/);
    expect(body?.body).toMatch(/top:\s*32px/);
    expect(body?.body).toMatch(/z-index:\s*1;/);
    expect(body?.body).toMatch(/inset 0 -1px 0 var\(--sidebar-drop-outline\)/);
  });
});
