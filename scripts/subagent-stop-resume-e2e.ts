// Fork (docs/fork/FEATURES.md, "Stopped subagents continue"): when a Claude process ends while
// OpenBot runs, its background subagents stop with it, and the agent gets one wake that tells it to
// continue them with SendMessage. Runs the real agent service on a temporary profile with a stand-in
// `claude` executable that starts a background subagent ("bg-start <n>") and can be killed. Cases:
// - crash-wakes: the process is killed; the wake runs in the same session and names the agent ID.
// - user-cancels: Cancel on the wait keeps the subagent stopped; no wake.
// - user-writes-first: a message before the wake runs instead; a line says it was not continued.
// - context-reset: a cleared context closes the process and gives a new session; a line, no wake.
// - autoresume-off: no wait and no wake; a line says /autoresume is off.
// - loop-limit: the 4th stop in an hour gets a line instead of a wake (closes by a tool refresh).
// - foreground-no-wake: a foreground subagent that dies with its turn gets no wake.
// - quit-no-live-note: OpenBot quitting notes nothing live (the restart resume covers it).
// - finished-before-stop: the subagent's transcript ends with its final answer (its "done" was lost
//   with the process): the wake hands over that answer and says not to continue it.
// - account-switch (fork #72): the agent runs on a second Claude account; it moves back to the
//   default account and its next message stops the account's process. The subagent shows stopped and
//   the agent no longer shows as working. Before, it stayed "running" until a restart (Adrian, 11 Nov).
// `bun scripts/subagent-stop-resume-e2e.ts`. Writes .openbot-build/subagent-stop-resume-e2e/report.json.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AGENT_PROVIDERS, defaultProviderModel } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import type { AgentClientFactory } from "../src/backend/agent/provider-runtime";
import type { AgentBrowserHost } from "../src/backend/agent/turn-lifecycle";
import type { AgentClient, DiagnosticOrigin } from "../src/backend/agent-client";
import type { ClaudeCliInfo } from "../src/backend/cli";
import type { AppServerNotification, AppServerRequest, RequestId, ResponseDecoder } from "../src/backend/protocol";
import { providerSync } from "../src/backend/provider-client-effects";
import type { ReadProviderHistory } from "../src/backend/provider-history";

const OUT = resolve(import.meta.dirname, "../.openbot-build/subagent-stop-resume-e2e");
const root = await mkdtemp(join(tmpdir(), "openbot-subagent-stop-"));
const home = join(root, "home");
const claudeExecutable = join(root, "claude");
const claudeSpawns = join(root, "claude-spawns.jsonl");
const claudeMessages = join(root, "claude-messages.jsonl");
/** Where the stand-in keeps its session transcripts, as Claude does under its config folder. */
const claudeProjects = join(home, ".claude", "projects");
const CLAUDE_MODEL = defaultProviderModel("claude");
const GRACE_MS = 600;

// Before the service modules load: the stores, the CLI search and the resume timings read these.
process.env.HOME = home;
// Bun reads the real home folder for homedir(): name the Claude folder explicitly.
process.env.CLAUDE_CONFIG_DIR = join(home, ".claude");
process.env.OPENBOT_CLAUDE_PATH = claudeExecutable;
process.env.OPENBOT_FORK_RESTART_RESUME_GRACE_MS = String(GRACE_MS);
process.env.OPENBOT_FORK_RESTART_RESUME_STAGGER_MS = "50";
process.env.OPENBOT_FORK_RESTART_RESUME_PROVIDER_WAIT_MS = "20000";
mkdirSync(home, { recursive: true });

const { AgentService } = await import("../src/backend/agent-service");
const { AgentStore } = await import("../src/backend/agent-store");
const { ClaudeAgentClient } = await import("../src/backend/claude-client");
const { runCauseEffect } = await import("../src/backend/effect-boundary");
const { MailboxStore } = await import("../src/backend/mailbox-store");
const { OpenBotDatabase } = await import("../src/backend/openbot-database");
const { forkHub } = await import("../src/backend/fork-hub");
const { ProviderAccountStore } = await import("../src/backend/agent/provider-account-store");

/**
 * The stand-in for the Claude CLI. "bg-start <n>" starts a background subagent "agent-bg-<n>" that
 * never ends by itself ("bg-quiet bg-start <n>": a CLI that does not report it in its background
 * level, so a tool refresh closes the process); "fg-start" starts a foreground one and leaves the turn running. Every other
 * message ends its turn with "Done.". It logs each start and each user message.
 */
const STAND_IN_CLAUDE = `#!${process.execPath}
const fs = require("node:fs");
const { randomUUID } = require("node:crypto");
const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("2.1.302 (Claude Code)\\n");
  process.exit(0);
}
const option = (name) => {
  const index = args.findIndex((arg) => arg === name || arg.startsWith(name + "="));
  if (index < 0) return null;
  return args[index] === name ? (args[index + 1] ?? null) : args[index].slice(name.length + 1);
};
const resume = option("--resume");
const sessionId = resume ?? option("--session-id") ?? randomUUID();
fs.appendFileSync(${JSON.stringify(claudeSpawns)}, JSON.stringify({ pid: process.pid, resume, sessionId }) + "\\n");
const write = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
let requests = 0;
const usage = { input_tokens: 10, cache_read_input_tokens: 100, output_tokens: 20 };
const assistant = (content) => write({ type: "assistant", message: { id: "msg_" + process.pid + "_" + (++requests), type: "message",
  role: "assistant", model: ${JSON.stringify(CLAUDE_MODEL)}, content, stop_reason: null, usage }, parent_tool_use_id: null,
  session_id: sessionId, uuid: randomUUID() });
const result = () => write({ type: "result", subtype: "success", is_error: false, result: "Done.", session_id: sessionId,
  uuid: randomUUID(), duration_ms: 1, duration_api_ms: 1, num_turns: 1, total_cost_usd: 0.01, usage, permission_denials: [] });
const turn = (message) => {
  const content = message.message?.content;
  const text = typeof content === "string" ? content : (content ?? []).map((block) => block.text ?? "").join("");
  fs.appendFileSync(${JSON.stringify(claudeMessages)}, JSON.stringify({ pid: process.pid, sessionId, text }) + "\\n");
  // A wake quotes the request it continues: it starts nothing again.
  const wake = text.includes("[OpenBot: 🔄 restart]");
  // A new session's first prompt quotes the chat so far, with its "bg-start": "after-switch" starts nothing.
  const background = wake || text.includes("after-switch") ? null : /bg-start (\\d+)/.exec(text);
  if (background) {
    const id = "toolu_bg_" + background[1];
    // The subagent's own transcript, as Claude writes it: here in the middle of a step.
    const project = ${JSON.stringify(claudeProjects)} + "/" + process.cwd().replace(/[^a-zA-Z0-9]/g, "-");
    const folder = project + "/" + sessionId + "/subagents";
    fs.mkdirSync(folder, { recursive: true });
    fs.appendFileSync(project + "/" + sessionId + ".jsonl", "");
    fs.writeFileSync(folder + "/agent-agent-bg-" + background[1] + ".jsonl", [
      { type: "assistant", message: { role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] } },
      { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } },
      { type: "api-request" },
    ].map((record) => JSON.stringify(record)).join("\\n") + "\\n");
    assistant([{ type: "tool_use", id, name: "Agent", input: { description: "Background work " + background[1],
      prompt: "Work.", run_in_background: true } }]);
    write({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id,
      content: [{ type: "text", text: "Async agent launched successfully." }] }] }, parent_tool_use_id: null,
      tool_use_result: { status: "async_launched", isAsync: true, agentId: "agent-bg-" + background[1] },
      session_id: sessionId, uuid: randomUUID() });
    if (!text.includes("bg-quiet"))
      write({ type: "system", subtype: "background_tasks_changed", session_id: sessionId, uuid: randomUUID(),
        tasks: [{ task_id: "task-" + background[1], task_type: "local_agent", description: "Background work" }] });
  }
  if (!wake && text.includes("fg-start")) {
    assistant([{ type: "tool_use", id: "toolu_fg", name: "Agent", input: { description: "Foreground work", prompt: "Work." } }]);
    return;
  }
  assistant([{ type: "text", text: "Done." }]);
  result();
};
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf("\\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    newline = buffer.indexOf("\\n");
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.type === "control_request")
      write({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: {} } });
    else if (message.type === "user") turn(message);
  }
});
process.stdin.on("end", () => process.exit(0));
`;

interface ClientEvents {
  notification: [notification: AppServerNotification];
  request: [request: AppServerRequest];
  exit: [error: Error];
  diagnostic: [message: string, origin?: DiagnosticOrigin];
}

/**
 * The real Claude client. Only the account, usage and model reads are answered here: the real ones
 * run \`claude auth status\` or a probe query. Sessions, turns and events come from the real client.
 */
class ClaudeStandIn extends EventEmitter<ClientEvents> implements AgentClient {
  readonly provider = "claude";
  readonly contextCompaction = "native";
  readonly #real: InstanceType<typeof ClaudeAgentClient>;
  readonly readHistory: ReadProviderHistory;

  constructor(cli: ClaudeCliInfo) {
    super();
    this.#real = new ClaudeAgentClient(cli);
    this.readHistory = this.#real.readHistory;
    this.#real.on("notification", (notification) => this.emit("notification", notification));
    this.#real.on("request", (request) => this.emit("request", request));
    this.#real.on("diagnostic", (message) => this.emit("diagnostic", message));
    this.#real.on("exit", (error) => this.emit("exit", error));
  }

  get running(): boolean {
    return this.#real.running;
  }

  start(): void {
    this.#real.start();
  }

  stop() {
    return this.#real.stop();
  }

  canReleaseProcess = () => this.#real.canReleaseProcess();

  holdsBackgroundWork = (externalThreadId: string) => this.#real.holdsBackgroundWork(externalThreadId);

  endBackgroundWork = () => this.#real.endBackgroundWork();

  forkSubagentOutcomes = (externalThreadId: string, cwd: string, agentIds: readonly string[]) =>
    this.#real.forkSubagentOutcomes(externalThreadId, cwd, agentIds);

  releaseThread(externalThreadId: string) {
    return this.#real.releaseThread(externalThreadId);
  }

  releaseIdleThreads() {
    return this.#real.releaseIdleThreads();
  }

  request<T>(method: string, params: unknown, decoder: ResponseDecoder<T>, timeoutMs?: number) {
    if (!this.#real.running) return this.#real.request(method, params, decoder, timeoutMs);
    switch (method) {
      case "account/read":
        return providerSync(() => decoder({ account: { type: "claude", email: "claude@example.com" } }));
      case "account/rateLimits/read":
        return providerSync(() => decoder({ rateLimits: null, rateLimitsByLimitId: null }));
      case "model/list":
        return providerSync(() => decoder({ data: [{ model: CLAUDE_MODEL, displayName: "Claude" }] }));
      default:
        return this.#real.request(method, params, decoder, timeoutMs);
    }
  }

  notify(): void {
    this.#real.notify();
  }

  respond(id: RequestId, result: unknown): void {
    this.#real.respond(id, result);
  }

  respondError(id: RequestId, error: Parameters<AgentClient["respondError"]>[1]): void {
    this.#real.respondError(id, error);
  }
}

/** What each case saw. Each case sets only its own fields. */
interface CaseDetails {
  waitNote?: string;
  wake?: string;
  note?: { state?: string; cause?: string; attempt?: number; reason?: string | null } | null;
  subagentStatus?: string | null;
  wakes?: number;
  line?: string;
  reason?: string | null;
  woken?: number[];
  liveNotes?: number;
  /** Whether the runtime snapshot still counts the agent as working on subagents. */
  working?: boolean;
  /** The live notes when a wake did not come, to see why. */
  notes?: Array<{ key: string; state: string; reason: string | null }>;
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

/** Waits for a state of the service, of its database, or of a stand-in log. */
async function waitFor<T>(label: string, read: () => T | null | undefined | false, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((done) => setTimeout(done, 25));
  }
}

/** The entries of a JSON-lines log that a stand-in writes. */
function entries<T>(path: string): T[] {
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

type Service = InstanceType<typeof AgentService>;
type Mailbox = InstanceType<typeof MailboxStore>;
type Store = InstanceType<typeof AgentStore>;

interface Profile {
  agents: Service;
  store: Store;
  mailbox: Mailbox;
  sqlite: () => DatabaseSync;
  userData: string;
  /** Stops the service, for the case that checks a quit. */
  stop: () => Promise<void>;
}

const clientFactory: AgentClientFactory = (_provider, cli) => new ClaudeStandIn(cli);

/** Runs one case on its own temporary profile and service, where only Claude is on. */
async function runCase(
  name: string,
  run: (profile: Profile, details: CaseDetails) => Promise<void>,
  accounts?: InstanceType<typeof ProviderAccountStore>,
): Promise<void> {
  const result: CaseReport = { name, passed: false, details: {} };
  report.cases.push(result);
  const userData = join(root, `user-data-${name}`);
  const database = new OpenBotDatabase(userData);
  const store = new AgentStore(database.userDataPath, home, database);
  const mailbox = new MailboxStore(database.userDataPath, store.sharedRoot, store.database);
  const agents = new AgentService({
    store,
    mailbox,
    browser,
    preferredProvider: "claude",
    offProviders: AGENT_PROVIDERS.filter((candidate) => candidate !== "claude"),
    timezone: () => "UTC",
    clientFactory,
    ...(accounts ? { providerAccounts: accounts } : {}),
  });
  let connection: DatabaseSync | null = null;
  const sqlite = () => {
    connection ??= new DatabaseSync(database.path);
    return connection;
  };
  const closeReader = () => connection?.close();
  let stopped = false;
  try {
    await runCauseEffect(agents.initialize());
    const stop = async () => {
      stopped = true;
      await runCauseEffect(agents.stop());
    };
    await run({ agents, store, mailbox, sqlite, userData, stop }, result.details);
    result.passed = true;
  } catch (error) {
    result.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
  } finally {
    if (!stopped) await runCauseEffect(agents.stop()).catch(() => {});
    closeReader();
    database.close();
  }
}

const idle = (agents: Service, agentId: string) =>
  agents
    .listQueue(agentId)
    .deliveries.every((delivery) => !["queued", "starting", "running"].includes(delivery.status));

async function createAgent(agents: Service, name: string) {
  const agent = await runCauseEffect(
    agents.createAgent({
      name,
      description: `${name} checks stopped subagents.`,
      avatarSeed: name.toLowerCase().replaceAll(" ", "-"),
      avatarHue: null,
      initialMessage: "first-turn",
      provider: "claude",
      model: CLAUDE_MODEL,
    }),
  );
  await waitFor(`${name}: a delivery`, () => agents.listQueue(agent.id).deliveries.length > 0);
  await waitFor(`${name}: the first turn to end`, () => idle(agents, agent.id));
  return agent;
}

/** Sends one chat message and waits until the queue is idle again. */
async function sendTurn(agents: Service, agentId: string, text: string): Promise<void> {
  await runCauseEffect(agents.sendMessage({ agentId, text }));
  await waitFor(`${text}: a delivery`, () => agents.listQueue(agentId).deliveries.some((d) => d.text.includes(text)));
  await waitFor(`${text}: the queue to be idle`, () => idle(agents, agentId));
}

/** The process that runs a session now: the newest start of the stand-in for it. */
function processOf(sessionId: string | null): number {
  const spawn = entries<{ pid: number; sessionId: string }>(claudeSpawns)
    .filter((one) => sessionId === null || one.sessionId === sessionId)
    .at(-1);
  assert.ok(spawn, "The stand-in started.");
  return spawn.pid;
}

function sessionOf(profile: Profile, threadId: string): string {
  const row = profile
    .sqlite()
    .prepare(
      "SELECT external_session_id FROM projection_provider_sessions WHERE thread_id = ? AND state = 'active' ORDER BY rowid DESC LIMIT 1",
    )
    .get(threadId);
  assert.ok(row, "The chat has an active session.");
  return String(row.external_session_id);
}

/** The text of the chat's system lines. */
function lines(profile: Profile, threadId: string): string[] {
  return profile
    .sqlite()
    .prepare("SELECT message_json FROM projection_thread_messages WHERE thread_id = ? AND author = 'system'")
    .all(threadId)
    .map((row) => String(JSON.parse(String(row.message_json)).text ?? ""));
}

const wakes = (sessionId: string, agentToken: string) =>
  entries<{ sessionId: string; text: string }>(claudeMessages).filter(
    (one) => one.sessionId === sessionId && one.text.includes("[OpenBot: 🔄 restart]") && one.text.includes(agentToken),
  );

const liveNotes = () => (forkHub.restartResume?.entries() ?? []).filter((entry) => entry.trigger === "process");

/** Starts background subagent `n` in a new turn, and gives the chat's thread and session. */
async function startBackground(profile: Profile, agentId: string, n: number, quiet = false) {
  await sendTurn(profile.agents, agentId, `${quiet ? "bg-quiet " : ""}bg-start ${n}`);
  const threadId = await waitFor(
    "the agent's own thread",
    () => profile.store.list().find((a) => a.id === agentId)?.threadId,
  );
  const sessionId = sessionOf(profile, threadId);
  await waitFor(`subagent ${n} to run in the background`, () => {
    const row = profile
      .sqlite()
      .prepare("SELECT message_json FROM projection_thread_messages WHERE thread_id = ? AND item_type = 'subagents'")
      .all(threadId)
      .map((one) => JSON.parse(String(one.message_json)))
      .flatMap((message) => message.subagents ?? [])
      .find((subagent: { title: string }) => subagent.title === `Background work ${n}`);
    return row?.status === "running" && row.background === true;
  });
  return { threadId, sessionId };
}

const crash = (sessionId: string) => process.kill(processOf(sessionId), "SIGKILL");

/** The subagent writes its final answer, as Claude does when it ends its work. */
function finishSubagent(sessionId: string, n: number, answer: string): void {
  const path = readdirSync(claudeProjects)
    .map((project) => join(claudeProjects, project, sessionId, "subagents", `agent-agent-bg-${n}.jsonl`))
    .find((candidate) => existsSync(candidate));
  assert.ok(path, "The stand-in wrote the subagent transcript.");
  const record = {
    type: "assistant",
    message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: answer }] },
  };
  writeFileSync(path, `${readFileSync(path, "utf8")}${JSON.stringify(record)}\n`);
}

await writeFile(claudeExecutable, STAND_IN_CLAUDE, { mode: 0o755 });

try {
  await runCase("crash-wakes", async (profile, details) => {
    const agent = await createAgent(profile.agents, "Crash lead");
    const { threadId, sessionId } = await startBackground(profile, agent.id, 1);
    crash(sessionId);
    const wait = await waitFor("the wait with Cancel", () => profile.agents.listWaits(agent.id).waits[0]);
    details.waitNote = wait.note;
    assert.ok(wait.note.startsWith("🔄"), "The wait says the subagent continues.");
    const wake = await waitFor("the wake in the same session", () => wakes(sessionId, "agent-bg-1")[0], 30_000);
    details.wake = wake.text.slice(0, 600);
    assert.match(wake.text, /crashed/u, "The wake says the process crashed.");
    assert.match(wake.text, /SendMessage/u, "The wake says to continue it with SendMessage.");
    assert.match(wake.text, /stopped mid-task/u, "Its transcript ends mid-step: it is continued.");
    await waitFor("the wake turn to end", () => idle(profile.agents, agent.id));
    const note = liveNotes()[0];
    details.note = note
      ? { state: note.state, ...(note.cause ? { cause: note.cause } : {}), attempt: note.attempt }
      : null;
    assert.equal(note?.state, "queued");
    assert.equal(note?.cause, "crashed");
    // The chat shows the subagent stopped, not running. Before, a crash left it "running".
    const status = (): string | undefined =>
      profile
        .sqlite()
        .prepare("SELECT message_json FROM projection_thread_messages WHERE thread_id = ? AND item_type = 'subagents'")
        .all(threadId)
        .flatMap((one) => JSON.parse(String(one.message_json)).subagents ?? [])
        .find((subagent: { title: string }) => subagent.title === "Background work 1")?.status;
    details.subagentStatus = await waitFor("the chat to show the subagent stopped", () =>
      status() === "stopped" ? "stopped" : null,
    );
  });

  await runCase("user-cancels", async (profile, details) => {
    const agent = await createAgent(profile.agents, "Cancel lead");
    const { sessionId } = await startBackground(profile, agent.id, 2);
    crash(sessionId);
    const wait = await waitFor("the wait with Cancel", () => profile.agents.listWaits(agent.id).waits[0]);
    profile.agents.cancelWait(agent.id, wait.id);
    await waitFor("the note to be cancelled", () => liveNotes()[0]?.state === "cancelled", 10_000);
    await new Promise((done) => setTimeout(done, GRACE_MS * 2));
    details.wakes = wakes(sessionId, "agent-bg-2").length;
    assert.equal(details.wakes, 0, "No wake after Cancel.");
  });

  await runCase("user-writes-first", async (profile, details) => {
    const agent = await createAgent(profile.agents, "Writer lead");
    const { threadId, sessionId } = await startBackground(profile, agent.id, 3);
    crash(sessionId);
    await waitFor("the wait", () => profile.agents.listWaits(agent.id).waits[0]);
    await sendTurn(profile.agents, agent.id, "user-after-stop");
    const line = await waitFor("the not-continued line", () =>
      lines(profile, threadId).find((text) => text.includes("a new message came first")),
    );
    details.line = line;
    details.reason = liveNotes()[0]?.reason ?? null;
    details.wakes = wakes(sessionId, "agent-bg-3").length;
    assert.equal(details.wakes, 0, "The message runs instead of the wake.");
    assert.equal(profile.agents.listWaits(agent.id).waits.length, 0, "The wait is closed.");
  });

  await runCase("context-reset", async (profile, details) => {
    const agent = await createAgent(profile.agents, "Reset lead");
    const { threadId, sessionId } = await startBackground(profile, agent.id, 4);
    await runCauseEffect(profile.agents.clearAgentContext(agent.id));
    const line = await waitFor(
      "the session-changed line",
      () => lines(profile, threadId).find((text) => text.includes("new provider session")),
      15_000,
    );
    details.line = line;
    const reset = liveNotes()[0];
    details.note = reset ? { ...(reset.cause ? { cause: reset.cause } : {}), reason: reset.reason } : null;
    assert.equal(liveNotes()[0]?.cause, "closed", "OpenBot closed the process.");
    details.wakes = wakes(sessionId, "agent-bg-4").length;
    assert.equal(details.wakes, 0);
  });

  await runCase("autoresume-off", async (profile, details) => {
    const agent = await createAgent(profile.agents, "Off lead");
    const { threadId, sessionId } = await startBackground(profile, agent.id, 5);
    forkHub.restartResume?.setEnabled(false);
    crash(sessionId);
    const line = await waitFor("the off line", () =>
      lines(profile, threadId).find((text) => text.includes("/autoresume is off")),
    );
    details.line = line;
    await new Promise((done) => setTimeout(done, GRACE_MS * 2));
    assert.equal(profile.agents.listWaits(agent.id).waits.length, 0, "No wait.");
    assert.equal(liveNotes().length, 0, "No note.");
  });

  await runCase("loop-limit", async (profile, details) => {
    const agent = await createAgent(profile.agents, "Loop lead");
    const woken: number[] = [];
    let threadId = "";
    for (let n = 11; n <= 14; n += 1) {
      // A tool refresh closes the process (its CLI reports no background level): a crash loop would
      // also make the provider wait before it starts again.
      const started = await startBackground(profile, agent.id, n, true);
      threadId = started.threadId;
      await runCauseEffect(profile.agents.refreshAllAgentRuntimes());
      if (n < 14) {
        await waitFor(`the wake ${n}`, () => wakes(started.sessionId, `agent-bg-${n}`)[0], 30_000).catch((error) => {
          details.notes = liveNotes().map((note) => ({ key: note.key, state: note.state, reason: note.reason }));
          throw error;
        });
        await waitFor(`the wake ${n} turn to end`, () => idle(profile.agents, agent.id));
        woken.push(n);
      }
    }
    const line = await waitFor("the limit line", () =>
      lines(profile, threadId).find((text) => text.includes("3 times in the last hour")),
    );
    details.woken = woken;
    details.line = line;
    await new Promise((done) => setTimeout(done, GRACE_MS * 2));
    assert.equal(wakes(sessionOf(profile, threadId), "agent-bg-14").length, 0, "The 4th stop gets no wake.");
  });

  await runCase("foreground-no-wake", async (profile, details) => {
    const agent = await createAgent(profile.agents, "Foreground lead");
    await runCauseEffect(profile.agents.sendMessage({ agentId: agent.id, text: "fg-start" }));
    const threadId = await waitFor("the thread", () => profile.store.list().find((a) => a.id === agent.id)?.threadId);
    await waitFor("the foreground turn to run", () =>
      entries<{ text: string }>(claudeMessages).some((one) => one.text.includes("fg-start")),
    );
    await new Promise((done) => setTimeout(done, 300));
    crash(sessionOf(profile, threadId));
    await waitFor("the turn to end", () => idle(profile.agents, agent.id), 30_000);
    await new Promise((done) => setTimeout(done, GRACE_MS * 2));
    details.liveNotes = liveNotes().length;
    assert.equal(details.liveNotes, 0, "A foreground subagent gets no wake.");
  });

  await runCase("quit-no-live-note", async (profile, details) => {
    const agent = await createAgent(profile.agents, "Quit lead");
    await startBackground(profile, agent.id, 6);
    await profile.stop();
    const saved = JSON.parse(readFileSync(join(profile.userData, "fork-restart-resume.json"), "utf8"));
    const notes = (saved.entries ?? []).filter((entry: { trigger?: string }) => entry.trigger === "process");
    details.liveNotes = notes.length;
    assert.equal(notes.length, 0, "Quitting notes nothing live: the restart resume covers it at the next start.");
  });

  await runCase("finished-before-stop", async (profile, details) => {
    const agent = await createAgent(profile.agents, "Finished lead");
    const { sessionId } = await startBackground(profile, agent.id, 7);
    // It finished, and the process died before its "done" notification came.
    finishSubagent(sessionId, 7, "RESULT-7: 34 sounds placed on the yellow tracks.");
    crash(sessionId);
    const wake = await waitFor("the wake", () => wakes(sessionId, "agent-bg-7")[0], 30_000);
    details.wake = wake.text.slice(wake.text.indexOf("[OpenBot"), wake.text.indexOf("[OpenBot") + 700);
    assert.match(wake.text, /finished just before the stop/u, "The wake says it had finished.");
    assert.match(wake.text, /RESULT-7: 34 sounds placed/u, "The wake hands over its final answer.");
    assert.doesNotMatch(wake.text, /stopped mid-task/u, "It is not listed as stopped mid-task.");
    assert.doesNotMatch(wake.text, /continue it with SendMessage/u, "The wake does not say to continue it.");
  });

  const accounts = new ProviderAccountStore(join(root, "provider-accounts.json"), join(root, "provider-accounts"));
  await runCauseEffect(accounts.load());
  const second = await runCauseEffect(accounts.create("claude"));
  assert.ok(second, "The second Claude account was created.");
  await runCase(
    "account-switch",
    async (profile, details) => {
      const agent = await createAgent(profile.agents, "Switch lead");
      await runCauseEffect(profile.agents.updateAgent({ agentId: agent.id, providerAccountId: second.id }));
      const { threadId, sessionId } = await startBackground(profile, agent.id, 8);
      const accountPid = processOf(sessionId);
      const working = () =>
        (profile.agents.getRuntimeSnapshot().subagentTurns ?? []).some((turn) => turn.agentId === agent.id);
      assert.ok(working(), "The background subagent keeps the agent at work.");
      // Back on the default account, as after a usage-limit reset; the next message starts there.
      await runCauseEffect(profile.agents.updateAgent({ agentId: agent.id, providerAccountId: null }));
      await sendTurn(profile.agents, agent.id, "after-switch");
      await waitFor("the account process to end", () => {
        try {
          process.kill(accountPid, 0);
          return false;
        } catch {
          return true;
        }
      });
      const status = (): string | undefined =>
        profile
          .sqlite()
          .prepare(
            "SELECT message_json FROM projection_thread_messages WHERE thread_id = ? AND item_type = 'subagents'",
          )
          .all(threadId)
          .flatMap((one) => JSON.parse(String(one.message_json)).subagents ?? [])
          .find((subagent: { title: string }) => subagent.title === "Background work 8")?.status;
      details.subagentStatus = await waitFor(
        "the chat to show the subagent stopped",
        () => (status() === "stopped" ? "stopped" : null),
        5_000,
      ).catch(() => status() ?? null);
      details.working = working();
      assert.equal(details.subagentStatus, "stopped", "The chat shows the subagent stopped.");
      assert.equal(working(), false, "The agent no longer shows as working.");
    },
    accounts,
  );

  report.passed = report.cases.length === 10 && report.cases.every((entry) => entry.passed);
} finally {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await rm(root, { recursive: true, force: true });
  for (const entry of report.cases) {
    process.stdout.write(`${entry.passed ? "PASS" : "FAIL"} ${entry.name} ${JSON.stringify(entry.details)}\n`);
    if (entry.error) process.stdout.write(`${entry.error}\n`);
  }
  process.stdout.write(`${report.passed ? "PASS" : "FAIL"} ${join(OUT, "report.json")}\n`);
  process.exit(report.passed ? 0 : 1);
}
