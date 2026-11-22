// Fork (docs/fork/FEATURES.md #89). Checks that a jump to a late message in a long chat, while the
// agent works, moves only the transcript: the chat pane keeps its header at the top and its message
// box at the bottom. Before the fix, the working line's `.sr-only` status escaped the transcript clip,
// the pane (`overflow: hidden`) became scrollable, and the jump scrolled the pane up: the header went
// off screen and a gap opened under the message box. It runs in a running Storybook against the real
// app on the preview mock. Read-only. Pass the URL that `bun run storybook` reports:
// `bun scripts/chat-pane-shift-e2e.ts --storybook=http://localhost:6006`.
// Writes .openbot-build/chat-pane-shift-e2e/report.json and a screenshot before and after the jumps.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type Page } from "playwright-core";

const OUT = resolve(import.meta.dirname, "../.openbot-build/chat-pane-shift-e2e");
const STORY = "app--agent-works-in-long-chat";
const TOLERANCE = 1;
const storybook = process.argv.find((arg) => arg.startsWith("--storybook="))?.slice("--storybook=".length);
assert.ok(storybook, "Pass --storybook=<url> with the URL that `bun run storybook` reports.");

interface PaneState {
  headerTop: number;
  /** From the bottom of the message box to the bottom of the window. */
  gapUnderComposer: number;
  /** Each element above the header that is scrolled, as `class=scrollTop`. */
  scrolledAncestors: string[];
  /** Each element above the header that could be scrolled by a script, with its extra height. */
  scrollableAncestors: string[];
}

interface JumpResult {
  jump: string;
  before: PaneState;
  after: PaneState;
}

const report: { story: string; jumps: JumpResult[]; passed: boolean; error?: string } = {
  story: STORY,
  jumps: [],
  passed: false,
};

function paneState(page: Page): Promise<PaneState> {
  return page.evaluate(() => {
    const header = document.querySelector(".conversation-panel > .conversation-header");
    const composer = document.querySelector(".conversation-panel > .composer-wrap .composer");
    if (!header || !composer) throw new Error("The chat has no header or no message box.");
    const scrolledAncestors: string[] = [];
    const scrollableAncestors: string[] = [];
    for (let element = header.parentElement; element; element = element.parentElement) {
      const name = String(element.className).split(" ")[0] || element.tagName.toLowerCase();
      if (element.scrollTop !== 0) scrolledAncestors.push(`${name}=${element.scrollTop}`);
      const overflow = getComputedStyle(element).overflowY;
      const extra = element.scrollHeight - element.clientHeight;
      if (overflow !== "visible" && overflow !== "clip" && extra > 0) scrollableAncestors.push(`${name}+${extra}`);
    }
    return {
      headerTop: header.getBoundingClientRect().top,
      gapUnderComposer: window.innerHeight - composer.getBoundingClientRect().bottom,
      scrolledAncestors,
      scrollableAncestors,
    };
  });
}

/** The next two frames: the scroll and the layout after it are done. */
function frames(page: Page): Promise<void> {
  return page.evaluate(
    () => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
  );
}

/**
 * The jumps that the app makes to a late part of the chat: a message jump (search, notification,
 * reply link) centres the row, as `conversation-scope.ts` does, and a reveal shows the working line.
 */
const JUMPS: Record<string, string> = {
  "centre the last message": "[data-chat-search-message]",
  "show the working line at the top": ".conversation-live .agent-activity-entry",
};

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", args: ["--disable-smooth-scrolling"] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`${storybook}/iframe.html?id=${STORY}&viewMode=story`, { timeout: 180_000 });
  // The agent works: its working line is under the last message, and the chat scrolls far.
  await page.locator(".conversation-live .agent-activity-entry").first().waitFor({ timeout: 120_000 });
  await page.waitForFunction(
    () => {
      const scroll = document.querySelector<HTMLElement>(".conversation-panel > .conversation-scroll");
      return scroll ? scroll.scrollHeight - scroll.clientHeight > 1_000 : false;
    },
    null,
    { timeout: 60_000 },
  );
  await frames(page);
  await page.screenshot({ path: resolve(OUT, "before.png") });
  for (const [jump, selector] of Object.entries(JUMPS)) {
    const before = await paneState(page);
    await page.evaluate(
      ({ selector, block }) => {
        const targets = document.querySelectorAll(`.conversation-panel > .conversation-scroll ${selector}`);
        const target = targets[targets.length - 1];
        if (!target) throw new Error(`No ${selector} in the chat.`);
        target.scrollIntoView({ behavior: "auto", block, inline: "nearest" });
      },
      { selector, block: jump.startsWith("centre") ? ("center" as const) : ("start" as const) },
    );
    await frames(page);
    const after = await paneState(page);
    report.jumps.push({ jump, before, after });
  }
  await page.screenshot({ path: resolve(OUT, "after.png") });
  const failures = report.jumps.flatMap(({ jump, before, after }) => [
    ...(after.scrolledAncestors.length
      ? [`${jump}: the pane around the chat scrolled (${after.scrolledAncestors.join(", ")}).`]
      : []),
    ...(Math.abs(after.headerTop - before.headerTop) > TOLERANCE
      ? [`${jump}: the chat header moved from ${before.headerTop}px to ${after.headerTop}px.`]
      : []),
    ...(Math.abs(after.gapUnderComposer - before.gapUnderComposer) > TOLERANCE
      ? [
          `${jump}: the gap under the message box went from ${before.gapUnderComposer}px to ${after.gapUnderComposer}px.`,
        ]
      : []),
    ...(after.scrollableAncestors.length
      ? [`${jump}: a pane around the chat can be scrolled (${after.scrollableAncestors.join(", ")}).`]
      : []),
  ]);
  report.passed = failures.length === 0;
  if (failures.length) report.error = failures.join("\n");
  assert.equal(failures.length, 0, failures.join("\n"));
} finally {
  writeFileSync(resolve(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report)}\n`);
  await browser.close();
}
