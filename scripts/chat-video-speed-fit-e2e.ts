// Fork (docs/fork/FEATURES.md #87). Checks that the title line of a chat video (name, − · 1× · +,
// size, width × height) fits the video at every width: nothing runs past the line's edge and the name
// keeps room for a few letters. A video that the user sends shows small (about 190 px wide), and there
// the speed control used to squeeze the name to nothing and push "1280 × 720" past the edge.
// It runs in a running Storybook on the story "One video, narrow chat", and makes the chat column
// narrower step by step. Read-only. Pass the URL that `bun run storybook` reports:
// `bun scripts/chat-video-speed-fit-e2e.ts --storybook=http://localhost:6006`.
// Writes .openbot-build/chat-video-speed-fit-e2e/report.json and a screenshot per width.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

const OUT = resolve(import.meta.dirname, "../.openbot-build/chat-video-speed-fit-e2e");
const STORY = "conversation-chat-video-attachments--one-video-narrow";
/** Chat column widths: the video is the column minus 34 px, from a sent video's size to a wide one. */
const WIDTHS = [224, 260, 300, 340, 420, 632];
/** The name may get shorter, down to this many pixels (a few letters and "…"), but not to nothing. */
const MIN_NAME_PX = 24;
const storybook = process.argv.find((arg) => arg.startsWith("--storybook="))?.slice("--storybook=".length);
assert.ok(storybook, "Pass --storybook=<url> with the URL that `bun run storybook` reports.");

interface LinePart {
  text: string;
  width: number;
  /** How far the part runs past the right edge of the line's content box; above 0 is cut off. */
  past: number;
}

interface WidthResult {
  column: number;
  video: number;
  parts: LinePart[];
}

const report: { story: string; widths: WidthResult[]; passed: boolean; error?: string } = {
  story: STORY,
  widths: [],
  passed: false,
};

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ channel: "chrome" });
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  await page.goto(`${storybook}/iframe.html?id=${STORY}&viewMode=story`, { timeout: 180_000 });
  // The line has the name, the speed control, the size and, once the video's metadata is in, its size in pixels.
  await page.waitForFunction(() => (document.querySelector(".media-stage-details")?.children.length ?? 0) >= 4, null, {
    timeout: 120_000,
  });
  for (const column of WIDTHS) {
    const result = await page.evaluate((width) => {
      const main = document.querySelector<HTMLElement>("main.foundation-story");
      const line = document.querySelector<HTMLElement>(".media-stage-details");
      if (!main || !line) throw new Error("The story has no chat column or no video title line.");
      main.style.width = `${width}px`;
      // The line shows on hover; its layout is the same while it is hidden.
      line.style.opacity = "1";
      const box = line.getBoundingClientRect();
      const contentRight = box.right - Number.parseFloat(getComputedStyle(line).paddingRight);
      const parts = [...line.children]
        .filter((part) => getComputedStyle(part).display !== "none")
        .map((part) => {
          const rect = part.getBoundingClientRect();
          return {
            text: part.textContent ?? "",
            width: Math.round(rect.width),
            past: Math.round(rect.right - contentRight),
          };
        });
      return { column: width, video: Math.round(box.width), parts };
    }, column);
    report.widths.push(result);
    await page
      .locator(".media-generation-stage")
      .first()
      .screenshot({ path: resolve(OUT, `video-${column}.png`) });
  }
  const failures = report.widths.flatMap(({ video, parts }) => {
    const name = parts[0];
    const speed = parts.find((part) => /×$/.test(part.text));
    return [
      ...parts
        .filter((part) => part.past > 0)
        .map((part) => `video ${video}px: "${part.text}" runs ${part.past}px past the edge of the title line.`),
      ...(speed ? [] : [`video ${video}px: the speed control is not shown.`]),
      ...(name && name !== speed && name.width < MIN_NAME_PX
        ? [`video ${video}px: the name "${name.text}" is ${name.width}px wide.`]
        : []),
    ];
  });
  report.passed = failures.length === 0;
  if (failures.length) report.error = failures.join("\n");
  assert.equal(failures.length, 0, failures.join("\n"));
} finally {
  writeFileSync(resolve(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report)}\n`);
  await browser.close();
}
