// Fork (docs/fork/FEATURES.md #92): an MCP change no longer ends a Gemini (Antigravity) agent's
// subagents in silence. Runs the real agent service on a temporary profile with the fake `agy acp`
// of `provider-fakes/agents/antigravity-subagent.ts`, whose `spawn-hold-two` subagents run until the
// test lets each one finish. Antigravity runs a session's subagents in the session's own process, so
// closing that process for a refresh ended them (Vegapunk, 22 Nov 2026: 5 subagents, SIGTERM 8 ms
// after `servers:mcp:set-enabled`).
// Cases:
//   scoped-and-waits: turning off a server that the agent cannot use keeps its session; turning off
//     one it uses while 2 subagents run keeps the process too, and the chat says why; when both
//     subagents reported, the change is applied (the session closes, its process gets SIGTERM).
//   limit-stops-and-tells: with a short limit, the change is applied anyway once the limit passes;
//     both subagents show "stopped", the chat has a line, and the agent gets one wake that names
//     each stopped subagent, its conversation and its task.
//   crash-stops-and-tells: the session's process ends by itself (SIGKILL): both cards show "stopped",
//     and the agent gets the same wake. Before, the cards stayed "running" and the agent was not told.
// `bun run test:antigravity-restart-keeps-subagents`. Writes
// .openbot-build/antigravity-restart-keeps-subagents-e2e/report.json.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AGENT_PROVIDERS, type ConversationSubagent, type McpServerConfig } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import type { AgentBrowserHost } from "../src/backend/agent/turn-lifecycle";
import { installFakeAgent, readJsonl } from "./provider-fakes/host";

const OUT = resolve(import.meta.dirname, "../.openbot-build/antigravity-restart-keeps-subagents-e2e");
const root = await mkdtemp(join(tmpdir(), "openbot-ag-restart-"));
const home = join(root, "home");
const control = join(root, "control");
const fakeAgy = join(root, "antigravity", "1.5.14", "bin", "antigravity");
const agyLog = join(root, "agy.jsonl");
const mcpScript = join(root, "idle-mcp.js");

// Before the service modules load: the stores and the CLI search read these.
process.env.HOME = home;
process.env.GEMINI_HOME = join(home, ".gemini");
process.env.OPENBOT_ANTIGRAVITY_PATH = fakeAgy;
// The wake of stopped subagents starts at once, not after the 10 s that the user has to cancel it.
process.env.OPENBOT_FORK_RESTART_RESUME_GRACE_MS = "100";
process.env.OPENBOT_FORK_RESTART_RESUME_STAGGER_MS = "100";
mkdirSync(home, { recursive: true });
mkdirSync(control, { recursive: true });
writeFileSync(mcpScript, "process.stdin.resume();\n");

const { AgentService } = await import("../src/backend/agent-service");
const { AgentStore } = await import("../src/backend/agent-store");
const { runCauseEffect } = await import("../src/backend/effect-boundary");
const { MailboxStore } = await import("../src/backend/mailbox-store");
const { OpenBotDatabase } = await import("../src/backend/openbot-database");

interface LogEntry {
  event: string;
  sessionId?: string;
  text?: string;
}

interface SessionRow {
  session: string;
  state: string;
}

/** What each case saw, for the report. */
interface CaseDetails {
  afterOtherServer?: SessionRow | null;
  children?: string[];
  whileRunning?: SessionRow | null;
  note?: string;
  afterBoth?: SessionRow;
  afterLimit?: SessionRow;
  cards?: { title: string; status: string }[];
  wake?: string | undefined;
  lines?: string[];
}

interface CaseReport {
  name: string;
  passed: boolean;
  details: CaseDetails;
  error?: string;
}

const report: { cases: CaseReport[]; passed: boolean } = { cases: [], passed: false };
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

/** Waits for a state of the service, its database or the fake's log. */
async function waitFor<T>(label: string, read: () => Promise<T | null | undefined | false>, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((done) => setTimeout(done, 25));
  }
}

const entries = () => readJsonl<LogEntry>(agyLog);

function server(name: string): McpServerConfig {
  return {
    id: "",
    name,
    transport: "stdio",
    enabled: true,
    command: process.execPath,
    args: [mcpScript],
    env: [],
    envPassthrough: [],
    workingDirectory: "",
    url: "",
    headers: [],
  };
}

type Service = InstanceType<typeof AgentService>;

interface Profile {
  agents: Service;
  /** Ids of the servers that no agent may use. */
  blocked: Set<string>;
  sqlite: () => DatabaseSync;
}

async function runCase(name: string, run: (profile: Profile, details: CaseDetails) => Promise<void>) {
  const result: CaseReport = { name, passed: false, details: {} };
  report.cases.push(result);
  const database = new OpenBotDatabase(join(root, `user-data-${name}`));
  const store = new AgentStore(database.userDataPath, home, database);
  const mailbox = new MailboxStore(database.userDataPath, store.sharedRoot, store.database);
  const blocked = new Set<string>();
  const agents = new AgentService({
    store,
    mailbox,
    browser,
    preferredProvider: "antigravity",
    offProviders: AGENT_PROVIDERS.filter((candidate) => candidate !== "antigravity"),
    timezone: () => "UTC",
    mcpAgentAccess: (mcpServerId) => !blocked.has(mcpServerId),
  });
  const connection: { open: DatabaseSync | null } = { open: null };
  const sqlite = () => {
    connection.open ??= new DatabaseSync(database.path);
    return connection.open;
  };
  try {
    await runCauseEffect(agents.initialize());
    await run({ agents, blocked, sqlite }, result.details);
    result.passed = true;
  } catch (error) {
    result.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
  } finally {
    await runCauseEffect(agents.stop()).catch(() => {});
    connection.open?.close();
    database.close();
  }
}

const idle = (agents: Service, agentId: string) =>
  agents
    .listQueue(agentId)
    .deliveries.every((delivery) => !["queued", "starting", "running"].includes(delivery.status));

/** Creates the Gemini agent, and waits for its first turn to end. */
async function createAgent(agents: Service) {
  const agent = await runCauseEffect(
    agents.createAgent({
      name: "Vega",
      description: "Vega checks that subagents outlive an MCP change.",
      avatarSeed: "vega",
      avatarHue: null,
      initialMessage: "first-turn",
      provider: "antigravity",
    }),
  );
  await waitFor(
    "the first turn",
    async () => agents.listQueue(agent.id).deliveries.length > 0 && idle(agents, agent.id),
  );
  return agent;
}

/** The provider session row of the agent's own thread. */
function sessionRow(sqlite: () => DatabaseSync, agents: Service, agentId: string) {
  const threadId = agents.listAgents().find((agent) => agent.id === agentId)?.threadId;
  const rows = sqlite()
    .prepare("SELECT external_session_id, state FROM projection_provider_sessions WHERE thread_id = ? ORDER BY rowid")
    .all(threadId ?? "")
    .map((row) => ({ session: String(row.external_session_id), state: String(row.state) }));
  return rows.at(-1) ?? null;
}

/** The subagent cards of the agent's chat, with the system lines. */
async function chat(agents: Service, agentId: string) {
  const snapshot = await runCauseEffect(agents.readConversation(agentId));
  const subagents: ConversationSubagent[] = snapshot.messages.flatMap((message) => message.subagents ?? []);
  const lines = snapshot.messages.filter((message) => message.author === "system").map((message) => message.text);
  return { subagents, lines };
}

/** Sends `spawn-hold-two`, and waits until both subagents run. Returns their sessions. */
async function spawnTwo(agents: Service, agentId: string): Promise<string[]> {
  const before = (await entries()).length;
  await runCauseEffect(agents.sendMessage({ agentId, text: "spawn-hold-two" }));
  const running = await waitFor("both subagents to run", async () => {
    const found = (await entries()).slice(before).filter((entry) => entry.event === "child-running");
    return found.length >= 2 ? found : null;
  });
  await waitFor("the turn that started them to end", async () => idle(agents, agentId));
  return running.map((entry) => entry.sessionId ?? "");
}

/** The fake's processes that got SIGTERM. */
const terminated = async () =>
  new Set((await entries()).filter((entry) => entry.event === "sigterm").map((entry) => entry.text));

try {
  await installFakeAgent(fakeAgy, "antigravity-subagent", { FAKE_LOG: agyLog, FAKE_CONTROL: control });

  await runCase("scoped-and-waits", async ({ agents, blocked, sqlite }, details) => {
    const [used] = await runCauseEffect(agents.saveMcpServer({ config: server("used") }));
    const saved = await runCauseEffect(agents.saveMcpServer({ config: server("other") }));
    const other = saved.find((config) => config.name === "other");
    assert.ok(used && other, "Both servers are saved.");
    blocked.add(other.id);
    const agent = await createAgent(agents);
    const first = sessionRow(sqlite, agents, agent.id);
    assert.equal(first?.state, "active", "The first turn opens a session.");

    // A server the agent cannot use: its session stays.
    await runCauseEffect(agents.setMcpServerEnabled({ mcpServerId: other.id, enabled: false }));
    const afterOther = sessionRow(sqlite, agents, agent.id);
    details.afterOtherServer = afterOther;
    assert.deepEqual(afterOther, first, "A change to a server the agent cannot use keeps its session.");

    // A server it uses, while 2 subagents run: the process stays until they end.
    const children = await spawnTwo(agents, agent.id);
    details.children = children;
    const sigtermsBefore = (await terminated()).size;
    await runCauseEffect(agents.setMcpServerEnabled({ mcpServerId: used.id, enabled: false }));
    const whileRunning = sessionRow(sqlite, agents, agent.id);
    details.whileRunning = whileRunning;
    assert.deepEqual(whileRunning, first, "The change waits: the session and its process stay.");
    const note = await waitFor("the chat's note", async () =>
      (await chat(agents, agent.id)).lines.find((line) => line.includes("MCP change applies")),
    );
    details.note = note;
    assert.match(note, /when its 2 subagents finish/u);

    writeFileSync(join(control, "finish-harvest-left"), "");
    await waitFor("the first subagent's report", async () =>
      (await entries()).some((entry) => entry.event === "child-done" && entry.text === "harvest-left"),
    );
    await waitFor("its card to complete", async () =>
      (await chat(agents, agent.id)).subagents.some(
        (subagent) => subagent.prompt === "harvest-left" && subagent.status === "completed",
      ),
    );
    assert.equal(sessionRow(sqlite, agents, agent.id)?.state, "active", "One subagent still runs: the session stays.");

    writeFileSync(join(control, "finish-harvest-right"), "");
    const closed = await waitFor("the change to apply once both reported", async () => {
      const row = sessionRow(sqlite, agents, agent.id);
      return row && row.session === first?.session && row.state !== "active" ? row : null;
    });
    details.afterBoth = closed;
    await waitFor("the session's process to get SIGTERM", async () => (await terminated()).size > sigtermsBefore);
    const { subagents } = await chat(agents, agent.id);
    details.cards = subagents.map(({ title, status }) => ({ title, status }));
    assert.deepEqual(
      subagents.map((subagent) => subagent.status),
      ["completed", "completed"],
      "Both subagents completed; none was stopped.",
    );
  });

  // A short limit, read when the client starts.
  process.env.OPENBOT_ACP_SUBAGENT_HOLD_LIMIT_MS = "1500";
  await rm(control, { recursive: true, force: true });
  mkdirSync(control, { recursive: true });
  await runCase("limit-stops-and-tells", async ({ agents, sqlite }, details) => {
    const [used] = await runCauseEffect(agents.saveMcpServer({ config: server("used") }));
    assert.ok(used);
    const agent = await createAgent(agents);
    const first = sessionRow(sqlite, agents, agent.id);
    const children = await spawnTwo(agents, agent.id);
    const promptsBefore = (await entries()).filter((entry) => entry.event === "prompt").length;
    await runCauseEffect(agents.setMcpServerEnabled({ mcpServerId: used.id, enabled: false }));
    assert.equal(sessionRow(sqlite, agents, agent.id)?.state, "active", "The change waits first.");
    const closed = await waitFor("the limit to apply the change", async () => {
      const row = sessionRow(sqlite, agents, agent.id);
      return row && row.session === first?.session && row.state !== "active" ? row : null;
    });
    details.afterLimit = closed;
    const stopped = await waitFor("both cards to show stopped", async () => {
      const { subagents } = await chat(agents, agent.id);
      return subagents.length === 2 && subagents.every((subagent) => subagent.status === "stopped") ? subagents : null;
    });
    details.cards = stopped.map(({ title, status }) => ({ title, status }));
    const wake = await waitFor("the agent's wake", async () =>
      (await entries())
        .filter((entry) => entry.event === "prompt")
        .slice(promptsBefore)
        .find((entry) => entry.text?.includes("[OpenBot: 🔄 restart]")),
    );
    details.wake = wake.text;
    const text = wake.text ?? "";
    assert.match(text, /Antigravity process/u, "The wake says why the subagents stopped.");
    for (const child of children) assert.ok(text.includes(child), `The wake names the conversation ${child}.`);
    assert.ok(text.includes("Worker 1") && text.includes("Worker 2"), "The wake names both subagents.");
    assert.match(text, /invoke_subagent only for the work that is left/u, "The wake says how to go on.");
    assert.ok(text.includes("harvest-left") && text.includes("harvest-right"), "The wake gives each task.");
    assert.doesNotMatch(text, /SendMessage/u, "No Claude tool is named.");
    const { lines } = await chat(agents, agent.id);
    details.lines = lines;
    assert.ok(
      lines.some((line) => line.includes("MCP change applies")),
      "The chat said that the change waited.",
    );
  });

  // The process that runs the session and its subagents ends by itself.
  await runCase("crash-stops-and-tells", async ({ agents }, details) => {
    const agent = await createAgent(agents);
    const children = await spawnTwo(agents, agent.id);
    const pid = Number(/-child-(\d+)-/u.exec(children[0] ?? "")?.[1]);
    assert.ok(pid > 0, "The subagents' process is known.");
    const promptsBefore = (await entries()).filter((entry) => entry.event === "prompt").length;
    process.kill(pid, "SIGKILL");
    const stopped = await waitFor("both cards to show stopped", async () => {
      const { subagents } = await chat(agents, agent.id);
      return subagents.length === 2 && subagents.every((subagent) => subagent.status === "stopped") ? subagents : null;
    });
    details.cards = stopped.map(({ title, status }) => ({ title, status }));
    const wake = await waitFor("the agent's wake", async () =>
      (await entries())
        .filter((entry) => entry.event === "prompt")
        .slice(promptsBefore)
        .find((entry) => entry.text?.includes("[OpenBot: 🔄 restart]")),
    );
    const text = wake.text ?? "";
    details.wake = text.slice(text.indexOf("[OpenBot"));
    assert.match(text, /the Antigravity process they ran in ended by itself/u);
    for (const child of children) assert.ok(text.includes(child), `The wake names the conversation ${child}.`);
  });

  report.passed = report.cases.length === 3 && report.cases.every((entry) => entry.passed);
} finally {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await rm(root, { recursive: true, force: true });
  for (const entry of report.cases) {
    process.stdout.write(`${entry.passed ? "PASS" : "FAIL"} ${entry.name} ${JSON.stringify(entry.details)}\n`);
    if (entry.error) process.stdout.write(`${entry.error}\n`);
  }
  process.stdout.write(`${report.passed ? "PASS" : "FAIL"} ${join(OUT, "report.json")}\n`);
  if (!report.passed) process.exitCode = 1;
}
