/**
 * Fork (docs/fork/FEATURES.md #135, "Team watchdogs and guards"): the plain-code check that a lead
 * agent can put on a request with `openbot.send_message` (`check`), run when the teammate replies with
 * "Status: done". It runs in the lead's workspace: a file that must exist (and not be empty), or a
 * shell command that must exit 0 within a timeout, at a low priority (`nice`), as the Mac is often
 * loaded by the swarm's own renders.
 */

import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";

export type TeamCheck = { kind: "file"; path: string } | { kind: "command"; command: string };

export interface TeamCheckResult {
  passed: boolean;
  /** What the check found, short: the end of the command's output, or the file's state. */
  output: string;
}

export const TEAM_CHECK_PATH_LIMIT = 1_000;
export const TEAM_CHECK_COMMAND_LIMIT = 2_000;
const OUTPUT_LIMIT = 1_200;
const OUTPUT_KEEP = 64_000;

/** Test switch `OPENBOT_FORK_TEAM_CHECK_TIMEOUT_MS`; 2 minutes by default. */
function teamCheckTimeoutMs(): number {
  const value = Number(process.env.OPENBOT_FORK_TEAM_CHECK_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : 120_000;
}

/** The check of a `send_message` call, or an error text for the agent. */
export function parseTeamCheck(value: unknown): TeamCheck | string | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isDynamicRecord(value)) return 'check must be {kind:"file", path} or {kind:"command", command}.';
  const record = value;
  if (record.kind === "file") {
    const path = typeof record.path === "string" ? record.path.trim() : "";
    if (!path || path.length > TEAM_CHECK_PATH_LIMIT)
      return `check.path must be a file path of 1 to ${TEAM_CHECK_PATH_LIMIT} characters.`;
    return { kind: "file", path };
  }
  if (record.kind === "command") {
    const command = typeof record.command === "string" ? record.command.trim() : "";
    if (!command || command.length > TEAM_CHECK_COMMAND_LIMIT)
      return `check.command must be a shell command of 1 to ${TEAM_CHECK_COMMAND_LIMIT} characters.`;
    return { kind: "command", command };
  }
  return 'check.kind must be "file" or "command".';
}

export function describeTeamCheck(check: TeamCheck): string {
  return check.kind === "file" ? `file ${check.path} exists` : `command \`${check.command}\` exits 0`;
}

export async function runTeamCheck(
  check: TeamCheck,
  cwd: string,
  timeoutMs = teamCheckTimeoutMs(),
): Promise<TeamCheckResult> {
  return check.kind === "file" ? fileCheck(check.path, cwd) : commandCheck(check.command, cwd, timeoutMs);
}

function expandHome(path: string): string {
  return path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

async function fileCheck(path: string, cwd: string): Promise<TeamCheckResult> {
  const expanded = expandHome(path);
  const absolute = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
  try {
    const found = await stat(absolute);
    if (found.isFile() && found.size === 0) return { passed: false, output: `${absolute} is an empty file.` };
    return {
      passed: true,
      output: found.isDirectory() ? `${absolute} is a folder.` : `${absolute} exists (${found.size} bytes).`,
    };
  } catch {
    return { passed: false, output: `${absolute} does not exist.` };
  }
}

function commandCheck(command: string, cwd: string, timeoutMs: number): Promise<TeamCheckResult> {
  return new Promise((done) => {
    let output = "";
    let timedOut = false;
    const child = spawn("nice", ["-n", "10", "/bin/sh", "-c", command], {
      cwd,
      env: process.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const keep = (chunk: Buffer) => {
      output = `${output}${chunk.toString("utf8")}`.slice(-OUTPUT_KEEP);
    };
    child.stdout?.on("data", keep);
    child.stderr?.on("data", keep);
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, timeoutMs);
    timer.unref?.();
    const finish = (code: number | null, error?: Error) => {
      clearTimeout(timer);
      const tail = tailText(output);
      if (error) done({ passed: false, output: `The check could not start: ${error.message}` });
      else if (timedOut)
        done({
          passed: false,
          output: `Timed out after ${Math.round(timeoutMs / 1000)} s.${tail ? ` Output: ${tail}` : ""}`,
        });
      else
        done({
          passed: code === 0,
          output: code === 0 ? tail || "exit 0" : `exit ${code ?? "signal"}${tail ? `: ${tail}` : ""}`,
        });
    };
    child.once("error", (error) => finish(null, error));
    child.once("close", (code) => finish(code));
  });
}

function tailText(text: string): string {
  const flat = text.trim();
  return flat.length > OUTPUT_LIMIT ? `…${flat.slice(-OUTPUT_LIMIT)}` : flat;
}
