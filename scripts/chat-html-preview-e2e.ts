import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

const OUT = resolve(import.meta.dirname, "../.openbot-build/chat-html-preview-e2e");
const STORY = "conversation-messagebody--html-preview-sizes";
const DEFAULT_HEIGHT = 160;
const MAX_HEIGHT = 420;
const storybook = process.argv.find((arg) => arg.startsWith("--storybook="))?.slice("--storybook=".length);
assert.ok(storybook, "Pass --storybook=<url> with the URL that `bun run storybook` reports.");

interface FrameSize {
  title: string;
  frame: number;
  scrollHeight: number;
  lastBottom: number;
}

interface AnchorJump {
  frameTopBefore: number;
  frameTopAfter: number;
  pageScroll: number;
  targetTop: number;
}

const report: { story: string; frames: FrameSize[]; anchor?: AnchorJump; passed: boolean; error?: string } = {
  story: STORY,
  frames: [],
  passed: false,
};

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ channel: "chrome" });
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  await page.goto(`${storybook}/iframe.html?id=${STORY}&viewMode=story`, { timeout: 180_000 });
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll<HTMLIFrameElement>("iframe")].filter(
        (frame) => frame.contentDocument?.readyState === "complete" && frame.style.length > 0,
      ).length === 3,
    null,
    { timeout: 120_000 },
  );
  await page.waitForTimeout(1_000);
  report.frames = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLIFrameElement>("iframe")].map((frame) => {
      const page = frame.contentDocument;
      return {
        title: page?.body.innerText.split("\n")[0] ?? "",
        frame: Math.round(frame.getBoundingClientRect().height),
        scrollHeight: page?.documentElement.scrollHeight ?? 0,
        lastBottom: Math.round(page?.body.lastElementChild?.getBoundingClientRect().bottom ?? 0),
      };
    }),
  );
  await page.screenshot({ path: resolve(OUT, "sizes.png"), fullPage: true });
  const longFrame = page.locator("iframe").nth(2);
  await longFrame.scrollIntoViewIfNeeded();
  const frameTopBefore = await longFrame.evaluate((frame) => Math.round(frame.getBoundingClientRect().top));
  await longFrame.contentFrame().getByRole("link", { name: "Late batches" }).click();
  await page.waitForFunction(() => (document.querySelectorAll("iframe")[2]?.contentWindow?.scrollY ?? 0) > 0, null, {
    timeout: 10_000,
  });
  report.anchor = await longFrame.evaluate((frame, before) => {
    const view = frame instanceof HTMLIFrameElement ? frame.contentWindow : null;
    return {
      frameTopBefore: before,
      frameTopAfter: Math.round(frame.getBoundingClientRect().top),
      pageScroll: Math.round(view?.scrollY ?? 0),
      targetTop: Math.round(view?.document.getElementById("late")?.getBoundingClientRect().top ?? -1),
    };
  }, frameTopBefore);
  await page.screenshot({ path: resolve(OUT, "anchor.png") });
  const anchor = report.anchor;
  const [card, short, long] = report.frames;
  assert.ok(card && short && long, "The story shows three HTML previews.");
  const failures = [
    ...(card.frame <= DEFAULT_HEIGHT && card.lastBottom <= card.frame
      ? []
      : [
          `The centred card got a ${card.frame}px frame (card ends at ${card.lastBottom}px); at most ${DEFAULT_HEIGHT}px.`,
        ]),
    ...(short.scrollHeight <= short.frame && short.frame < DEFAULT_HEIGHT
      ? []
      : [`The short page (${short.scrollHeight}px) got a ${short.frame}px frame.`]),
    ...(long.frame === MAX_HEIGHT && long.scrollHeight > MAX_HEIGHT
      ? []
      : [
          `The long page (${long.scrollHeight}px) got a ${long.frame}px frame; ${MAX_HEIGHT}px with a scroll expected.`,
        ]),
    ...(anchor.frameTopAfter === anchor.frameTopBefore
      ? []
      : [
          `The link to #late moved the chat: the preview went from ${anchor.frameTopBefore}px to ${anchor.frameTopAfter}px.`,
        ]),
    ...(anchor.targetTop >= 0 && anchor.targetTop < MAX_HEIGHT / 2
      ? []
      : [`The link to #late left its heading at ${anchor.targetTop}px in the preview.`]),
  ];
  report.passed = failures.length === 0;
  if (failures.length) report.error = failures.join("\n");
  assert.equal(failures.length, 0, failures.join("\n"));
} finally {
  writeFileSync(resolve(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report)}\n`);
  await browser.close();
}
