// Fork: runs the real `antigravity` provider driver over a fake `agy acp`
// (`provider-fakes/agents/antigravity-subagent.ts`) to check that the approvals of a `self` subagent
// reach OpenBot. Antigravity 1.5.14 relays a subagent's approvals only to a client that opened the
// subagent's session, and names the subagent over ACP nowhere, so each of its commands waited 60 s
// for an answer and failed, also for an agent at Full access. The driver now finds the subagent's
// session from the call that started it and resumes it on the parent's connection.
// Cases: an accepted approval (the subagent's command runs), a declined one (it does not), and a
// subagent folder that another call wrote (no session is resumed and nothing is asked).
// Each approval must come for the parent's thread, so it gets the parent's access level, never more.
// Fork (FEATURES.md #90): each subagent also shows in the chat's subagent panel
// (`turn/subagents/updated`): "running" from the call, its steps from its own session, and
// "completed" with its report when it reports to its parent. Also: two subagents of one
// `start_subagent` call each get their own card, a subagent that the agent kills shows "stopped",
// and the card of a call whose session OpenBot did not find shows "failed" with the reason.
// `bun run test:antigravity-subagent-permissions`. Writes
// .openbot-build/antigravity-subagent-permissions-e2e/report.json.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ConversationSubagent } from "@openbot/contracts/ipc";
import { SUBAGENTS_UPDATED_METHOD, subagentsFromNotification } from "../src/backend/agent/subagent-updates";
import type { AgentClient } from "../src/backend/agent-client";
import { type AppServerNotification, getString } from "../src/backend/protocol";
import { NO_PROVIDER_CREDENTIALS, requireProviderDriver } from "../src/backend/provider-drivers";
import { installFakeAgent, readJsonl, runTurn, startThread, stopClients } from "./provider-fakes/host";

const OUT = resolve(import.meta.dirname, "../.openbot-build/antigravity-subagent-permissions-e2e");
/** Longer than the 15 s that OpenBot looks for a subagent's session. */
const CARD_WAIT_MS = 25_000;

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

/** The parts of a subagent card that the panel shows, without its times. */
interface Card {
  title: string;
  agentType: string | null;
  prompt: string | null;
  status: ConversationSubagent["status"];
  error: string | null;
  background: boolean;
  steps: string[];
}

interface Report {
  passed: boolean;
  accepted?: { approvals: Approval[]; resumed: LogEntry[]; outcome: string | undefined };
  declined?: { approvals: Approval[]; outcome: string | undefined };
  otherCall?: { approvals: number; resumed: number };
  /** Fork (FEATURES.md #90): the cards of each case: the first list that showed it, and the last. */
  panel: Record<string, { first: Card[]; last: Card[] }>;
  failure?: string;
}

const root = await mkdtemp(join(tmpdir(), "openbot-antigravity-subagent-e2e-"));
process.env.GEMINI_HOME = join(root, "gemini");
const report: Report = { passed: false, panel: {} };
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

function card(subagent: ConversationSubagent): Card {
  return {
    title: subagent.title,
    agentType: subagent.agentType,
    prompt: subagent.prompt,
    status: subagent.status,
    error: subagent.error,
    background: subagent.background === true,
    steps: subagent.steps.map((step) => `${step.kind}: ${step.text}`),
  };
}

/** The subagent lists of a thread, by turn, and a wait for a list that matches. */
function watchPanel(client: AgentClient, thread: string) {
  const lists: Array<{ turnId: string; subagents: ConversationSubagent[] }> = [];
  const waiters = new Set<() => void>();
  client.on("notification", (notification: AppServerNotification) => {
    if (notification.method !== SUBAGENTS_UPDATED_METHOD) return;
    if (getString(notification.params, "threadId") !== thread) return;
    const subagents = subagentsFromNotification(notification.params);
    const turnId = getString(notification.params, "turnId");
    assert.ok(subagents && turnId, "The notification decodes as a subagent list of a turn.");
    lists.push({ turnId, subagents });
    for (const waiter of waiters) waiter();
  });
  /** The lists from `from` on, until one matches; fails after `CARD_WAIT_MS`. */
  const until = (label: string, from: number, find: (subagents: ConversationSubagent[]) => boolean) =>
    new Promise<{ first: Card[]; last: Card[]; turnId: string }>((found, fail) => {
      const check = () => {
        const seen = lists.slice(from);
        const match = seen.find((list) => find(list.subagents));
        if (!match || !seen[0]) return;
        waiters.delete(check);
        clearTimeout(timer);
        found({ first: seen[0].subagents.map(card), last: match.subagents.map(card), turnId: match.turnId });
      };
      const timer = setTimeout(() => {
        waiters.delete(check);
        fail(new Error(`Timed out waiting for ${label}: ${JSON.stringify(lists.slice(from))}`));
      }, CARD_WAIT_MS);
      waiters.add(check);
      check();
    });
  return { lists, until };
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
  const panel = watchPanel(client, thread);
  const ended = (subagents: ConversationSubagent[]) =>
    subagents.length > 0 && subagents.every((subagent) => subagent.status !== "running");

  // Accepted: the subagent's command asks once, for the parent's thread, and runs.
  let from = panel.lists.length;
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
  const accepted = await panel.until("the subagent's report", from, ended);
  report.panel.accepted = accepted;
  assert.ok(
    panel.lists.slice(from).every((list) => list.turnId === accepted.turnId),
    "The card stays on the turn that started the subagent, also after that turn ended.",
  );
  const runner = {
    title: "Runner",
    agentType: "self",
    prompt: "Run `pwd && echo shell-ok`.",
    error: null,
    background: true,
  };
  assert.deepEqual(accepted.first, [{ ...runner, status: "running", steps: [] }], "The call shows the card at once.");
  assert.deepEqual(
    accepted.last,
    [
      {
        ...runner,
        status: "completed",
        steps: ["command: pwd && echo shell-ok", "text: Reporting to the parent.", "text: shell-ok"],
      },
    ],
    "The subagent's own steps fill the card, and its report to the parent ends it.",
  );

  // Declined: the subagent's command does not run.
  decision = "decline";
  approvals.length = 0;
  from = panel.lists.length;
  await runTurn(client, thread, { text: "spawn", timeoutMs: 20_000 });
  const second = await waitForEntry(
    log,
    (entry) => entry.event === "child-permission" && entry.sessionId !== first.sessionId,
  );
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0]?.threadId, thread);
  assert.match(second.text ?? "", /"optionId":"reject"/u, "A declined approval refuses the command.");
  report.declined = { approvals: [...approvals], outcome: second.text };
  const declined = await panel.until("the refused subagent's report", from, ended);
  report.panel.declined = declined;
  assert.deepEqual(declined.last[0]?.steps.at(-1), "text: The command was refused.");
  assert.equal(declined.last[0]?.status, "completed", "A subagent that reports has completed its task.");

  // Two subagents of one `start_subagent` call: each session fills the card of its own task.
  from = panel.lists.length;
  await runTurn(client, thread, { text: "spawn-two", timeoutMs: 20_000 });
  const two = await panel.until("both reports", from, ended);
  report.panel.two = two;
  assert.deepEqual(
    two.last.map(({ title, status, steps }) => ({ title, status, steps })),
    [
      {
        title: "Worker 1",
        status: "completed",
        steps: ["text: Reporting to the parent.", "text: Done: Index the clips."],
      },
      {
        title: "Worker 2",
        status: "completed",
        steps: ["text: Reporting to the parent.", "text: Done: Sort the shelf."],
      },
    ],
  );

  // A subagent that the agent kills with `manage_subagents` stops.
  from = panel.lists.length;
  const opened = new Set((await readJsonl<LogEntry>(log)).flatMap((entry) => entry.sessionId ?? []));
  await runTurn(client, thread, { text: "spawn-idle", timeoutMs: 20_000 });
  // The kill names the subagent's session, which OpenBot knows once it opened it.
  await waitForEntry(log, (entry) => entry.event === "resume" && !opened.has(entry.sessionId ?? ""));
  await runTurn(client, thread, { text: "kill", timeoutMs: 20_000 });
  const killed = await panel.until("the killed subagent", from, ended);
  report.panel.killed = killed;
  assert.equal(killed.last[0]?.status, "stopped", "A subagent that the agent kills shows as stopped.");

  // A subagent folder that names another call is not this call's subagent.
  approvals.length = 0;
  from = panel.lists.length;
  const before = (await readJsonl<LogEntry>(log)).filter((entry) => entry.event === "resume").length;
  await runTurn(client, thread, { text: "spawn-other", timeoutMs: 20_000 });
  // The card fails when OpenBot stops looking for the session, so no resume can come after it.
  const other = await panel.until("the card of the call with no session", from, ended);
  report.panel.otherCall = other;
  assert.equal(other.last[0]?.status, "failed", "A card with no session found does not stay running.");
  assert.match(other.last[0]?.error ?? "", /found no session/u);
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
