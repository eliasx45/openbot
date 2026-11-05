// Fork (docs/fork/FEATURES.md entry 36): "From iPhone" in the message box's + menu. Starts the helper app
// (native/macos/iphone-photo), which opens macOS Continuity Camera's menu at the pointer and writes the
// photo taken on the iPhone to a file. The photo goes back to the renderer as bytes, which adds it to
// the draft the way it adds a pasted image.

import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { IphonePhotoResult } from "@openbot/contracts/ipc";
import { app } from "electron";

/** How long the helper waits for the photo after a choice in the menu, in seconds. */
const WAIT_SECONDS = 120;
const HELPER_OUTCOMES = new Set(["picked", "dismissed", "noDevice", "timeout", "failed"]);

export interface IphonePhotoService {
  take(): Promise<IphonePhotoResult>;
  dispose(): void;
}

function helperPath(): string {
  const root = app.isPackaged ? join(process.resourcesPath, "iphone-photo") : resolve(".openbot-build/iphone-photo");
  return join(root, "OpenBot iPhone Photo.app", "Contents", "MacOS", "OpenBotIphonePhoto");
}

/** The time of the photo in the file name, as "iPhone photo 2026-11-05 20.14.03.jpg". */
function photoName(now: Date): string {
  const two = (value: number) => String(value).padStart(2, "0");
  const day = `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;
  return `iPhone photo ${day} ${two(now.getHours())}.${two(now.getMinutes())}.${two(now.getSeconds())}.jpg`;
}

/**
 * `testImage` (env `OPENBOT_FORK_IPHONE_PHOTO_TEST_IMAGE`, end-to-end checks only): the helper converts
 * that file and opens no menu.
 */
export function createIphonePhotoService(options: { testImage?: string | undefined } = {}): IphonePhotoService {
  let running: ChildProcess | undefined;

  async function take(): Promise<IphonePhotoResult> {
    const helper = helperPath();
    if (process.platform !== "darwin" || !existsSync(helper)) return { outcome: "unavailable" };
    // One menu at a time: a second click replaces the first.
    running?.kill();
    const out = join(app.getPath("temp"), `openbot-iphone-photo-${randomUUID()}.jpg`);
    const args = [out, "--wait", String(WAIT_SECONDS)];
    if (options.testImage) args.push("--test-image", options.testImage);
    const outcome = await new Promise<string>((done) => {
      const child = spawn(helper, args, { stdio: ["ignore", "pipe", "inherit"] });
      running = child;
      let output = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        output += chunk.toString("utf8");
      });
      // The helper stops itself after its wait; this is only for a helper that hangs.
      const stop = setTimeout(() => child.kill(), (WAIT_SECONDS + 30) * 1000);
      child.on("error", () => done("failed"));
      child.on("close", () => {
        clearTimeout(stop);
        if (running === child) running = undefined;
        // The helper took the focus to own the menu. Give it back to OpenBot's window, so the person
        // can type at once. (A replaced helper is not the running one: the newer menu keeps the focus.)
        if (running === undefined && !options.testImage) app.focus({ steal: true });
        const match = /"outcome":"([A-Za-z]+)"/u.exec(output);
        done(match?.[1] && HELPER_OUTCOMES.has(match[1]) ? match[1] : "dismissed");
      });
    });
    try {
      if (outcome === "picked") {
        const bytes = await readFile(out).catch(() => undefined);
        if (!bytes?.length) return { outcome: "failed" };
        return { outcome, name: photoName(new Date()), bytes: new Uint8Array(bytes) };
      }
      if (outcome === "noDevice" || outcome === "timeout" || outcome === "failed") return { outcome };
      return { outcome: "dismissed" };
    } finally {
      await rm(out, { force: true });
    }
  }

  return {
    take,
    dispose: () => {
      running?.kill();
      running = undefined;
    },
  };
}
