// Fork (docs/fork/FEATURES.md #130, "Team follow-through"): a lead agent whose teammate reported back
// and who gave it no next step gets one wake that names the teammate. Before, nothing noticed such a
// report (Vegapunk, 27 Nov 2026: Distiller's "Status: done" at 14:27 got no next step until the user
// asked 8 minutes later). Runs the real agent service four times on one temporary profile with the fake
// `agy acp` of `provider-fakes/agents/antigravity-subagent.ts`: the requests are written to the mailbox
// between runs, the teammates answer them in the next run (their answer goes back as a reply, as
// `openbot.send_message` with `expectsReply` does), and the wake is read from the fake's prompt log.
// Lead Vegapunk never answers Distiller: one wake. Lead Shaka sends Lilith a message after her report:
// no wake. A restart adds no second wake. `bun scripts/fork-follow-through-e2e.ts`; writes
// .openbot-build/fork-follow-through-e2e/report.json.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AGENT_PROVIDERS } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import type { AgentBrowserHost } from "../src/backend/agent/turn-lifecycle";
import { installFakeAgent, readJsonl } from "./provider-fakes/host";

const OUT = resolve(import.meta.dirname, "../.openbot-build/fork-follow-through-e2e");
const HEADER = "[OpenBot: 👥 team follow-through]";
const root = await mkdtemp(join(tmpdir(), "openbot-follow-through-"));
const home = join(root, "home");
const control = join(root, "control");
const fakeAgy = join(root, "antigravity", "1.5.14", "bin", "antigravity");
const agyLog = join(root, "agy.jsonl");
const userData = join(root, "user-data");

process.env.HOME = home;
process.env.GEMINI_HOME = join(home, ".gemini");
process.env.OPENBOT_ANTIGRAVITY_PATH = fakeAgy;
process.env.OPENBOT_FORK_FOLLOW_THROUGH_SWEEP_MS = "200";
// Runs 1 and 2: no report is old enough yet.
process.env.OPENBOT_FORK_FOLLOW_THROUGH_DELAY_MS = String(60 * 60_000);
mkdirSync(home, { recursive: true });
mkdirSync(control, { recursive: true });

const { AgentService } = await import("../src/backend/agent-service");
const { AgentStore } = await import("../src/backend/agent-store");
const { runCauseEffect } = await import("../src/backend/effect-boundary");
const { followThroughKey } = await import("../src/backend/fork-follow-through");
const { MailboxStore } = await import("../src/backend/mailbox-store");
const { OpenBotDatabase } = await import("../src/backend/openbot-database");

const unused = () => Effect.die(new Error("Not used by this check."));
const browser: AgentBrowserHost = {
  listTabs: () => [],
  toolCanUseTab: () => false,
  beginTakeover: unused,
  endTakeover: () => {},
  userControlTabFor: () => null,
  awaitUserControlRelease: unused,
  resolveUploadTarget: unused,
  handleDynamicTool: unused,
  onChanged: () => () => {},
  onControlChanged: () => () => {},
  onDocumentChanged: () => () => {},
  clearControls: () => {},
  endControl: () => {},
  close: () => Effect.void,
  clearAgentSession: () => Effect.void,
  shareTab: () => undefined,
  unshareThread: () => undefined,
  agentTab: () => null,
};

async function waitFor<T>(label: string, read: () => Promise<T | null | undefined | false>, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((done) => setTimeout(done, 25));
  }
}
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

const prompts = async () =>
  (await readJsonl<{ event: string; sessionId?: string; text?: string }>(agyLog)).filter(
    (entry) => entry.event === "prompt",
  );
const wakePrompts = async () => (await prompts()).filter((entry) => entry.text?.includes(HEADER));

function start() {
  const database = new OpenBotDatabase(userData);
  const store = new AgentStore(database.userDataPath, home, database);
  const mailbox = new MailboxStore(database.userDataPath, store.sharedRoot, store.database);
  const agents = new AgentService({
    store,
    mailbox,
    browser,
    preferredProvider: "antigravity",
    offProviders: AGENT_PROVIDERS.filter((candidate) => candidate !== "antigravity"),
    timezone: () => "UTC",
  });
  return { database, mailbox, agents };
}
type Run = ReturnType<typeof start>;

const idle = (run: Run, agentId: string) =>
  run.agents
    .listQueue(agentId)
    .deliveries.every((delivery) => !["queued", "starting", "running"].includes(delivery.status));

/** Writes a message between two agents into the mailbox while no service runs. */
async function writeMessage(input: { from: string; to: string; text: string; expectsReply: boolean }): Promise<string> {
  const database = new OpenBotDatabase(userData);
  const store = new AgentStore(database.userDataPath, home, database);
  const mailbox = new MailboxStore(database.userDataPath, store.sharedRoot, store.database);
  await runCauseEffect(mailbox.initialize());
  const receipt = await runCauseEffect(
    mailbox.enqueue({
      sender: { kind: "agent", agentId: input.from },
      recipientAgentIds: [input.to],
      text: input.text,
      replyToMessageId: null,
      expectsReply: input.expectsReply,
    }),
  );
  database.close();
  return receipt.messageId;
}

async function stop(run: Run) {
  await runCauseEffect(run.agents.stop());
  run.database.close();
}

interface Report {
  passed: boolean;
  report?: { from: string; replyTo: string; text: string } | undefined;
  wake?: string | undefined;
  wakeSessionIsLeads?: boolean;
  wakesAfterSweeps?: number;
  wakesAfterRestart?: number;
  shakaWakes?: number;
  error?: string;
}

const report: Report = { passed: false };
try {
  await installFakeAgent(fakeAgy, "antigravity-subagent", { FAKE_LOG: agyLog, FAKE_CONTROL: control });

  // Run 1: two leads and their teammates.
  const first = start();
  await runCauseEffect(first.agents.initialize());
  const create = (name: string) =>
    runCauseEffect(
      first.agents.createAgent({
        name,
        description: `${name} works in the team follow-through check.`,
        avatarSeed: name.toLowerCase(),
        avatarHue: null,
        initialMessage: "first-turn",
        provider: "antigravity",
      }),
    );
  const vegapunk = await create("Vegapunk");
  const distiller = await create("Distiller");
  const shaka = await create("Shaka");
  const lilith = await create("Lilith");
  const all = [vegapunk, distiller, shaka, lilith];
  await waitFor(
    "the first turns",
    async () =>
      all.every((agent) => first.agents.listQueue(agent.id).deliveries.length > 0 && idle(first, agent.id)) &&
      (await prompts()).length >= all.length,
  );
  await stop(first);

  // Each lead asks its teammate for work, as openbot.send_message with expectsReply does.
  const request = await writeMessage({
    from: vegapunk.id,
    to: distiller.id,
    text: "report-done: build the toolkit.",
    expectsReply: true,
  });
  await writeMessage({ from: shaka.id, to: lilith.id, text: "report-done: sort the shelf.", expectsReply: true });

  // Run 2: the teammates answer; their answers go back to the leads as replies.
  const second = start();
  await runCauseEffect(second.agents.initialize());
  const since = new Date(Date.now() - 60 * 60_000).toISOString();
  const reportOf = (run: Run, lead: string, teammate: string) =>
    run.mailbox
      .forkFollowThroughTraffic(lead, since)
      .received.find(
        (message) =>
          message.sender.kind === "agent" &&
          message.sender.agentId === teammate &&
          message.replyToSenderAgentId === lead &&
          message.status === "completed",
      );
  const done = await waitFor(
    "the teammates' reports to reach the leads",
    async () =>
      reportOf(second, shaka.id, lilith.id) &&
      all.every((agent) => idle(second, agent.id)) &&
      reportOf(second, vegapunk.id, distiller.id),
  );
  report.report = { from: "Distiller", replyTo: done.replyToMessageId ?? "", text: done.text };
  assert.equal(done.replyToMessageId, request, "Distiller's report replies to Vegapunk's request.");
  assert.match(done.text, /^Status: done/u);
  assert.equal((await wakePrompts()).length, 0, "No wake before the report is old enough.");
  await stop(second);

  // Shaka decides on Lilith's report: it messages her after it.
  await writeMessage({ from: shaka.id, to: lilith.id, text: "Thanks, your part is finished.", expectsReply: false });

  // Run 3: the reports are old enough now. Vegapunk gets one wake; Shaka none.
  process.env.OPENBOT_FORK_FOLLOW_THROUGH_DELAY_MS = "500";
  const third = start();
  await runCauseEffect(third.agents.initialize());
  const wake = await waitFor("the follow-through wake", async () => (await wakePrompts())[0]);
  // OpenBot's own context blocks (saved memories, section teammates) come first, as in every prompt.
  report.wake = wake.text?.replace(/^(?:<openbot_[a-z_]+>[\s\S]*?<\/openbot_[a-z_]+>\s*)+/u, "");
  assert.ok(report.wake?.startsWith(HEADER), "The wake is the whole prompt.");
  assert.ok(wake.text?.includes("- Distiller, "), "The wake names Distiller.");
  assert.ok(wake.text?.includes('"Status: done. The toolkit is built'), "The wake quotes the report.");
  assert.ok(!wake.text?.includes("Lilith"), "Lilith's report has Shaka's decision.");
  const vegapunkSessions = new Set(
    (await prompts())
      .filter(
        (entry) =>
          !entry.text?.includes(HEADER) && entry.text?.includes("Distiller") && entry.text?.includes("Status: done"),
      )
      .map((entry) => entry.sessionId),
  );
  report.wakeSessionIsLeads = vegapunkSessions.has(wake.sessionId);
  assert.ok(report.wakeSessionIsLeads, "The wake runs in Vegapunk's own session.");
  await waitFor("the wake turn to end", async () => idle(third, vegapunk.id));
  const key = followThroughKey(done.id);
  assert.equal(third.mailbox.deliveryForKey(key)?.delivery.recipientAgentId, vegapunk.id, "The wake has its key.");
  await sleep(2_000); // ten sweeps
  report.wakesAfterSweeps = (await wakePrompts()).length;
  assert.equal(report.wakesAfterSweeps, 1, "Later sweeps add no wake.");
  report.shakaWakes = third.mailbox
    .forkFollowThroughTraffic(shaka.id, since)
    .received.filter((message) => message.sender.kind === "routine").length;
  assert.equal(report.shakaWakes, 0, "Shaka gets no wake.");
  await stop(third);

  // Run 4: a restart, with no time between wakes: the report already had its wake.
  process.env.OPENBOT_FORK_FOLLOW_THROUGH_GAP_MS = "0";
  const fourth = start();
  await runCauseEffect(fourth.agents.initialize());
  await sleep(2_000);
  report.wakesAfterRestart = (await wakePrompts()).length;
  assert.equal(report.wakesAfterRestart, 1, "A restart adds no wake.");
  await stop(fourth);
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
} finally {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "report.json"), `${JSON.stringify(report, null, 1)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 1)}\n`);
  await rm(root, { recursive: true, force: true });
}
process.exit(report.passed ? 0 : 1);
