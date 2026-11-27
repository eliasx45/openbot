// @vitest-environment node
// Fork (docs/fork/FEATURES.md #135, "Team watchdogs and guards"): the check a lead puts on a request
// runs in the lead's workspace: a file that must exist and not be empty, or a command that must exit 0
// in time.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { describeTeamCheck, parseTeamCheck, runTeamCheck } from "./fork-team-check";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "team-check-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("runTeamCheck", () => {
  it("passes a file that exists, from the workspace, and a folder", async () => {
    writeFileSync(join(dir, "out.mp4"), "frames");
    mkdirSync(join(dir, "renders"));
    expect(await runTeamCheck({ kind: "file", path: "out.mp4" }, dir)).toEqual({
      passed: true,
      output: `${join(dir, "out.mp4")} exists (6 bytes).`,
    });
    expect((await runTeamCheck({ kind: "file", path: join(dir, "renders") }, "/")).passed).toBe(true);
  });

  it("fails a missing or empty file", async () => {
    writeFileSync(join(dir, "empty.json"), "");
    expect(await runTeamCheck({ kind: "file", path: "gone.mp4" }, dir)).toEqual({
      passed: false,
      output: `${join(dir, "gone.mp4")} does not exist.`,
    });
    expect((await runTeamCheck({ kind: "file", path: "empty.json" }, dir)).output).toContain("empty file");
  });

  it("runs a command in the workspace and passes on exit 0", async () => {
    writeFileSync(join(dir, "score.txt"), "0.93");
    expect(await runTeamCheck({ kind: "command", command: "cat score.txt" }, dir)).toEqual({
      passed: true,
      output: "0.93",
    });
  });

  it("fails on another exit code with the end of the output", async () => {
    const result = await runTeamCheck({ kind: "command", command: "echo 2 tests failed >&2; exit 1" }, dir);
    expect(result).toEqual({ passed: false, output: "exit 1: 2 tests failed" });
  });

  it("stops a command that runs too long", async () => {
    const started = Date.now();
    const result = await runTeamCheck({ kind: "command", command: "echo started; sleep 20" }, dir, 300);
    expect(result.passed).toBe(false);
    expect(result.output).toContain("Timed out after 0 s. Output: started");
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe("parseTeamCheck", () => {
  it("takes the two kinds and explains what is wrong", () => {
    expect(parseTeamCheck(undefined)).toBeUndefined();
    expect(parseTeamCheck({ kind: "file", path: " a.mp4 " })).toEqual({ kind: "file", path: "a.mp4" });
    expect(parseTeamCheck({ kind: "command", command: "bun test" })).toEqual({ kind: "command", command: "bun test" });
    expect(parseTeamCheck("a.mp4")).toContain("check must be");
    expect(parseTeamCheck({ kind: "file" })).toContain("check.path");
    expect(describeTeamCheck({ kind: "command", command: "bun test" })).toBe("command `bun test` exits 0");
  });
});
