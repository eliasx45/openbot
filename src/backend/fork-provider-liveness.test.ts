// @vitest-environment node
// Fork (docs/fork/FEATURES.md #131): a Gemini (Antigravity) agent is ended as hung only when it shows
// no progress (no output, no probe answer, no CPU growth of its process tree) for the hang window,
// time under heavy machine load does not count, and a turn that already answered is never failed.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sourceText } from "@openbot/i18n/source";
import { afterEach, describe, expect, it } from "vitest";
import { installFakeAgent, readJsonl, startThread, stopClients } from "../../scripts/provider-fakes/host";
import { AcpAgentClient } from "./acp-client";
import { ANTIGRAVITY_ACP_FLAVOR } from "./acp-flavor-antigravity";
import type { AgentClient } from "./agent-client";
import { runCauseEffect } from "./effect-boundary";
import {
  type ForkProviderRestart,
  type ProcessEntry,
  type ProcessTreeSample,
  parseCpuTime,
  parseProcessTable,
  processAlive,
  processTree,
  readForkProviderRestart,
  sampleProcessTree,
  treeProgressed,
} from "./fork-provider-hang";
import { type AppServerNotification, getRecord, getString } from "./protocol";

const STALL_MS = 300;
const REQUEST_TIMEOUT_MS = 1_500;
const GAP_MS = 100;
const HANG_MS = 3_000;

const roots: string[] = [];
const clients: AgentClient[] = [];
const jobs: number[] = [];

afterEach(async () => {
  await stopClients(clients.splice(0));
  for (const pid of jobs.splice(0)) if (processAlive(pid)) process.kill(pid, "SIGKILL");
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const sleep = (ms: number) => new Promise((settle) => setTimeout(settle, ms));

interface Ended {
  status: string | null;
  error: string | null;
  restart: ForkProviderRestart | null;
}

/** A real `AcpAgentClient` with Antigravity's flavor over the fake `agy` of `slow-probe.ts`. */
async function open(
  env: Readonly<Record<string, string>>,
  options: { sample?: (pid: number) => Promise<ProcessTreeSample | null>; overloaded?: () => boolean } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "openbot-acp-liveness-"));
  roots.push(root);
  const log = join(root, "agent.jsonl");
  const executable = join(root, "bin", "antigravity");
  await installFakeAgent(executable, "slow-probe", { FAKE_LOG: log, ...env });
  const client = new AcpAgentClient({ executable, version: "1.5.17", source: "managed" }, REQUEST_TIMEOUT_MS, {
    provider: "antigravity",
    flavor: ANTIGRAVITY_ACP_FLAVOR,
    argv: ["acp"],
    env: {},
    signInMessage: "Sign in to the fake agent.",
    turnStallMs: STALL_MS,
    hangMs: HANG_MS,
    hangProbeGapMs: GAP_MS,
    ...(options.sample ? { sampleProcessTree: options.sample } : {}),
    // This Mac's own load must not pause the clock in a test.
    systemOverloaded: options.overloaded ?? (() => false),
  });
  clients.push(client);
  client.start();
  const thread = await startThread(client, { cwd: root });
  let ended: Ended | null = null;
  let error: string | null = null;
  client.on("notification", (notification: AppServerNotification) => {
    if (getString(notification.params, "threadId") !== thread) return;
    if (notification.method === "error") error = getString(notification.params, "message");
    if (notification.method === "turn/completed")
      ended = {
        status: getString(getRecord(notification.params, "turn"), "status"),
        error,
        restart: readForkProviderRestart(getRecord(notification.params, "forkProviderRestart")),
      };
  });
  const start = async (text: string) => {
    await runCauseEffect(
      client.request(
        "turn/start",
        { threadId: thread, input: [{ type: "text", text, text_elements: [] }] },
        (value) => value,
      ),
    );
    return Date.now();
  };
  const events = async (event: string) =>
    (await readJsonl<{ event: string; text?: string }>(log)).filter((entry) => entry.event === event);
  return { client, thread, start, ended: () => ended, events };
}

async function until<T>(read: () => T | null | Promise<T | null>, what: string, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await sleep(20);
  }
}

/** A sample of one process whose CPU time is `cpu()`. */
const flat = (cpu: () => number) => async (pid: number) =>
  new Map<number, ProcessEntry>([[pid, { pid, ppid: 1, cpuMs: cpu(), command: "agy acp" }]]);

describe("process tree reading (fork #131)", () => {
  it("reads ps CPU times and builds the tree below a pid", () => {
    expect(parseCpuTime("0:01.50")).toBe(1_500);
    expect(parseCpuTime("12:03.00")).toBe(723_000);
    expect(parseCpuTime("1:02:03")).toBe(3_723_000);
    expect(parseCpuTime("2-01:00:00")).toBe(176_400_000);
    expect(parseCpuTime("-")).toBeNull();
    const table = parseProcessTable(
      [
        "  10     1   0:01.00 /usr/bin/agy acp",
        "  11    10   5:00.00 python train.py --epochs 40",
        "  12    11   0:00.10 sleep 5",
        "  13     1   0:09.00 unrelated",
      ].join("\n"),
    );
    const tree = processTree(table, 10);
    expect([...tree.keys()]).toEqual([10, 11, 12]);
    expect(tree.get(11)?.command).toBe("python train.py --epochs 40");
  });

  it("counts a new process or enough CPU as progress, not a waiting process's crumbs", () => {
    const entry = (pid: number, cpuMs: number): [number, ProcessEntry] => [pid, { pid, ppid: 1, cpuMs, command: "" }];
    const before = new Map([entry(10, 1_000), entry(11, 5_000)]);
    expect(treeProgressed(before, new Map([entry(10, 1_010), entry(11, 5_000)]), 300)).toBe(false);
    expect(treeProgressed(before, new Map([entry(10, 1_000), entry(11, 5_400)]), 300)).toBe(true);
    expect(treeProgressed(before, new Map([entry(10, 1_000), entry(11, 5_000), entry(12, 0)]), 300)).toBe(true);
    // A job that ended takes no progress back.
    expect(treeProgressed(before, new Map([entry(10, 1_000)]), 300)).toBe(false);
  });
});

describe("ACP hang watch (fork #131)", () => {
  it("keeps an agent whose probes time out while its process tree uses CPU", async () => {
    let cpu = 0;
    const agent = await open(
      { FAKE_SILENT_LISTS: "999" },
      {
        sample: flat(() => {
          cpu += 5_000;
          return cpu;
        }),
      },
    );
    await agent.start("hold-60000");
    await until(async () => ((await agent.events("session/list")).length >= 3 ? true : null), "three probes");
    await sleep(HANG_MS + REQUEST_TIMEOUT_MS);
    expect(agent.ended()).toBeNull();
    expect(await agent.events("sigterm")).toEqual([]);
  }, 30_000);

  it("keeps an agent that answers a probe late", async () => {
    const agent = await open(
      { FAKE_SILENT_LISTS: "999", FAKE_LIST_DELAY_MS: String(REQUEST_TIMEOUT_MS + 200) },
      {
        sample: flat(() => 0),
      },
    );
    await agent.start("hold-60000");
    await until(async () => ((await agent.events("session/list")).length >= 3 ? true : null), "three probes");
    await sleep(HANG_MS + REQUEST_TIMEOUT_MS);
    expect(agent.ended()).toBeNull();
  }, 30_000);

  it("does not count time while the machine is overloaded", async () => {
    let busy = true;
    const agent = await open({ FAKE_SILENT_LISTS: "999" }, { sample: flat(() => 0), overloaded: () => busy });
    await agent.start("quiet-60000");
    await sleep(HANG_MS * 2 + STALL_MS);
    expect(agent.ended()).toBeNull();
    busy = false;
    const calm = Date.now();
    const ended = await until(() => agent.ended(), "the hung agent to be ended");
    expect(Date.now() - calm).toBeGreaterThanOrEqual(HANG_MS - REQUEST_TIMEOUT_MS - GAP_MS);
    expect(ended.status).toBe("failed");
  }, 30_000);

  it("ends an agent with no progress for the whole window; a turn with no answer fails as before", async () => {
    const agent = await open({ FAKE_SILENT_LISTS: "999" }, { sample: flat(() => 7) });
    const started = await agent.start("quiet-60000");
    const ended = await until(() => agent.ended(), "the hung agent to be ended");
    expect(Date.now() - started).toBeGreaterThanOrEqual(STALL_MS + HANG_MS);
    expect(ended.status).toBe("failed");
    expect(ended.error).toBe(sourceText("error.provider.acpUnresponsive", { provider: "Gemini" }));
    expect(ended.restart).toEqual({ running: [], ended: [], silentMinutes: 0 });
    await until(async () => ((await agent.events("sigterm")).length === 1 ? true : null), "the process to end");
  }, 30_000);

  it("completes a turn that already answered, and lists the job that still runs", async () => {
    // The real process tree, with its CPU times held still: a fake at rest still uses a few ms.
    const still = async (pid: number) => {
      const tree = await sampleProcessTree(pid);
      return tree && new Map([...tree].map(([id, entry]) => [id, { ...entry, cpuMs: 0 }]));
    };
    const agent = await open({ FAKE_SILENT_LISTS: "999", FAKE_JOB: "1" }, { sample: still });
    await agent.start("hold-60000");
    const [job] = await until(async () => {
      const started = await agent.events("job");
      return started.length > 0 ? started : null;
    }, "the job");
    const jobPid = Number(job?.text);
    jobs.push(jobPid);
    const ended = await until(() => agent.ended(), "the hung agent to be ended");
    expect(ended.status).toBe("completed");
    expect(ended.error).toBeNull();
    expect(ended.restart?.running).toEqual([{ pid: jobPid, command: "sleep 300" }]);
    expect(processAlive(jobPid)).toBe(true);
  }, 30_000);
});
