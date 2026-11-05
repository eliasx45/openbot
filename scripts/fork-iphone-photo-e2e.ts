// Fork (docs/fork/FEATURES.md entry 36): end-to-end check of "From iPhone" on a running dev app, without
// an iPhone. Start the app with a test image, which the helper converts instead of opening the menu:
//
//   OPENBOT_FORK_IPHONE_PHOTO_TEST_IMAGE=/path/photo.jpg bun run dev
//   bun scripts/fork-iphone-photo-e2e.ts [--port=9333]
//
// It checks the helper's own outcomes, the main-process call, and the + menu: "From iPhone" adds the
// photo to the draft as an image. The report goes to .openbot-build/fork-iphone-photo-e2e.json.
// The live Continuity Camera menu needs an iPhone near the Mac and is not part of this check.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";

const port = Number(process.argv.find((arg) => arg.startsWith("--port="))?.slice(7) ?? 9333);
const root = join(import.meta.dir, "..");
const outDir = join(root, ".openbot-build");
const helper = join(root, ".openbot-build/iphone-photo/OpenBot iPhone Photo.app/Contents/MacOS/OpenBotIphonePhoto");
const checks: { name: string; ok: boolean; detail: unknown }[] = [];

function check(name: string, ok: boolean, detail: unknown): void {
  checks.push({ name, ok, detail });
  process.stdout.write(`${ok ? "PASS" : "FAIL"} ${name} ${JSON.stringify(detail)}\n`);
}

function runHelper(args: string[]): string {
  return spawnSync(helper, args, { encoding: "utf8", timeout: 10_000 }).stdout.trim();
}

async function main(): Promise<void> {
  check("helper app is built", existsSync(helper), { helper });
  const image = process.env.OPENBOT_FORK_IPHONE_PHOTO_TEST_IMAGE ?? "";
  const out = join(tmpdir(), `fork-iphone-photo-e2e-${process.pid}.jpg`);
  const picked = runHelper([out, "--test-image", image]);
  check("helper writes a JPEG", picked === '{"outcome":"picked"}' && existsSync(out) && statSync(out).size > 0, {
    picked,
  });
  rmSync(out, { force: true });
  check(
    "helper reports a missing image",
    runHelper([out, "--test-image", "/nonexistent.jpg"]) === '{"outcome":"failed"}',
    {},
  );
  check("helper reports missing arguments", runHelper([]) === '{"outcome":"failed"}', {});

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page = browser
    .contexts()
    .flatMap((context) => context.pages())
    .find((candidate) => new URL(candidate.url()).pathname === "/");
  if (!page) throw new Error("The main window is not open.");

  const result = await page.evaluate(async () => {
    const photo = await window.openbot.agent.takeIphonePhoto();
    return photo.outcome === "picked" ? { outcome: photo.outcome, name: photo.name, size: photo.bytes.length } : photo;
  });
  check(
    "main returns the photo",
    result.outcome === "picked" && "name" in result && /^iPhone photo .+\.jpg$/u.test(result.name) && result.size > 0,
    result,
  );

  // The + menu of the open chat: "From iPhone" puts the photo in the draft.
  await page.getByRole("button", { name: "Add to prompt" }).first().click();
  const item = page.getByRole("menuitem", { name: "From iPhone" });
  check("the + menu has From iPhone", (await item.count()) === 1, {});
  await item.click();
  const chip = page.getByText(/iPhone photo .+\.jpg/u).first();
  const shown = await chip
    .waitFor({ timeout: 20_000 })
    .then(() => true)
    .catch(() => false);
  check("the photo joins the draft", shown, { text: shown ? await chip.textContent() : null });
  await page.screenshot({ path: join(outDir, "fork-iphone-photo-e2e.png") });

  const report = { at: new Date().toISOString(), passed: checks.every((entry) => entry.ok), checks };
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "fork-iphone-photo-e2e.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(report.passed ? "ALL PASSED\n" : "SOME FAILED\n");
  await browser.close();
  if (!report.passed) process.exitCode = 1;
}

await main();
