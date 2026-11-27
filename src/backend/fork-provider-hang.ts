// Fork (docs/fork/FEATURES.md #131): whether an ACP agent's process makes progress, read from the
// process table, and whether the machine is too loaded to judge. A Gemini (`agy`) turn held open for a
// background job was ended after one slow `session/list` probe while the Mac ran at a load of 250–300
// on 10 cores (Chopper, 27 Nov 2026); the job died with it. Progress is CPU time of the agent and its
// descendants, so a job that computes keeps the agent alive even when the agent answers slowly.
import { execFile } from "node:child_process";
import { cpus, loadavg } from "node:os";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";

export interface ProcessEntry {
  pid: number;
  ppid: number;
  cpuMs: number;
  command: string;
}

/** The agent's process and its descendants by pid, or null when the table could not be read. */
export type ProcessTreeSample = ReadonlyMap<number, ProcessEntry>;

/** A process OpenBot found under a provider it ended, for the resume prompt. */
export interface ForkProviderJob {
  pid: number;
  command: string;
}

/** What a hung-provider end left behind, sent with `turn/completed` as `forkProviderRestart`. */
export interface ForkProviderRestart {
  /** Descendants still running after the agent was ended. */
  running: ForkProviderJob[];
  /** Descendants that ended with the agent. */
  ended: ForkProviderJob[];
  /** How long the agent showed no progress, in minutes. */
  silentMinutes: number;
}

const COMMAND_LIMIT = 300;
const FORK_PROVIDER_JOB_LIMIT = 20;

/** `ps` CPU time (`[[dd-]hh:]mm:ss[.cc]`) in ms, or null. */
export function parseCpuTime(text: string): number | null {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/u.exec(text.trim());
  if (!match) return null;
  const [, days = "0", hours = "0", minutes = "0", seconds = "0"] = match;
  return Math.round(((Number(days) * 24 + Number(hours)) * 3600 + Number(minutes) * 60 + Number(seconds)) * 1000);
}

/** Parses `ps -A -o pid=,ppid=,time=,command=` output. */
export function parseProcessTable(output: string): ProcessEntry[] {
  const entries: ProcessEntry[] = [];
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s?(.*)$/u.exec(line);
    if (!match) continue;
    const cpuMs = parseCpuTime(match[3] ?? "");
    if (cpuMs === null) continue;
    entries.push({ pid: Number(match[1]), ppid: Number(match[2]), cpuMs, command: (match[4] ?? "").trim() });
  }
  return entries;
}

/** `root` and every process below it by parent pid. */
export function processTree(entries: readonly ProcessEntry[], root: number): Map<number, ProcessEntry> {
  const children = new Map<number, ProcessEntry[]>();
  for (const entry of entries) {
    const list = children.get(entry.ppid);
    if (list) list.push(entry);
    else children.set(entry.ppid, [entry]);
  }
  const tree = new Map<number, ProcessEntry>();
  const self = entries.find((entry) => entry.pid === root);
  if (!self) return tree;
  const queue = [self];
  for (let entry = queue.shift(); entry; entry = queue.shift()) {
    if (tree.has(entry.pid)) continue;
    tree.set(entry.pid, entry);
    queue.push(...(children.get(entry.pid) ?? []));
  }
  return tree;
}

/** The process table now, or null (Windows, or `ps` failed). */
function readProcessTable(): Promise<ProcessEntry[] | null> {
  if (process.platform === "win32") return Promise.resolve(null);
  return new Promise((settle) =>
    execFile(
      "ps",
      ["-A", "-o", "pid=,ppid=,time=,command="],
      { maxBuffer: 16 * 1024 * 1024, timeout: 10_000 },
      (error, stdout) => settle(error ? null : parseProcessTable(stdout)),
    ),
  );
}

export async function sampleProcessTree(pid: number): Promise<ProcessTreeSample | null> {
  const table = await readProcessTable();
  return table ? processTree(table, pid) : null;
}

/**
 * Whether the tree made progress between two samples: a new process started, or the processes in
 * both used at least `minCpuMs` of CPU together. A waiting process still uses a little CPU (timers),
 * so a small growth is not progress.
 */
export function treeProgressed(before: ProcessTreeSample, after: ProcessTreeSample, minCpuMs: number): boolean {
  let grown = 0;
  for (const [pid, entry] of after) {
    const earlier = before.get(pid);
    if (!earlier) return true;
    grown += Math.max(0, entry.cpuMs - earlier.cpuMs);
  }
  return grown >= minCpuMs;
}

/** The machine is so loaded that a slow agent says nothing about a hung one: 1-min load over 4× the cores. */
export function systemOverloaded(): boolean {
  if (process.platform === "win32") return false;
  return (loadavg()[0] ?? 0) > 4 * Math.max(1, cpus().length);
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

/** The descendants of `root` in a sample (not `root` itself), at most `FORK_PROVIDER_JOB_LIMIT`. */
export function treeJobs(sample: ProcessTreeSample, root: number, redact: (text: string) => string): ForkProviderJob[] {
  return [...sample.values()]
    .filter((entry) => entry.pid !== root)
    .slice(0, FORK_PROVIDER_JOB_LIMIT)
    .map((entry) => ({ pid: entry.pid, command: redact(entry.command).slice(0, COMMAND_LIMIT) }));
}

/** Reads a `forkProviderRestart` value of a `turn/completed` notification. */
export function readForkProviderRestart(value: unknown): ForkProviderRestart | null {
  if (!isDynamicRecord(value)) return null;
  const jobs = (list: unknown): ForkProviderJob[] =>
    Array.isArray(list)
      ? list.flatMap((job: unknown) =>
          isDynamicRecord(job) && typeof job.pid === "number" && typeof job.command === "string"
            ? [{ pid: job.pid, command: job.command }]
            : [],
        )
      : [];
  return {
    running: jobs(value.running),
    ended: jobs(value.ended),
    silentMinutes: typeof value.silentMinutes === "number" ? value.silentMinutes : 0,
  };
}
