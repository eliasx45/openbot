// Fork: checks the own Claude sign-in folder (`src/backend/fork-claude-home.ts`).
// 1. Against a fake `~/.claude` (`CLAUDE_CONFIG_DIR` in a temp folder): each entry is linked except
//    the ones that hold the sign-in, a second start links only what is new and keeps what the CLI
//    made in the folder, and the Claude driver's sign-in command points the CLI at the folder.
// 2. With the real Claude CLI and the user's real `~/.claude` as the source: the folder sees the
//    user's settings through the links but not the sign-in (`auth status` says signed out, so it
//    spends no token and nothing on the computer changes).
// `bun scripts/fork-claude-home-e2e.ts`. Writes .openbot-build/fork-claude-home-e2e/report.json.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readlinkSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { forkClaudeHomeEnvironment, prepareForkClaudeHome } from "../src/backend/fork-claude-home";
import { BUILT_IN_PROVIDER_DRIVERS } from "../src/backend/provider-drivers";

const OUT = resolve(import.meta.dirname, "../.openbot-build/fork-claude-home-e2e");
const root = await mkdtemp(join(tmpdir(), "openbot-fork-claude-home-"));
interface Report {
  startedAt: string;
  fake?: string;
  real?: { loggedIn: boolean; linked: boolean } | string;
  result?: string;
  error?: string;
}
const report: Report = { startedAt: new Date().toISOString() };

try {
  // 1. Fake source.
  const source = join(root, "dot-claude");
  await mkdir(join(source, "projects"), { recursive: true });
  await mkdir(join(source, "skills"), { recursive: true });
  await mkdir(join(source, "backups"), { recursive: true });
  for (const name of ["CLAUDE.md", "settings.json", ".claude.json", ".credentials.json", ".credentials.lock"])
    await writeFile(join(source, name), "{}");
  process.env.CLAUDE_CONFIG_DIR = source;
  assert.deepEqual(forkClaudeHomeEnvironment(), {}, "no folder before the start");

  const folder = join(root, "fork-claude-home");
  await runCauseEffect(prepareForkClaudeHome(folder));
  for (const name of ["CLAUDE.md", "settings.json", "projects", "skills"]) {
    assert.ok(lstatSync(join(folder, name)).isSymbolicLink(), `${name} is linked`);
    assert.equal(readlinkSync(join(folder, name)), join(source, name));
  }
  for (const name of [".claude.json", ".credentials.json", ".credentials.lock", "backups"])
    assert.ok(!existsSync(join(folder, name)), `${name} is not linked`);
  assert.deepEqual(forkClaudeHomeEnvironment(), { CLAUDE_CONFIG_DIR: folder });

  // A second start: a new entry of the source is linked, an entry the CLI made in the folder is kept.
  await mkdir(join(source, "agents"));
  await writeFile(join(folder, ".claude.json"), '{"own":true}');
  await mkdir(join(folder, "sessions"));
  await mkdir(join(source, "sessions"));
  await runCauseEffect(prepareForkClaudeHome(folder));
  assert.ok(lstatSync(join(folder, "agents")).isSymbolicLink(), "a later entry is linked");
  assert.ok(!lstatSync(join(folder, ".claude.json")).isSymbolicLink(), "the folder's own settings stay");
  assert.ok(!lstatSync(join(folder, "sessions")).isSymbolicLink(), "a folder the CLI made stays");

  // The driver: the own sign-in's command.
  const claude = BUILT_IN_PROVIDER_DRIVERS.find((driver) => driver.id === "claude");
  assert.ok(claude?.signIn?.kind === "cli-command");
  const cli = { executable: "claude", version: "0", source: "system" } as const;
  assert.equal(claude.signIn.command.env(cli, "global").CLAUDE_CONFIG_DIR, folder, "own sign-in uses the folder");
  report.fake = "passed";

  // 2. Real CLI against the user's real ~/.claude.
  const real = join(homedir(), ".claude");
  if (existsSync(real)) {
    delete process.env.CLAUDE_CONFIG_DIR;
    const realFolder = join(root, "real-fork-claude-home");
    await runCauseEffect(prepareForkClaudeHome(realFolder));
    assert.ok(lstatSync(join(realFolder, "projects")).isSymbolicLink(), "saved sessions are shared");
    const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CONFIG_DIR: realFolder };
    for (const name of Object.keys(env))
      if (/^(CLAUDE_CODE_|ANTHROPIC_|USE_(LOCAL|STAGING)_OAUTH$|CLAUDECODE$)/.test(name)) delete env[name];
    // `auth status` exits 1 when signed out and still prints its status.
    let stdout: string;
    try {
      stdout = execFileSync("claude", ["auth", "status", "--json"], { env, encoding: "utf8", timeout: 20_000 });
    } catch (error) {
      stdout = error instanceof Error && "stdout" in error ? String(error.stdout ?? "") : "";
    }
    const status: { loggedIn?: boolean } = JSON.parse(stdout.trim() || "{}");
    assert.equal(status.loggedIn, false, "the folder does not see the sign-in of ~/.claude");
    report.real = { loggedIn: status.loggedIn, linked: existsSync(join(realFolder, "CLAUDE.md")) };
  } else report.real = "skipped: no ~/.claude";
  report.result = "passed";
} catch (error) {
  report.result = "failed";
  report.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  await rm(root, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(
    `${report.result === "passed" ? "PASS" : "FAIL"} fork-claude-home-e2e: ${JSON.stringify(report)}\n`,
  );
}
