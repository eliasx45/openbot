import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { CuaDriverRuntime } from "./cua-driver-runtime";

// Fork #88: the "Let agents use my Chrome profile" switch adds `--grant existing-profile` to the
// daemon, read at each start. Off, the daemon gets the arguments OpenBot always gave it.

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function runtimeWith(existingChromeProfile: () => boolean) {
  // Short, because a Unix socket path has a length limit.
  const directory = await mkdtemp(join(tmpdir(), "cua-"));
  directories.push(directory);
  const spawned: (readonly string[])[] = [];
  const runtime = new CuaDriverRuntime({
    executable: process.execPath,
    endpoint: { kind: "unix-socket", directory },
    supported: true,
    hostBundleId: "test",
    platform: process.platform,
    existingChromeProfile,
    // A real process that waits, so `running()` and the stop are those of a real child.
    spawnProcess: (_command, args): ChildProcess => {
      spawned.push(args);
      return spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], { stdio: ["pipe", "pipe", "pipe"] });
    },
    waitForSocket: async () => undefined,
  });
  return { runtime, spawned, socket: join(directory, "driver.sock") };
}

describe("Computer Use driver and the user's Chrome profile", () => {
  it("starts the daemon with today's arguments while the switch is off", async () => {
    const { runtime, spawned, socket } = await runtimeWith(() => false);
    await Effect.runPromise(runtime.start());
    try {
      expect(spawned).toEqual([["serve", "--socket", socket, "--no-overlay"]]);
      expect(runtime.existingChromeProfileGranted()).toBe(false);
    } finally {
      await Effect.runPromise(runtime.stop());
    }
  });

  it("adds the existing-profile grant to the daemon while the switch is on", async () => {
    const { runtime, spawned, socket } = await runtimeWith(() => true);
    await Effect.runPromise(runtime.start());
    try {
      expect(spawned).toEqual([["serve", "--socket", socket, "--no-overlay", "--grant", "existing-profile"]]);
      expect(runtime.existingChromeProfileGranted()).toBe(true);
    } finally {
      await Effect.runPromise(runtime.stop());
    }
    expect(runtime.existingChromeProfileGranted()).toBe(false);
  });

  it("reads the switch at each start, not while the daemon runs", async () => {
    let enabled = false;
    const { runtime, spawned } = await runtimeWith(() => enabled);
    await Effect.runPromise(runtime.start());
    enabled = true;
    expect(runtime.existingChromeProfileGranted()).toBe(false);
    await Effect.runPromise(runtime.stop());
    await Effect.runPromise(runtime.start());
    try {
      expect(spawned.map((args) => args.includes("existing-profile"))).toEqual([false, true]);
      expect(runtime.existingChromeProfileGranted()).toBe(true);
    } finally {
      await Effect.runPromise(runtime.stop());
    }
  });
});
