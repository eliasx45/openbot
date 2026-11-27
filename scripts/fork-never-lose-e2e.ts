// Fork (docs/fork/FEATURES.md #136, "Never lose work"): a teammate's hand-off that fails on a temporary
// cause runs once more and the lead gets the reply, with the update the lead steered into the failed
// turn; one that fails again gives the lead exactly one failure note that lists the updates; a second
// identical send is not sent. Runs the real agent service with the fake `agy acp` of
// `provider-fakes/agents/never-lose.ts`; the lead's fake calls openbot `send_message` over MCP, so the
// real tool router steers and deduplicates. `bun scripts/fork-never-lose-e2e.ts`; writes
// .openbot-build/fork-never-lose-e2e/report.json.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AGENT_PROVIDERS } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import type { AgentBrowserHost } from "../src/backend/agent/turn-lifecycle";
import { installFakeAgent, readJsonl } from "./provider-fakes/host";

const OUT = resolve(import.meta.dirname, "../.openbot-build/fork-never-lose-e2e");
const root = await mkdtemp(join(tmpdir(), "openbot-never-lose-"));
const home = join(root, "home");
const control = join(root, "control");
const fakeAgy = join(root, "antigravity", "1.5.14", "bin", "antigravity");
const agyLog = join(root, "agy.jsonl");
const userData = join(root, "user-data");

process.env.HOME = home;
process.env.GEMINI_HOME = join(home, ".gemini");
process.env.OPENBOT_ANTIGRAVITY_PATH = fakeAgy;
process.env.OPENBOT_FORK_RESTART_RESUME_GRACE_MS = "100";
process.env.OPENBOT_FORK_RESTART_RESUME_STAGGER_MS = "100";
process.env.OPENBOT_FORK_FOLLOW_THROUGH = "0";
mkdirSync(home, { recursive: true });
mkdirSync(control, { recursive: true });

const { AgentService } = await import("../src/backend/agent-service");
const { AgentStore } = await import("../src/backend/agent-store");
const { runCauseEffect } = await import("../src/backend/effect-boundary");
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

const prompts = async () =>
  (await readJsonl<{ event: string; text?: string; sessionId?: string }>(agyLog)).filter(
    (entry) => entry.event === "prompt",
  );

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
  return { database, agents };
}

const idle = (agents: InstanceType<typeof AgentService>, agentId: string) =>
  agents
    .listQueue(agentId)
    .deliveries.every((delivery) => !["queued", "starting", "running"].includes(delivery.status));

interface Report {
  passed: boolean;
  retried?: { retryPrompt: string; replies: string[] };
  failedTwice?: { notes: string[] };
  dedupe?: { tool: string; count: number; reworkCount: number };
  error?: string;
  prompts?: string[];
}

const report: Report = { passed: false };
const instance = start();
const sqlite = () => new DatabaseSync(join(userData, "openbot.db"), { readOnly: true });
const messagesFrom = (sender: string, recipient: string) => {
  const db = sqlite();
  const rows = db
    .prepare(
      `SELECT m.text FROM projection_mailbox_messages m JOIN projection_deliveries d USING(message_id)
       WHERE m.sender_agent_id = ? AND d.recipient_agent_id = ? ORDER BY m.created_at`,
    )
    .all(sender, recipient)
    .map((row) => String(row.text));
  db.close();
  return rows;
};
const countText = (text: string) => {
  const db = sqlite();
  const row = db.prepare("SELECT COUNT(*) AS n FROM projection_mailbox_messages WHERE text = ?").get(text);
  db.close();
  return Number(row?.n ?? 0);
};
try {
  await installFakeAgent(fakeAgy, "never-lose", { FAKE_LOG: agyLog, FAKE_FAIL_AFTER_MS: "5000" });
  const { agents } = instance;
  await runCauseEffect(agents.initialize());
  const make = async (name: string) => {
    const agent = await runCauseEffect(
      agents.createAgent({
        name,
        description: `${name} checks #136.`,
        avatarSeed: name.toLowerCase(),
        avatarHue: null,
        initialMessage: "first-turn",
        provider: "antigravity",
      }),
    );
    await waitFor(
      `${name}'s first turn`,
      async () => agents.listQueue(agent.id).deliveries.length > 0 && idle(agents, agent.id),
    );
    return agent;
  };
  const vega = await make("Vega");
  const shadow = await make("Shadow");
  const pacer = await make("Pacer");
  const say = (text: string) => runCauseEffect(agents.sendMessage({ agentId: vega.id, text }));
  interface SendArgs {
    recipientAgentIds: string[];
    text: string;
    expectsReply?: boolean;
    rework?: boolean;
  }
  const send = (args: SendArgs, twice = false) => say(`send-${twice ? "twice" : "once"}:${JSON.stringify(args)}`);
  const promptsOf = async (match: string) => (await prompts()).filter((entry) => entry.text?.includes(match));

  // (1) fail-once: the hand-off fails on a network reset, runs once more with the steered update, and Vega gets the reply.
  await send({ recipientAgentIds: [shadow.id], text: "fail-once: build the toolkit" });
  await waitFor("Shadow's request", async () => (await promptsOf("fail-once: build the toolkit")).length > 0);
  // The turn has said something (the steer needs a started answer), then the lead's update is steered in.
  await new Promise((done) => setTimeout(done, 1_500));
  await send({ recipientAgentIds: [shadow.id], text: "update-A: use the load guard", expectsReply: false });
  const retryPrompt = await waitFor(
    "Shadow's retry",
    async () => (await promptsOf("[OpenBot: 🔁 retry]")).find((entry) => entry.text?.includes("build the toolkit")),
    60_000,
  );
  await waitFor(
    "Shadow's reply to Vega",
    async () => messagesFrom(shadow.id, vega.id).some((text) => text.includes("finished on OpenBot's retry")),
    60_000,
  );
  report.retried = { retryPrompt: retryPrompt.text?.slice(-900) ?? "", replies: messagesFrom(shadow.id, vega.id) };
  assert.ok(
    retryPrompt.text?.includes("OpenBot retry: your previous attempt at this request failed"),
    "The retry says the attempt failed.",
  );
  assert.ok(
    retryPrompt.text?.includes("[OpenBot: 🔁 resent]") && retryPrompt.text.includes("update-A"),
    "The steered update runs with the retry.",
  );
  assert.ok(
    !messagesFrom(shadow.id, vega.id).some((text) => text.startsWith("Status: blocked")),
    "Vega got no failure note.",
  );
  assert.equal(messagesFrom(shadow.id, vega.id).length, 1, "Vega got exactly the reply.");

  // (2) fail-always: one retry, then exactly one failure note that lists both updates.
  await send({ recipientAgentIds: [pacer.id], text: "fail-always: render the teaser" });
  await waitFor("Pacer's request", async () => (await promptsOf("fail-always: render the teaser")).length > 0);
  await new Promise((done) => setTimeout(done, 1_500));
  await send({ recipientAgentIds: [pacer.id], text: "update-B: two renders at most", expectsReply: false });
  await send({ recipientAgentIds: [pacer.id], text: "update-C: the kit moved to /tmp/kit", expectsReply: false });
  await waitFor(
    "Pacer's note to Vega",
    async () => messagesFrom(pacer.id, vega.id).some((text) => text.startsWith("Status: blocked")),
    90_000,
  );
  await new Promise((done) => setTimeout(done, 3_000));
  const notes = messagesFrom(pacer.id, vega.id).filter((text) => text.startsWith("Status: blocked"));
  report.failedTwice = { notes };
  assert.equal(
    (await promptsOf("[OpenBot: 🔁 retry]")).filter((entry) => entry.text?.includes("render the teaser")).length,
    1,
    "One retry only.",
  );
  assert.equal(notes.length, 1, "Exactly one failure note.");
  assert.ok(notes[0]?.includes("update-B") && notes[0].includes("update-C"), "The note lists the steered updates.");
  assert.ok(notes[0]?.includes("OpenBot already ran this request once more"), "The note says it was retried.");

  // (3) a second identical send is not sent; rework:true sends it.
  await waitFor("Vega idle", async () => idle(agents, vega.id), 60_000);
  const dedupeText = "dedupe: render the second teaser";
  await send({ recipientAgentIds: [shadow.id], text: dedupeText }, true);
  const twice = await waitFor("both sends", async () =>
    (await readJsonl<{ event: string; text?: string }>(agyLog)).find((entry) => entry.event === "send-twice"),
  );
  const count = countText(dedupeText);
  await send({ recipientAgentIds: [shadow.id], text: dedupeText, rework: true });
  await waitFor("the rework send", async () => countText(dedupeText) === 2);
  report.dedupe = { tool: twice.text ?? "", count, reworkCount: countText(dedupeText) };
  assert.ok(twice.text?.includes("Not sent again: already sent at"), "The second send says it was already sent.");
  assert.equal(count, 1, "The identical request was sent once.");
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
  report.prompts = (
    await readJsonl<{ event: string; text?: string; sessionId?: string; steer?: boolean }>(agyLog).catch(() => [])
  )
    .filter((entry) => entry.event === "prompt" || entry.event.startsWith("send-"))
    .map((entry) => `${entry.event} ${entry.sessionId}${entry.steer ? " steer" : ""}: ${entry.text?.slice(-200)}`);
} finally {
  await runCauseEffect(instance.agents.stop()).catch(() => {});
  instance.database.close();
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "report.json"), `${JSON.stringify(report, null, 1)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 1)}\n`);
  await rm(root, { recursive: true, force: true });
}
process.exit(report.passed ? 0 : 1);
