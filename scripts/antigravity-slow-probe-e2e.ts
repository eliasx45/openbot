// Fork (docs/fork/FEATURES.md #131): a Gemini (Antigravity) turn held open for a background job
// survives a slow agent. Before, one `session/list` probe that timed out ended `agy` and the job with it
// (Chopper, 27 Nov 2026: "Gemini did not answer in time, so OpenBot ended its process." while the Mac
// ran at a load of 250–300). Runs a real `AcpAgentClient` with Antigravity's flavor over the fake
// `agy acp` of `provider-fakes/agents/slow-probe.ts`, with short stall, request, hang and probe times,
// and the real process-table reading: an agent that answers its probes late, and one that answers none
// while its job computes, keep their turns; an agent with no progress at all is ended after the hang
// window and the turn carries what OpenBot needs to resume it. `bun scripts/antigravity-slow-probe-e2e.ts`;
// writes .openbot-build/antigravity-slow-probe-e2e/report.json.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { sourceText } from "@openbot/i18n/source";
import { AcpAgentClient } from "../src/backend/acp-client";
import { ANTIGRAVITY_ACP_FLAVOR } from "../src/backend/acp-flavor-antigravity";
import type { AgentClient } from "../src/backend/agent-client";
import { processAlive } from "../src/backend/fork-provider-hang";
import { type AppServerNotification, getRecord, getString } from "../src/backend/protocol";
import { installFakeAgent, readJsonl, runTurn, startThread, stopClients } from "./provider-fakes/host";

const OUT = resolve(import.meta.dirname, "../.openbot-build/antigravity-slow-probe-e2e");
const STALL_MS = 500;
const REQUEST_TIMEOUT_MS = 1_500;
const GAP_MS = 300;
const HANG_MS = 4_000;
/** Longer than the stall limit plus the hang window, so an agent ended as hung ends before its job. */
const JOB_MS = STALL_MS + HANG_MS + REQUEST_TIMEOUT_MS * 2 + 3_000;

interface Scenario {
  status: string | null;
  reply: string;
  error: string | null;
  elapsedMs: number;
  probes: number;
  sigterms: number;
  restart: boolean;
}

interface Report {
  passed: boolean;
  lateProbes?: Scenario;
  busyJob?: Scenario;
  hung?: Scenario & { next: string | null };
  error?: string;
}

const root = await mkdtemp(join(tmpdir(), "openbot-ag-slow-probe-"));
const clients: AgentClient[] = [];
const jobs: number[] = [];
const report: Report = { passed: false };

async function scenario(
  name: string,
  env: Readonly<Record<string, string>>,
  prompt: string,
  then?: (client: AgentClient, thread: string) => Promise<void>,
) {
  const log = join(root, `${name}.jsonl`);
  const executable = join(root, name, "bin", "antigravity");
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
    // This machine's own load must not pause the hang clock here.
    systemOverloaded: () => false,
  });
  clients.push(client);
  client.start();
  const workspace = join(root, name, "workspace");
  mkdirSync(workspace, { recursive: true });
  const thread = await startThread(client, { cwd: workspace });
  let restart = false;
  client.on("notification", (notification: AppServerNotification) => {
    if (
      notification.method === "turn/completed" &&
      getString(notification.params, "threadId") === thread &&
      getRecord(notification.params, "forkProviderRestart")
    )
      restart = true;
  });
  const started = Date.now();
  const turn = await runTurn(client, thread, { text: prompt, timeoutMs: JOB_MS * 4 });
  const elapsedMs = Date.now() - started;
  await then?.(client, thread);
  const entries = await readJsonl<{ event: string; text?: string }>(log);
  for (const entry of entries) if (entry.event === "job") jobs.push(Number(entry.text));
  const result: Scenario = {
    status: turn.status,
    reply: turn.reply,
    error: turn.error,
    elapsedMs,
    probes: entries.filter((entry) => entry.event === "session/list").length,
    sigterms: entries.filter((entry) => entry.event === "sigterm").length,
    restart,
  };
  return result;
}

try {
  // A slow agent: every probe is answered, but only after its timeout.
  const late = await scenario(
    "late",
    { FAKE_SILENT_LISTS: "999", FAKE_LIST_DELAY_MS: String(REQUEST_TIMEOUT_MS + 500) },
    `hold-${JOB_MS}`,
  );
  report.lateProbes = late;
  assert.equal(late.status, "completed", "The held turn survives late probe answers.");
  assert.match(late.reply, /Run finished\./u, "The background job's answer reaches the chat.");
  assert.ok(late.probes >= 2, "OpenBot probed the agent more than once.");
  assert.equal(late.sigterms, 0, "OpenBot did not end the slow agent.");

  // A busy agent: no probe is answered at all, but its job burns CPU.
  const busy = await scenario("busy", { FAKE_SILENT_LISTS: "999", FAKE_BUSY: "1" }, `hold-${JOB_MS}`);
  report.busyJob = busy;
  assert.equal(busy.status, "completed", "The held turn survives while its job computes.");
  assert.match(busy.reply, /Run finished\./u, "The busy job's answer reaches the chat.");
  assert.equal(busy.sigterms, 0, "OpenBot did not end the agent whose job computes.");
  assert.ok(busy.elapsedMs >= JOB_MS, "The turn ran until the job ended.");

  // A hung agent: no output, no answer, no CPU. It is ended after the hang window; the next turn works.
  let next: string | null = null;
  const hung = await scenario("hung", { FAKE_SILENT_LISTS: "999" }, `quiet-${JOB_MS}`, async (client, thread) => {
    next = (await runTurn(client, thread, { text: "hello", timeoutMs: 20_000 })).status;
  });
  report.hung = { ...hung, next };
  assert.equal(hung.status, "failed", "A hung agent's unanswered turn fails.");
  assert.equal(
    hung.error,
    sourceText("error.provider.acpUnresponsive", { provider: "Gemini" }),
    "The failure is the one of a hung agent, as before.",
  );
  assert.equal(hung.restart, true, "The turn carries the restart, so OpenBot resumes the chat.");
  assert.ok(hung.sigterms >= 1, "OpenBot ended the hung agent's process.");
  assert.ok(hung.elapsedMs >= STALL_MS + HANG_MS, "The agent had the whole hang window.");
  assert.ok(hung.elapsedMs < JOB_MS, "The hung agent was ended before its job would have ended.");
  assert.equal(next, "completed", "The next turn after the hung agent was ended works.");
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
} finally {
  await stopClients(clients);
  for (const pid of jobs) if (processAlive(pid)) process.kill(pid, "SIGKILL");
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "report.json"), `${JSON.stringify(report, null, 1)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 1)}\n`);
  await rm(root, { recursive: true, force: true });
}
process.exit(report.passed ? 0 : 1);
