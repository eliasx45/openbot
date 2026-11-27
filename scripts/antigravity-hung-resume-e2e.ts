// Fork (docs/fork/FEATURES.md #131): after OpenBot ends a hung Gemini (Antigravity) agent, its chat
// resumes by itself in the same session, and the lead that asked it for work gets a "⏳ continues by
// itself" note, then the answer, instead of a failure. Before, the kill's message classified as
// `unknown`, so no resume was opened (4 kills on 27 Nov 2026, 15:28–15:35Z, no wait after any), and
// the lead got "the request failed before the teammate answered" and resent or restarted the work.
// Runs the real agent service with the fake `agy acp` of `provider-fakes/agents/slow-probe.ts`, which
// answers no `session/list` probe, with the stall, hang and probe times shortened by environment.
// Checks: (1) a teammate request whose turn hangs before answering: ⏳ note, wake in the same session,
// the wake's answer goes to the lead as the reply, no failure note; (2) a turn that already answered
// stays completed and is resumed; (3) once the resume limit (3 an hour) is spent, the lead gets the
// failure note as before. `bun scripts/antigravity-hung-resume-e2e.ts`; writes
// .openbot-build/antigravity-hung-resume-e2e/report.json.
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

const OUT = resolve(import.meta.dirname, "../.openbot-build/antigravity-hung-resume-e2e");
const WAKE = "[OpenBot: 🔄 provider restarted]";
const NOTE = "⏳ Chopper's provider was restarted by OpenBot; it continues by itself";
const root = await mkdtemp(join(tmpdir(), "openbot-ag-hung-"));
const home = join(root, "home");
const fakeAgy = join(root, "antigravity", "1.5.17", "bin", "antigravity");
const agyLog = join(root, "agy.jsonl");
const userData = join(root, "user-data");

process.env.HOME = home;
process.env.GEMINI_HOME = join(home, ".gemini");
process.env.OPENBOT_ANTIGRAVITY_PATH = fakeAgy;
process.env.OPENBOT_FORK_ACP_TURN_STALL_MS = "500";
process.env.OPENBOT_FORK_ACP_HANG_MS = "3000";
process.env.OPENBOT_FORK_ACP_HANG_PROBE_MS = "200";
process.env.OPENBOT_FORK_ACP_IGNORE_LOAD = "1";
mkdirSync(home, { recursive: true });

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

async function waitFor<T>(label: string, read: () => Promise<T | null | undefined | false>, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((done) => setTimeout(done, 50));
  }
}

const prompts = async () =>
  (await readJsonl<{ event: string; sessionId?: string; text?: string }>(agyLog)).filter(
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
    requestTimeoutMs: 3_000,
  });
  return { database, mailbox, agents };
}
type Run = ReturnType<typeof start>;

const idle = (run: Run, agentId: string) =>
  run.agents
    .listQueue(agentId)
    .deliveries.every((delivery) => !["queued", "starting", "running"].includes(delivery.status));

async function writeMessage(from: string, to: string, text: string): Promise<string> {
  const database = new OpenBotDatabase(userData);
  const store = new AgentStore(database.userDataPath, home, database);
  const mailbox = new MailboxStore(database.userDataPath, store.sharedRoot, store.database);
  await runCauseEffect(mailbox.initialize());
  const receipt = await runCauseEffect(
    mailbox.enqueue({
      sender: { kind: "agent", agentId: from },
      recipientAgentIds: [to],
      text,
      replyToMessageId: null,
      expectsReply: true,
    }),
  );
  database.close();
  return receipt.messageId;
}

function turnStatus(turnId: string | null): string | null {
  const sqlite = new DatabaseSync(join(userData, "openbot.db"));
  const row = sqlite.prepare("SELECT status FROM projection_turns WHERE turn_id = ?").get(turnId ?? "");
  sqlite.close();
  return row ? String(row.status) : null;
}

interface Report {
  passed: boolean;
  teammate?: {
    hungPromptSession?: string | undefined;
    wakeSession?: string | undefined;
    wake?: string | undefined;
    noteToLead?: string | undefined;
    replyToLead?: string | undefined;
    failureNotes: number;
  };
  answered?: { turnStatus: string | null; wakes: number; failureNotes: number };
  limit?: { failureNote?: string | undefined; wakes: number };
  error?: string;
}

const report: Report = { passed: false };
let run: Run | null = null;
try {
  await installFakeAgent(fakeAgy, "slow-probe", { FAKE_LOG: agyLog, FAKE_SILENT_LISTS: "999" });

  // Run 1: the lead and its teammate.
  const setup = start();
  run = setup;
  await runCauseEffect(setup.agents.initialize());
  const create = (name: string) =>
    runCauseEffect(
      setup.agents.createAgent({
        name,
        description: `${name} works in the hung provider check.`,
        avatarSeed: name.toLowerCase(),
        avatarHue: null,
        initialMessage: "first-turn",
        provider: "antigravity",
      }),
    );
  const vega = await create("Vegapunk");
  const chopper = await create("Chopper");
  await waitFor("the first turns", async () =>
    [vega, chopper].every((agent) => setup.agents.listQueue(agent.id).deliveries.length > 0 && idle(setup, agent.id)),
  );
  await runCauseEffect(setup.agents.stop());
  setup.database.close();
  run = null;

  // (1) The lead asks the teammate for work; the teammate's agent hangs before it answers.
  const request = await writeMessage(vega.id, chopper.id, "quiet-600000");
  run = start();
  const current = run;
  await runCauseEffect(current.agents.initialize());
  const toLead = () =>
    current.agents.listQueue(vega.id).deliveries.filter((delivery) => delivery.sender.kind === "agent");
  const hung = await waitFor("the hung prompt", async () =>
    (await prompts()).find((entry) => entry.text?.includes("quiet-600000") && !entry.text.includes("[OpenBot:")),
  );
  const wake = await waitFor("the resume wake", async () =>
    (await prompts()).find((entry) => entry.text?.includes(WAKE)),
  );
  const reply = await waitFor("the resumed answer to reach the lead", async () =>
    toLead().find((delivery) => delivery.replyToMessageId === request),
  );
  await waitFor("everyone idle", async () => idle(current, vega.id) && idle(current, chopper.id));
  report.teammate = {
    hungPromptSession: hung.sessionId,
    wakeSession: wake.sessionId,
    wake: wake.text?.slice(wake.text.indexOf(WAKE), wake.text.indexOf(WAKE) + 900),
    noteToLead: toLead().find((delivery) => delivery.text.startsWith(NOTE))?.text,
    replyToLead: reply.text,
    failureNotes: toLead().filter((delivery) => delivery.text.startsWith("Status: blocked")).length,
  };
  assert.equal(wake.sessionId, hung.sessionId, "The chat resumes in the same session.");
  assert.ok(wake.text?.includes("quiet-600000"), "The wake names the request it continues.");
  assert.ok(wake.text?.includes("Vegapunk asked for this"), "The wake says the lead waits for the answer.");
  assert.ok(report.teammate.noteToLead, "The lead gets the ⏳ note.");
  assert.equal(report.teammate.failureNotes, 0, "The lead gets no failure note.");
  assert.equal(reply.text, "ok", "The resumed turn's answer goes to the lead as the reply.");

  // (2) A turn that already answered and waits for its background job.
  const wakesBefore = (await prompts()).filter((entry) => entry.text?.includes(WAKE)).length;
  await runCauseEffect(current.agents.sendMessage({ agentId: chopper.id, text: "hold-600000" }));
  const heldTurn = await waitFor(
    "the held turn",
    async () =>
      current.agents.listQueue(chopper.id).deliveries.find((delivery) => delivery.text === "hold-600000")?.turnId,
  );
  await waitFor("the second resume wake", async () =>
    (await prompts()).filter((entry) => entry.text?.includes(WAKE)).length > wakesBefore ? true : null,
  );
  await waitFor("everyone idle", async () => idle(current, vega.id) && idle(current, chopper.id));
  const answeredWake = (await prompts()).filter((entry) => entry.text?.includes(WAKE)).at(-1);
  report.answered = {
    turnStatus: turnStatus(heldTurn),
    wakes: (await prompts()).filter((entry) => entry.text?.includes(WAKE)).length - wakesBefore,
    failureNotes: toLead().filter((delivery) => delivery.text.startsWith("Status: blocked")).length,
  };
  assert.equal(report.answered.turnStatus, "completed", "A turn that answered is not failed.");
  assert.ok(answeredWake?.text?.includes("Your answer of that turn was kept."), "The wake says the answer stands.");

  // (3) The third resume of the hour runs; the fourth would loop, so the lead gets the failure note.
  // The limit is kept in memory, so this runs in the same service run.
  const wakesThird = (await prompts()).filter((entry) => entry.text?.includes(WAKE)).length;
  await runCauseEffect(current.agents.sendMessage({ agentId: chopper.id, text: "quiet-600001" }));
  await waitFor("the third resume wake", async () =>
    (await prompts()).filter((entry) => entry.text?.includes(WAKE)).length > wakesThird ? true : null,
  );
  await waitFor("everyone idle", async () => idle(current, vega.id) && idle(current, chopper.id));
  await runCauseEffect(
    current.mailbox.enqueue({
      sender: { kind: "agent", agentId: vega.id },
      recipientAgentIds: [chopper.id],
      text: "quiet-600002",
      replyToMessageId: null,
      expectsReply: true,
    }),
  );
  // A message of the user makes the service drain Chopper's queue, the request first.
  await runCauseEffect(current.agents.sendMessage({ agentId: chopper.id, text: "after the request" }));
  const last = current;
  const blocked = await waitFor(
    "the failure note after the resume limit",
    async () =>
      last.agents
        .listQueue(vega.id)
        .deliveries.find((delivery) => delivery.sender.kind === "agent" && delivery.text.startsWith("Status: blocked")),
    120_000,
  );
  report.limit = {
    failureNote: blocked.text.slice(0, 300),
    wakes: (await prompts()).filter((entry) => entry.text?.includes(WAKE)).length,
  };
  assert.ok(blocked.text.includes("did not answer in time"), "The failure note names the hung provider.");
  await waitFor("everyone idle", async () => idle(last, vega.id) && idle(last, chopper.id), 120_000);
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
} finally {
  if (run) {
    await runCauseEffect(run.agents.stop()).catch(() => undefined);
    run.database.close();
  }
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "report.json"), `${JSON.stringify(report, null, 1)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 1)}\n`);
  if (process.env.KEEP !== "1") await rm(root, { recursive: true, force: true });
  else process.stdout.write(`kept ${root}\n`);
}
process.exit(report.passed ? 0 : 1);
