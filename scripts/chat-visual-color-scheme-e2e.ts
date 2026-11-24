import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type Frame, type Page } from "playwright-core";

const OUT = resolve(import.meta.dirname, "../.openbot-build/chat-visual-color-scheme-e2e");
const STORY = "conversation-chatvisual--plain-form";
const storybook = process.argv.find((arg) => arg.startsWith("--storybook="))?.slice("--storybook=".length);
assert.ok(storybook, "Pass --storybook=<url> with the URL that `bun run storybook` reports.");

type Scheme = "light" | "dark";

interface PageLook {
  app: Scheme;
  frame: string;
  page: string;
  button: string;
  input: string;
}

const report: { story: string; looks: PageLook[]; passed: boolean; error?: string } = {
  story: STORY,
  looks: [],
  passed: false,
};

async function pageLook(page: Page, frame: Frame, app: Scheme): Promise<PageLook> {
  return {
    app,
    frame: await page.$eval("iframe[title='Order a batch']", (element) => getComputedStyle(element).colorScheme),
    ...(await frame.evaluate(() => {
      const control = (selector: string) => {
        const element = document.querySelector(selector);
        return element ? getComputedStyle(element).backgroundColor : "";
      };
      return {
        page: getComputedStyle(document.documentElement).colorScheme,
        button: control("button"),
        input: control("input"),
      };
    })),
  };
}

async function setAppScheme(page: Page, scheme: Scheme): Promise<void> {
  await page.evaluate((value) => document.documentElement.setAttribute("data-openbot-color-scheme", value), scheme);
}

function lightness(color: string): number {
  const [red = 0, green = 0, blue = 0] = (color.match(/[\d.]+/gu) ?? []).map(Number);
  return (red + green + blue) / 3;
}

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ channel: "chrome" });
try {
  const page = await browser.newPage({ viewport: { width: 760, height: 520 } });
  await page.goto(`${storybook}/iframe.html?id=${STORY}&viewMode=story&globals=colorScheme:light`, {
    timeout: 180_000,
  });
  const frameElement = page.locator("iframe[title='Order a batch']");
  await frameElement.waitFor({ timeout: 120_000 });
  const frame = await (await frameElement.elementHandle())?.contentFrame();
  assert.ok(frame, "The visual has no frame.");
  await frame.waitForSelector("button", { timeout: 60_000 });
  report.looks.push(await pageLook(page, frame, "light"));
  await page.screenshot({ path: resolve(OUT, "light.png") });
  await setAppScheme(page, "dark");
  await frame
    .waitForFunction(() => getComputedStyle(document.documentElement).colorScheme === "dark", null, {
      timeout: 5_000,
    })
    .catch(() => undefined);
  report.looks.push(await pageLook(page, frame, "dark"));
  await page.screenshot({ path: resolve(OUT, "dark.png") });
  await setAppScheme(page, "light");
  await frame
    .waitForFunction(() => getComputedStyle(document.documentElement).colorScheme === "light", null, {
      timeout: 5_000,
    })
    .catch(() => undefined);
  report.looks.push(await pageLook(page, frame, "light"));
  const failures = report.looks.flatMap((look, index) => {
    const dark = look.app === "dark";
    const wrong = (color: string) => lightness(color) > 128 === dark;
    return [
      ...(look.page === look.app ? [] : [`Step ${index + 1}: the app is ${look.app}, the page is ${look.page}.`]),
      ...(look.frame === look.page
        ? []
        : [`Step ${index + 1}: the frame is ${look.frame} and the page ${look.page}, so the frame is not clear.`]),
      ...(wrong(look.button) ? [`Step ${index + 1}: the ${look.app} app shows a ${look.button} button.`] : []),
      ...(wrong(look.input) ? [`Step ${index + 1}: the ${look.app} app shows a ${look.input} field.`] : []),
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
