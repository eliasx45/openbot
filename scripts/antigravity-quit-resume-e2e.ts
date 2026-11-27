// Fork (docs/fork/FEATURES.md #126): a Gemini (Antigravity) agent whose turn runs when OpenBot quits
// gets its wake after the restart. Before, the ACP client settled the turn as interrupted while it
// stopped, so boot recovery found no running turn and the agent stayed silent (Vegapunk, 27 Nov 2026:
// three restarts, three turns dropped). Runs the real agent service twice on one temporary profile
// with the fake `agy acp` of `provider-fakes/agents/antigravity-subagent.ts`, whose `hold-turn` never
// ends by itself. `bun scripts/antigravity-quit-resume-e2e.ts`; writes
// .openbot-build/antigravity-quit-resume-e2e/report.json.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AGENT_PROVIDERS } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import type { AgentBrowserHost } from "../src/backend/agent/turn-lifecycle";
import { installFakeAgent, readJsonl } from "./provider-fakes/host";

const OUT = resolve(import.meta.dirname, "../.openbot-build/antigravity-quit-resume-e2e");
const root = await mkdtemp(join(tmpdir(), "openbot-ag-quit-"));
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
  (await readJsonl<{ event: string; text?: string }>(agyLog)).filter((entry) => entry.event === "prompt");

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
  turnAfterQuit?: { turnId: string; status: string } | undefined;
  noteAtQuit?: { state: string; quit: boolean | undefined; requestText: string } | undefined;
  wake?: string | undefined;
  noteAfterBoot?: { state: string; quit: boolean | null } | undefined;
  error?: string;
}

const report: Report = { passed: false };
try {
  await installFakeAgent(fakeAgy, "antigravity-subagent", { FAKE_LOG: agyLog, FAKE_CONTROL: control });

  // Run 1: a turn that runs when OpenBot quits.
  const first = start();
  await runCauseEffect(first.agents.initialize());
  const agent = await runCauseEffect(
    first.agents.createAgent({
      name: "Vega",
      description: "Vega checks that a Gemini turn continues after a restart.",
      avatarSeed: "vega",
      avatarHue: null,
      initialMessage: "first-turn",
      provider: "antigravity",
    }),
  );
  await waitFor(
    "the first turn",
    async () => first.agents.listQueue(agent.id).deliveries.length > 0 && idle(first.agents, agent.id),
  );
  await runCauseEffect(first.agents.sendMessage({ agentId: agent.id, text: "hold-turn" }));
  await waitFor(
    "the held turn to run",
    async () =>
      (await prompts()).some((entry) => entry.text === "hold-turn") &&
      first.agents.listQueue(agent.id).deliveries.some((delivery) => delivery.status === "running"),
  );
  await runCauseEffect(first.agents.stop());
  first.database.close();

  const sqlite = new DatabaseSync(join(userData, "openbot.db"));
  const turns = sqlite
    .prepare("SELECT turn_id, status FROM projection_turns ORDER BY started_at")
    .all()
    .map((row) => ({ turnId: String(row.turn_id), status: String(row.status) }));
  sqlite.close();
  const held = turns.at(-1);
  report.turnAfterQuit = held;
  // The cause: the ACP client settles the turn while OpenBot quits.
  assert.equal(held?.status, "interrupted", "The quit settles the Gemini turn as interrupted.");
  const saved = JSON.parse(readFileSync(join(userData, "fork-restart-resume.json"), "utf8"));
  const note = saved.entries.find((entry: { key: string }) => entry.key === `turn:${held?.turnId}`);
  report.noteAtQuit = note && { state: note.state, quit: note.quit, requestText: note.requestText };
  assert.equal(note?.state, "pending", "The quit notes the running turn.");
  assert.equal(note?.requestText, "hold-turn", "The note keeps the request.");

  // Run 2: the agent gets one wake in its own chat.
  const before = (await prompts()).length;
  const second = start();
  await runCauseEffect(second.agents.initialize());
  const wake = await waitFor("the wake prompt", async () =>
    (await prompts()).slice(before).find((entry) => entry.text?.includes("[OpenBot: 🔄 restart]")),
  );
  report.wake = wake.text?.slice(0, 300);
  await waitFor("the wake turn to end", async () => idle(second.agents, agent.id));
  const wakes = (await prompts()).slice(before).filter((entry) => entry.text?.includes("[OpenBot: 🔄 restart]"));
  assert.equal(wakes.length, 1, "One wake, not more.");
  const after = JSON.parse(readFileSync(join(userData, "fork-restart-resume.json"), "utf8"));
  const queued = after.entries.find((entry: { key: string }) => entry.key === `turn:${held?.turnId}`);
  report.noteAfterBoot = queued && { state: queued.state, quit: queued.quit ?? null };
  assert.equal(queued?.state, "queued", "The note's wake ran.");
  assert.equal(queued?.quit, undefined, "The quit mark is cleared at start.");
  await runCauseEffect(second.agents.stop());
  second.database.close();
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
