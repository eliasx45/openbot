// Fork: runs the real `antigravity` provider driver over a fake `agy acp`
// (`provider-fakes/agents/antigravity-subagent.ts`) to check that the approvals of a `self` subagent
// reach OpenBot. Antigravity 1.5.14 relays a subagent's approvals only to a client that opened the
// subagent's session, and names the subagent over ACP nowhere, so each of its commands waited 60 s
// for an answer and failed, also for an agent at Full access. The driver now finds the subagent's
// session from the call that started it and resumes it on the parent's connection.
// Cases: an accepted approval (the subagent's command runs), a declined one (it does not), and a
// subagent folder that another call wrote (no session is resumed and nothing is asked).
// Each approval must come for the parent's thread, so it gets the parent's access level, never more.
// `bun run test:antigravity-subagent-permissions`. Writes
// .openbot-build/antigravity-subagent-permissions-e2e/report.json.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentClient } from "../src/backend/agent-client";
import { getString } from "../src/backend/protocol";
import { NO_PROVIDER_CREDENTIALS, requireProviderDriver } from "../src/backend/provider-drivers";
import { installFakeAgent, readJsonl, runTurn, startThread, stopClients } from "./provider-fakes/host";

const OUT = resolve(import.meta.dirname, "../.openbot-build/antigravity-subagent-permissions-e2e");

interface LogEntry {
  event: string;
  sessionId?: string;
  text?: string;
  mcp?: string[];
}

interface Approval {
  method: string;
  threadId: string | null;
  command: string | null;
}

interface Report {
  passed: boolean;
  accepted?: { approvals: Approval[]; resumed: LogEntry[]; outcome: string | undefined };
  declined?: { approvals: Approval[]; outcome: string | undefined };
  otherCall?: { approvals: number; resumed: number };
  failure?: string;
}

const root = await mkdtemp(join(tmpdir(), "openbot-antigravity-subagent-e2e-"));
process.env.GEMINI_HOME = join(root, "gemini");
const report: Report = { passed: false };
const clients: AgentClient[] = [];

/** Waits until the fake logs an entry that matches, or fails after `timeoutMs`. */
async function waitForEntry(log: string, match: (entry: LogEntry) => boolean, timeoutMs = 10_000): Promise<LogEntry> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = (await readJsonl<LogEntry>(log)).find(match);
    if (found) return found;
    if (Date.now() > deadline) throw new Error("The fake agent did not log the expected entry.");
    await new Promise((settle) => setTimeout(settle, 25));
  }
}

try {
  const executable = join(root, "agent", "bin", "antigravity");
  const log = join(root, "agent", "agent.jsonl");
  await installFakeAgent(executable, "antigravity-subagent", { FAKE_LOG: log });
  const client = requireProviderDriver("antigravity").createClient(
    { executable, version: "1.5.14", source: "managed" },
    10_000,
    NO_PROVIDER_CREDENTIALS,
  );
  clients.push(client);
  const approvals: Approval[] = [];
  let decision = "accept";
  client.on("request", (request) => {
    if (!request.method.endsWith("/requestApproval")) {
      client.respondError(request.id, { code: -32601, message: `The test does not answer ${request.method}.` });
      return;
    }
    approvals.push({
      method: request.method,
      threadId: getString(request.params, "threadId"),
      command: getString(request.params, "command"),
    });
    client.respond(request.id, { decision });
  });
  client.start();
  const thread = await startThread(client, { cwd: root });

  // Accepted: the subagent's command asks once, for the parent's thread, and runs.
  const spawned = await runTurn(client, thread, { text: "spawn", timeoutMs: 20_000 });
  assert.equal(spawned.status, "completed", "The turn that starts the subagent completes.");
  const parentId = (await waitForEntry(log, (entry) => entry.event === "prompt" && entry.text === "spawn")).sessionId;
  const first = await waitForEntry(log, (entry) => entry.event === "child-permission");
  const resumed = (await readJsonl<LogEntry>(log)).filter(
    (entry) => entry.event === "resume" || entry.event === "load",
  );
  assert.equal(resumed.length, 1, "OpenBot opens the subagent's session once.");
  assert.equal(resumed[0]?.event, "resume", "The agent resumes, so the subagent's transcript is not replayed.");
  assert.notEqual(resumed[0]?.sessionId, parentId, "OpenBot opens the subagent's session, not the parent's.");
  assert.equal(resumed[0]?.text, root, "The subagent's session gets the parent's folder.");
  assert.equal(approvals.length, 1, "The subagent's command asks OpenBot once.");
  assert.equal(approvals[0]?.method, "item/commandExecution/requestApproval");
  assert.equal(approvals[0]?.threadId, thread, "The approval belongs to the parent's thread and its access level.");
  assert.match(approvals[0]?.command ?? "", /pwd && echo shell-ok/u);
  assert.match(first.text ?? "", /"optionId":"allow"/u, "The accepted approval lets the command run.");
  report.accepted = { approvals: [...approvals], resumed, outcome: first.text };

  // Declined: the subagent's command does not run.
  decision = "decline";
  approvals.length = 0;
  await runTurn(client, thread, { text: "spawn", timeoutMs: 20_000 });
  const second = await waitForEntry(
    log,
    (entry) => entry.event === "child-permission" && entry.sessionId !== first.sessionId,
  );
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0]?.threadId, thread);
  assert.match(second.text ?? "", /"optionId":"reject"/u, "A declined approval refuses the command.");
  report.declined = { approvals: [...approvals], outcome: second.text };

  // A subagent folder that names another call is not this call's subagent.
  approvals.length = 0;
  const before = (await readJsonl<LogEntry>(log)).filter((entry) => entry.event === "resume").length;
  await runTurn(client, thread, { text: "spawn-other", timeoutMs: 20_000 });
  await new Promise((settle) => setTimeout(settle, 2_000));
  const after = (await readJsonl<LogEntry>(log)).filter((entry) => entry.event === "resume").length;
  assert.equal(after, before, "No session is opened for a subagent of another call.");
  assert.equal(approvals.length, 0);
  report.otherCall = { approvals: approvals.length, resumed: after - before };

  report.passed = true;
} catch (error) {
  report.failure = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.exitCode = 1;
} finally {
  await stopClients(clients);
  await mkdir(OUT, { recursive: true });
  await writeFile(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await rm(root, { recursive: true, force: true });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
