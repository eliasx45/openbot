// Fork (docs/fork/FEATURES.md, "Agents continue after a restart"): checks that an agent whose turn an
// OpenBot restart interrupted gets one wake in its own provider session, and every case where it must
// not. Runs the real agent service on a temporary profile with a fake Codex app-server, and simulates
// each restart with `stop()` and a new service on the same profile, as stuck-running-deliveries-e2e does.
//
// I1 starts the agents' turns (held). I2 starts and stops at once (a crash before any wake). I3 runs the
// wakes and the actions in the grace time (delete, Cancel, a new message). I4 and I5 interrupt a wake
// twice (one more try, then no more). I5-I8: /autoresume off and on, a turn after a long downtime, a signed-out provider.
// `bun scripts/restart-resume-e2e.ts`. Writes .openbot-build/restart-resume-e2e/report.json.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  AGENT_PROVIDERS,
  type ConversationMessage,
  isConversationMessage,
  isQueueSnapshot,
} from "@openbot/contracts/ipc";
import { Effect } from "effect";
import type { AgentBrowserHost } from "../src/backend/agent/turn-lifecycle";
import { getString, isRecord } from "../src/backend/protocol";

const OUT = resolve(import.meta.dirname, "../.openbot-build/restart-resume-e2e");
const root = await mkdtemp(join(tmpdir(), "openbot-restart-resume-"));
const userData = join(root, "user-data");
const home = join(root, "home");
const logPath = join(root, "protocol.jsonl");
const controlPath = join(root, "control.json");
const fakeCodex = join(root, "codex");
const STAGGER_MS = 1_500;

process.env.HOME = home;
process.env.CODEX_HOME = join(home, ".codex");
process.env.OPENBOT_CODEX_PATH = fakeCodex;
process.env.OPENBOT_FAKE_CODEX_LOG = logPath;
process.env.OPENBOT_FAKE_CODEX_CONTROL = controlPath;
process.env.OPENBOT_FORK_RESTART_RESUME_STAGGER_MS = String(STAGGER_MS);
process.env.OPENBOT_FORK_RESTART_RESUME_PROVIDER_WAIT_MS = "3000";
process.env.OPENBOT_FORK_RESTART_RESUME_SETTLE_WAIT_MS = "20000";
mkdirSync(home, { recursive: true });

const { AgentService } = await import("../src/backend/agent-service");
const { AgentStore } = await import("../src/backend/agent-store");
const { AgentThreadStore } = await import("../src/backend/agent-threads/agent-thread-store");
const { runCauseEffect } = await import("../src/backend/effect-boundary");
const { forkHub } = await import("../src/backend/fork-hub");
const { FORK_RESTART_RESUME_ROUTINE_ID } = await import("../src/backend/fork-restart-resume");
const { MailboxStore } = await import("../src/backend/mailbox-store");
const { OpenBotDatabase } = await import("../src/backend/openbot-database");

/**
 * A Codex app-server with the methods the service calls. `control.json`: `hold` holds every turn whose
 * input contains that text until `turn/interrupt` or the process exits; other turns end after `turnMs`.
 * `signedOut` answers `account/read` with no account. Every line in the log has its time.
 */
const FAKE_CODEX = `#!/usr/bin/env node
const fs = require("node:fs");
if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli 0.160.1\\n");
  process.exit(0);
}
const log = (entry) => fs.appendFileSync(process.env.OPENBOT_FAKE_CODEX_LOG, JSON.stringify({ at: Date.now(), pid: process.pid, ...entry }) + "\\n");
const control = () => JSON.parse(fs.readFileSync(process.env.OPENBOT_FAKE_CODEX_CONTROL, "utf8"));
const config = { config: { mcp_servers: {} }, layers: [{ name: { type: "user", file: "/fake/.codex/config.toml", profile: null }, version: "1", config: { mcp_servers: {} } }] };
const prefix = "p" + process.pid + "-";
let buffer = "";
let threads = 0;
let turns = 0;
const running = new Map();
process.stdout.on("error", (error) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});
const write = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const finish = (turnId, status) => {
  const turn = running.get(turnId);
  if (!turn) return;
  running.delete(turnId);
  clearTimeout(turn.timer);
  log({ turnEnded: turnId, threadId: turn.threadId, status });
  if (status === "completed") {
    const item = { type: "agentMessage", id: "message-" + turnId, text: "Done.", phase: "final_answer" };
    write({ method: "item/completed", params: { threadId: turn.threadId, turnId, item } });
  }
  write({ method: "turn/completed", params: { threadId: turn.threadId, turn: { id: turnId, status } } });
};
const answer = (message) => {
  const params = message.params || {};
  switch (message.method) {
    case "initialize": return write({ id: message.id, result: {} });
    case "account/read":
      return control().signedOut
        ? write({ id: message.id, result: { account: null, requiresOpenaiAuth: true } })
        : write({ id: message.id, result: { account: { type: "chatgpt", email: "codex@example.com" } } });
    case "account/rateLimits/read": return write({ id: message.id, result: { rateLimits: { limitId: "codex", primary: null, secondary: null }, rateLimitsByLimitId: null } });
    case "model/list": return write({ id: message.id, result: { data: [{ model: "gpt-5.5", displayName: "GPT-5.5" }] } });
    case "plugin/list": return write({ id: message.id, result: { marketplaces: [] } });
    case "config/read": return write({ id: message.id, result: config });
    case "config/batchWrite": return write({ id: message.id, result: {} });
    case "thread/start": {
      const id = prefix + "thread-" + (++threads);
      log({ threadStarted: id });
      return write({ id: message.id, result: { thread: { id, turns: [] } } });
    }
    case "thread/resume": return write({ id: message.id, result: { thread: { id: params.threadId, turns: [] } } });
    case "thread/unsubscribe": return write({ id: message.id, result: { status: "Unsubscribed" } });
    case "thread/turns/list":
    case "thread/items/list": return write({ id: message.id, result: { data: [], nextCursor: null } });
    case "thread/read": return write({ id: message.id, result: { thread: { id: params.threadId, turns: [] } } });
    case "turn/start": {
      const { hold, turnMs } = control();
      const turnId = prefix + "turn-" + (++turns);
      const text = JSON.stringify(params.input || []);
      write({ id: message.id, result: { turn: { id: turnId, status: "inProgress", items: [] } } });
      write({ method: "turn/started", params: { threadId: params.threadId, turn: { id: turnId } } });
      log({ turnStarted: turnId, threadId: params.threadId, text });
      const held = typeof hold === "string" && hold !== "" && text.includes(hold);
      const timer = held ? undefined : setTimeout(() => finish(turnId, "completed"), turnMs);
      running.set(turnId, { threadId: params.threadId, timer });
      return;
    }
    case "turn/interrupt": {
      if (!running.has(params.turnId)) return write({ id: message.id, error: { code: -32600, message: "no active turn to interrupt" } });
      write({ id: message.id, result: {} });
      return finish(params.turnId, "interrupted");
    }
    default:
      return write({ id: message.id, error: { code: -32601, message: "Method not found: " + message.method } });
  }
};
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf("\\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line) {
      const message = JSON.parse(line);
      if (message.method && message.id !== undefined) answer(message);
    }
    newline = buffer.indexOf("\\n");
  }
});
`;

type Database = InstanceType<typeof OpenBotDatabase>;
type Mailbox = InstanceType<typeof MailboxStore>;
type Store = InstanceType<typeof AgentStore>;
type Service = InstanceType<typeof AgentService>;
interface Instance {
  name: string;
  database: Database;
  store: Store;
  mailbox: Mailbox;
  agents: Service;
  errors: { code: string; agentId: string | null; message: string }[];
}
type ReportValue = string | number | boolean | null | ReportValue[] | { [key: string]: ReportValue };
type Details = { [key: string]: ReportValue };
interface CaseReport {
  name: string;
  edgeCase: string;
  passed: boolean;
  failure: string | null;
  details: Details;
}
const report: {
  cases: CaseReport[];
  errorEvents: { instance: string; code: string; agentId: string | null; message: string }[];
  passed: boolean;
  error?: string;
} = { cases: [], errorEvents: [], passed: false };

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

interface LogEntry {
  at: number;
  pid: number;
  turnStarted?: string;
  turnEnded?: string;
  threadStarted?: string;
  threadId?: string;
  text?: string;
  status?: string;
}
function protocolLog(): LogEntry[] {
  try {
    return readFileSync(logPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line): unknown => JSON.parse(line))
      .filter(isRecord)
      .map((entry) => ({
        at: Number(entry.at),
        pid: Number(entry.pid),
        ...(getString(entry, "turnStarted") ? { turnStarted: getString(entry, "turnStarted") ?? "" } : {}),
        ...(getString(entry, "turnEnded") ? { turnEnded: getString(entry, "turnEnded") ?? "" } : {}),
        ...(getString(entry, "threadStarted") ? { threadStarted: getString(entry, "threadStarted") ?? "" } : {}),
        ...(getString(entry, "threadId") ? { threadId: getString(entry, "threadId") ?? "" } : {}),
        ...(getString(entry, "text") ? { text: getString(entry, "text") ?? "" } : {}),
        ...(getString(entry, "status") ? { status: getString(entry, "status") ?? "" } : {}),
      }));
  } catch {
    return [];
  }
}
const WAKE_HEADER = "[OpenBot: 🔄 restart]";
/** The provider turns whose input contains `marker`. JSON-escaped like the log. */
function turnsWith(marker: string): LogEntry[] {
  const needle = JSON.stringify(marker).slice(1, -1);
  return protocolLog().filter((entry) => entry.turnStarted && entry.text?.includes(needle));
}
function wakeTurnsFor(request: string): LogEntry[] {
  const header = JSON.stringify(WAKE_HEADER).slice(1, -1);
  return turnsWith(request).filter((entry) => entry.text?.includes(header));
}

async function waitFor<T>(read: () => T | null | undefined | false, timeoutMs = 20_000): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await new Promise((done) => setTimeout(done, 50));
  }
}
async function need<T>(label: string, read: () => T | null | undefined | false, timeoutMs = 20_000): Promise<T> {
  const value = await waitFor(read, timeoutMs);
  if (!value) throw new Error(`Timed out waiting for ${label}.`);
  return value;
}
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function control(value: { hold: string; turnMs: number; signedOut?: boolean }): Promise<void> {
  await writeFile(controlPath, JSON.stringify(value));
}

async function start(name: string, env: Record<string, string>): Promise<Instance> {
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  const database = new OpenBotDatabase(userData);
  const store = new AgentStore(userData, home, database);
  const mailbox = new MailboxStore(userData, store.sharedRoot, store.database);
  const agents = new AgentService({
    store,
    mailbox,
    browser,
    preferredProvider: "codex",
    offProviders: AGENT_PROVIDERS.filter((provider) => provider !== "codex"),
    busyMessageMode: () => "queue",
    timezone: () => "Europe/Berlin",
  });
  const errors: Instance["errors"] = [];
  agents.on("event", (event) => {
    if (event.type === "error")
      errors.push({ code: event.code, agentId: event.agentId ?? null, message: event.message });
  });
  const instance = { name, database, store, mailbox, agents, errors };
  await runCauseEffect(agents.initialize());
  return instance;
}

async function shutdown(instance: Instance): Promise<void> {
  await runCauseEffect(instance.agents.stop()).catch(() => {});
  report.errorEvents.push(...instance.errors.map((error) => ({ instance: instance.name, ...error })));
  instance.database.close();
}

function stateFile(): {
  enabled: boolean;
  aliveAt: string | null;
  entries: Array<{
    key: string;
    agentId: string;
    state: string;
    reason: string | null;
    attempt: number;
    kind: string;
    subagents: Array<{ id: string; providerAgentId: string | null }>;
  }>;
} {
  return JSON.parse(readFileSync(join(userData, "fork-restart-resume.json"), "utf8"));
}
function entriesOf(agentId: string) {
  try {
    return stateFile().entries.filter((entry) => entry.agentId === agentId);
  } catch {
    return [];
  }
}

function messagesOf(instance: Instance, agentId: string): ConversationMessage[] {
  const threadId = instance.store.list().find((agent) => agent.id === agentId)?.threadId ?? null;
  return instance.database.readConversationPage(agentId, threadId, { type: "latest" }, 200).messages;
}
function wakeMessages(instance: Instance, agentId: string): ConversationMessage[] {
  return messagesOf(instance, agentId).filter(
    (message) => message.routine?.routineId === FORK_RESTART_RESUME_ROUTINE_ID,
  );
}

async function runCase(
  name: string,
  edgeCase: string,
  body: (details: Details) => Promise<string | null> | string | null,
) {
  const details: Details = {};
  let failure: string | null;
  try {
    failure = await body(details);
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }
  report.cases.push({ name, edgeCase, passed: failure === null, failure, details });
}

interface Made {
  id: string;
  request: string;
}
async function createAgent(instance: Instance, name: string, request: string): Promise<Made> {
  const agent = await runCauseEffect(
    instance.agents.createAgent({
      name,
      description: "Restart resume check.",
      avatarSeed: name.toLowerCase().replaceAll(" ", "-"),
      avatarHue: null,
      initialMessage: request,
    }),
  );
  return { id: agent.id, request };
}
function deliveryStatus(instance: Instance, agentId: string, text: string): string | null {
  const delivery = instance.agents.listQueue(agentId).deliveries.find((candidate) => candidate.text === text);
  return delivery ? (instance.mailbox.getDelivery(delivery.id)?.delivery.status ?? null) : null;
}
async function runningTurn(instance: Instance, made: Made): Promise<string> {
  return need(`the running turn of ${made.request}`, () => {
    const delivery = instance.agents.listQueue(made.id).deliveries.find((candidate) => candidate.text === made.request);
    const stored = delivery ? instance.mailbox.getDelivery(delivery.id)?.delivery : undefined;
    return stored?.status === "running" && stored.turnId;
  });
}
async function idle(instance: Instance, made: Made): Promise<void> {
  await need(`the end of ${made.request}`, () => deliveryStatus(instance, made.id, made.request) === "completed");
}
function unresolved(instance: Instance, agentId: string): number {
  return instance.agents
    .listQueue(agentId)
    .deliveries.filter((delivery) => ["queued", "starting", "running"].includes(delivery.status)).length;
}

await writeFile(fakeCodex, FAKE_CODEX, { mode: 0o755 });
let current: Instance | null = null;

try {
  // ---------- I1: the turns that the restart interrupts ----------
  await control({ hold: "HOLD1", turnMs: 150 });
  const i1 = await start("I1", { OPENBOT_FORK_RESTART_RESUME_GRACE_MS: "1000" });
  current = i1;
  const basic = await createAgent(i1, "Basic", "HOLD1 Basic: write the quarterly report.");
  const retry = await createAgent(i1, "Retry", "HOLD1 HOLD-AGAIN Retry: run the long build.");
  const stopWake = await createAgent(i1, "Stop wake", "HOLD1 HOLD-AGAIN StopWake: run the long job.");
  const asks = await createAgent(i1, "Asks", "HOLD1 Asks: pick a colour with me.");
  const stopped = await createAgent(i1, "Stopped", "HOLD1 Stopped: the user stops this.");
  const queued = await createAgent(i1, "Queued", "HOLD1 Queued: first message.");
  const goal = await createAgent(i1, "Goal", "HOLD1 Goal: build the landing page.");
  const deleted = await createAgent(i1, "Deleted", "HOLD1 Deleted: this agent goes away.");
  const sessionGone = await createAgent(i1, "Session gone", "HOLD1 SessionGone: its session is lost.");
  const cancel = await createAgent(i1, "Cancel", "HOLD1 Cancel: the user cancels the resume.");
  const takeover = await createAgent(i1, "Takeover", "HOLD1 Takeover: the user writes first.");
  const routine = await createAgent(i1, "Routine", "Routine: an idle chat.");
  const channelOwner = await createAgent(i1, "Channel owner", "ChannelOwner: an idle chat.");
  const subagents = await createAgent(i1, "Subagents", "Subagents: started a background helper.");
  const holding = [basic, retry, stopWake, asks, stopped, queued, goal, deleted, sessionGone, cancel, takeover];
  const turnOf = new Map<string, string>();
  for (const made of holding) turnOf.set(made.id, await runningTurn(i1, made));
  for (const made of [routine, channelOwner, subagents]) await idle(i1, made);
  // The user pressed Stop: the turn is terminal before the restart.
  await runCauseEffect(i1.agents.interrupt(stopped.id, turnOf.get(stopped.id) ?? ""));
  await need("the stopped turn to end", () => deliveryStatus(i1, stopped.id, stopped.request) === "interrupted");
  // A message waits behind the running turn.
  const queuedSecond = "Queued: second message, sent during the turn.";
  await runCauseEffect(i1.agents.sendMessage({ agentId: queued.id, text: queuedSecond }));
  // A routine run (not the user's own work) runs when OpenBot stops.
  await runCauseEffect(
    i1.agents.enqueueRoutineHandoff({
      run: {
        id: `run-${randomUUID()}`,
        routineId: "routine-weekly-post",
        routineName: "Weekly post",
        scheduledFor: new Date().toISOString(),
      },
      agentId: routine.id,
      text: "HOLD1 Routine run: post the weekly update.",
      idempotencyKey: `routine-run:${randomUUID()}`,
    }),
  );
  await need("the routine run to start", () => turnsWith("HOLD1 Routine run").length > 0);
  // A channel thread and a task thread of an idle agent, each with a running turn.
  const channels = i1.agents.channels.store;
  const channelId = `channel-${randomUUID()}`;
  channels.commit(randomUUID(), {
    channel: channels.create(channelId, {
      name: "restart",
      title: "Restart",
      instructions: "",
      members: [{ agentId: channelOwner.id }],
      leadAgentId: channelOwner.id,
    }),
    messages: [],
    tasks: [],
    assignments: [],
  });
  const channelThreadId = channels.context(channelId, channelOwner.id).threadId;
  const taskThreadId = new AgentThreadStore(i1.database).create({
    agentId: channelOwner.id,
    origin: "user",
    title: "Restart task",
    titleSource: "auto",
  }).threadId;
  const threadOf = (instance: Instance, agentId: string) =>
    instance.store.list().find((agent) => agent.id === agentId)?.threadId ?? "";
  const ownThread = new Map<string, string>();
  for (const made of [...holding, routine, channelOwner, subagents]) ownThread.set(made.id, threadOf(i1, made.id));
  const firstThread = new Map<string, string>();
  for (const made of holding) {
    const turn = turnsWith(made.request)[0];
    if (turn?.threadId) firstThread.set(made.id, turn.threadId);
  }
  await shutdown(i1);
  current = null;

  // ---------- Between I1 and I2: what the restart left, made by hand ----------
  {
    const database = new OpenBotDatabase(userData);
    await runCauseEffect(database.initialize());
    const now = new Date().toISOString();
    // Asks: an open question prompt in the interrupted turn.
    database.persistConversationChanges({
      agentId: asks.id,
      threadId: ownThread.get(asks.id) ?? "",
      activeTurnId: turnOf.get(asks.id) ?? null,
      changedMessages: [
        {
          id: `question-prompt:${turnOf.get(asks.id)}:request-1`,
          turnId: turnOf.get(asks.id) ?? "",
          author: "assistant",
          source: "assistant",
          text: "Which colour?",
          createdAt: now,
          status: "completed",
          itemType: "question_prompt",
          questionPrompt: {
            requestId: "request-1",
            questions: [{ id: "colour", header: "Colour", question: "Which colour?", isSecret: false, options: null }],
            resolution: null,
          },
        },
      ],
      eventType: "conversation.snapshot-updated",
    });
    // Subagents: its finished turn left a background subagent running.
    const subagentsThread = ownThread.get(subagents.id) ?? "";
    const finishedTurn = getString(
      database.connection
        .prepare("SELECT turn_id FROM projection_turns WHERE thread_id = ? ORDER BY started_at LIMIT 1")
        .get(subagentsThread),
      "turn_id",
    );
    database.persistConversationChanges({
      agentId: subagents.id,
      threadId: subagentsThread,
      activeTurnId: null,
      changedMessages: [
        {
          id: `${finishedTurn}:subagents`,
          turnId: finishedTurn ?? "",
          author: "assistant",
          text: "- Render the preview clip",
          createdAt: now,
          status: "completed",
          itemType: "subagents",
          subagents: [
            {
              id: "toolu_background_render",
              title: "Render the preview clip",
              agentType: "general-purpose",
              prompt: "Render it.",
              status: "running",
              startedAt: now,
              endedAt: null,
              steps: [],
              error: null,
              background: true,
              providerAgentId: "a0b1c2d3e4f5",
            },
          ],
        },
      ],
      eventType: "conversation.snapshot-updated",
    });
    // Channel and task threads of Channel owner: a turn runs in each.
    for (const threadId of [channelThreadId, taskThreadId])
      database.persistConversationChanges({
        agentId: channelOwner.id,
        threadId,
        activeTurnId: `turn-in-${threadId}`,
        changedMessages: [],
        eventType: "conversation.snapshot-updated",
      });
    // Session gone: the provider session of its chat is no longer active.
    database.connection
      .prepare(
        "UPDATE projection_provider_sessions SET state = 'inactive' WHERE thread_id IN (SELECT thread_id FROM projection_threads WHERE agent_id = ?)",
      )
      .run(sessionGone.id);
    // Goal: a goal chain runs.
    writeFileSync(
      join(dirname(database.path), "fork-goals.json"),
      JSON.stringify({
        goals: [
          {
            agentId: goal.id,
            text: "Build the landing page",
            state: "working",
            turn: 2,
            maxTurns: 10,
            startedBy: "goal-message",
            startedAt: now,
            misses: 0,
            next: "Write the hero section",
            detail: null,
          },
        ],
      }),
    );
    database.close();
  }

  // ---------- I2: starts and stops before any wake (a crash loop) ----------
  const i2 = await start("I2", { OPENBOT_FORK_RESTART_RESUME_GRACE_MS: "60000" });
  current = i2;
  const capturedInI2 = new Map<string, string>();
  for (const made of [...holding, routine, channelOwner, subagents])
    capturedInI2.set(
      made.id,
      entriesOf(made.id)
        .map((entry) => `${entry.state}:${entry.reason ?? ""}`)
        .join(",") || "none",
    );
  // The message that waited behind the interrupted turn runs at once after the restart.
  await need("the queued message to run", () => deliveryStatus(i2, queued.id, queuedSecond) === "completed");
  const waitsInI2 = Object.fromEntries(
    holding.map((made) => [made.request.slice(6, 20), i2.agents.listWaits(made.id).waits.length]),
  );
  await shutdown(i2);
  current = null;
  const wakesAfterI2 = holding.reduce((sum, made) => sum + wakeTurnsFor(made.request).length, 0);

  // ---------- I3: the wakes ----------
  await control({ hold: "HOLD-AGAIN", turnMs: 150 });
  const i3 = await start("I3", { OPENBOT_FORK_RESTART_RESUME_GRACE_MS: "4000" });
  current = i3;
  const i3Started = Date.now();
  const cancelWait = i3.agents.listWaits(cancel.id).waits[0];
  if (cancelWait) i3.agents.cancelWait(cancel.id, cancelWait.id);
  await runCauseEffect(i3.agents.deleteAgent(deleted.id));
  const takeoverText = "Takeover: the user writes right after the restart.";
  await runCauseEffect(i3.agents.sendMessage({ agentId: takeover.id, text: takeoverText }));
  const queueChecks: boolean[] = [];
  const expectedWakes = [basic, retry, stopWake, goal];
  await need(
    "the wakes",
    () => {
      for (const made of [...holding, routine, subagents]) {
        if (made === deleted) continue;
        queueChecks.push(isQueueSnapshot(i3.agents.listQueue(made.id)));
      }
      return (
        expectedWakes.every((made) => wakeTurnsFor(made.request).length > 0) &&
        wakeTurnsFor("Subagents: started").length > 0
      );
    },
    60_000,
  );
  // Long enough for a second wake of anything, or one for a skipped agent.
  await sleep(STAGGER_MS * 3);
  const entry = (made: Made) => entriesOf(made.id).at(-1);

  await runCase("A: one wake in the same provider session", "core + 13", (details) => {
    const wakes = wakeTurnsFor(basic.request);
    const messages = wakeMessages(i3, basic.id);
    details.wakeTurns = wakes.length;
    details.sameThread = wakes[0]?.threadId === firstThread.get(basic.id);
    details.firstThread = firstThread.get(basic.id) ?? null;
    details.wakeThread = wakes[0]?.threadId ?? null;
    details.routineName = messages[0]?.routine?.name ?? null;
    details.author = messages[0]?.author ?? null;
    details.decodes = messages.every((message) => isConversationMessage(message));
    details.text = wakes[0]?.text?.slice(0, 900) ?? null;
    const text = wakes[0]?.text ?? "";
    if (wakes.length !== 1) return `Expected one wake turn, saw ${wakes.length}.`;
    if (!details.sameThread) return "The wake ran in another provider thread.";
    if (
      protocolLog().some(
        (line) =>
          line.threadStarted &&
          line.pid === wakes[0]?.pid &&
          line.at < (wakes[0]?.at ?? 0) &&
          line.at > i3Started &&
          line.threadStarted === wakes[0]?.threadId,
      )
    )
      return "The wake started a new provider thread.";
    if (messages.length !== 1) return `Expected one wake message in the chat, saw ${messages.length}.`;
    if (messages[0]?.routine?.name !== "🔄 Resumed after restart")
      return "The chat line is not '🔄 Resumed after restart'.";
    if ((messages[0]?.routine?.name.length ?? 99) > 80) return "The routine name is longer than 80 characters.";
    if (!details.decodes) return "A wake message does not decode.";
    for (const part of [
      "not a message from the user",
      "Never repeat sends",
      "The request it continues:",
      "Basic: write the quarterly report",
      "(Europe/Berlin)",
    ])
      if (!text.includes(part)) return `The wake text lacks "${part}".`;
    if (text.includes("SendMessage")) return "A Codex wake names SendMessage.";
    return null;
  });

  await runCase("B: a crash before the wake does not wake twice", "1", (details) => {
    details.capturedInI2 = Object.fromEntries(
      [...capturedInI2].map(([id, state]) => [
        [...holding, routine, channelOwner, subagents].find((made) => made.id === id)?.request.slice(0, 28) ?? id,
        state,
      ]),
    );
    details.waitsInI2 = waitsInI2;
    details.wakesAfterI2 = wakesAfterI2;
    details.basicEntries = entriesOf(basic.id).length;
    if (wakesAfterI2 !== 0) return "A wake ran in the instance that stopped at once.";
    if (capturedInI2.get(basic.id) !== "pending:") return "The interrupted turn was not noted as pending.";
    if (entriesOf(basic.id).length !== 1) return "The interrupted turn has more than one note.";
    if (wakeTurnsFor(basic.request).length !== 1) return "The turn was resumed more than once.";
    return null;
  });

  await runCase("C: channel and task threads are not resumed", "3", (details) => {
    details.entries = entriesOf(channelOwner.id).length;
    details.wakes = wakeMessages(i3, channelOwner.id).length;
    if (entriesOf(channelOwner.id).length !== 0) return "A channel or task thread was noted.";
    if (wakeMessages(i3, channelOwner.id).length !== 0) return "A channel or task thread got a wake.";
    return null;
  });

  await runCase("D: a turn that waited for the user's answer", "4", (details) => {
    details.entry = entry(asks)?.reason ?? null;
    details.wakes = wakeTurnsFor(asks.request).length;
    if (entry(asks)?.state !== "skipped" || entry(asks)?.reason !== "waited for the user's answer")
      return "Not skipped as waiting for the user.";
    if (wakeTurnsFor(asks.request).length !== 0) return "It got a wake.";
    return null;
  });

  await runCase("E: a turn the user stopped", "5", (details) => {
    details.entries = entriesOf(stopped.id).length;
    details.wakes = wakeTurnsFor(stopped.request).length;
    if (entriesOf(stopped.id).length !== 0) return "A stopped turn was noted.";
    if (wakeTurnsFor(stopped.request).length !== 0) return "A stopped turn got a wake.";
    return null;
  });

  await runCase("F: a queued message runs instead, never two turns", "6", (details) => {
    const second = turnsWith(queuedSecond);
    details.entry = entry(queued)?.reason ?? null;
    details.secondRan = second.length;
    details.secondStatus = deliveryStatus(i3, queued.id, queuedSecond);
    details.wakes = wakeTurnsFor(queued.request).length;
    if (entry(queued)?.reason !== "a queued message runs instead") return "Not skipped for the queued message.";
    if (second.length !== 1) return "The queued message did not run once.";
    if (wakeTurnsFor(queued.request).length !== 0) return "It got a wake as well.";
    return null;
  });

  await runCase("G: an interrupted routine run is not run again", "7", (details) => {
    details.entry = entry(routine)?.reason ?? null;
    details.wakes = wakeMessages(i3, routine.id).length;
    details.routineRunTurns = turnsWith("HOLD1 Routine run").length;
    if (entry(routine)?.reason !== "routine run") return "Not skipped as a routine run.";
    if (wakeMessages(i3, routine.id).length !== 0) return "It got a wake.";
    if (turnsWith("HOLD1 Routine run").length !== 1) return "The routine run ran again.";
    return null;
  });

  await runCase("H: a running goal continues with the wake", "8", async (details) => {
    const wakes = wakeTurnsFor(goal.request);
    details.wakes = wakes.length;
    details.footer = wakes[0]?.text?.includes("[Goal mode is on") ?? false;
    // The fake provider never reports goal_status: one reminder turn follows, then the goal blocks.
    const goals = await need("the goal to end", () => {
      const saved = JSON.parse(readFileSync(join(userData, "fork-goals.json"), "utf8"));
      const found = Array.isArray(saved.goals)
        ? saved.goals.find((item: { agentId: string }) => item.agentId === goal.id)
        : null;
      return found && found.state !== "working" ? found : null;
    });
    details.goalState = goals.state;
    details.goalTurn = goals.turn;
    details.goalTurnsInProvider = turnsWith("Build the landing page").length;
    if (wakes.length !== 1) return `Expected one wake, saw ${wakes.length}.`;
    if (!details.footer) return "The wake has no goal footer.";
    if (goals.state !== "blocked") return `The goal chain did not go on from the wake (state ${goals.state}).`;
    return null;
  });

  await runCase("I: wakes start a few seconds apart, one turn per chat at a time", "9 + 6", (details) => {
    const starts = protocolLog()
      .filter(
        (line) =>
          line.turnStarted &&
          line.at >= i3Started &&
          line.text?.includes(JSON.stringify(WAKE_HEADER).slice(1, -1)) &&
          !line.text?.includes("Your next step") &&
          !line.text?.includes("ended without openbot.goal_status"),
      )
      .map((line) => line.at)
      .sort((a, b) => a - b);
    const gaps = starts.slice(1).map((at, index) => at - (starts[index] ?? at));
    details.wakeStarts = starts.length;
    details.gapsMs = gaps;
    // Overlap: a turn start on a thread while an earlier turn of that thread (same process) runs.
    const runningByThread = new Map<string, string>();
    let overlap: string | null = null;
    for (const line of protocolLog()) {
      const key = `${line.pid}:${line.threadId}`;
      if (line.turnStarted) {
        if (runningByThread.has(key)) overlap = `${line.threadId}`;
        runningByThread.set(key, line.turnStarted);
      } else if (line.turnEnded) runningByThread.delete(key);
    }
    details.overlap = overlap;
    if (starts.length < 5) return `Expected at least 5 wakes, saw ${starts.length}.`;
    if (gaps.some((gap) => gap < STAGGER_MS - 250)) return "Two wakes started closer than the stagger.";
    if (overlap) return `Two turns ran at once in one chat (${overlap}).`;
    return null;
  });

  await runCase("J: a deleted agent and a lost provider session", "10", (details) => {
    details.deleted = entry(deleted)?.reason ?? null;
    details.sessionGone = entry(sessionGone)?.reason ?? null;
    const lines = messagesOf(i3, sessionGone.id).filter((message) => message.text.startsWith("🔄 Not resumed"));
    details.sessionGoneLines = lines.length;
    details.sessionGoneWakes = wakeTurnsFor(sessionGone.request).length;
    details.deletedWakes = wakeTurnsFor(deleted.request).length;
    if (entry(deleted)?.reason !== "agent gone") return "The deleted agent was not skipped.";
    if (wakeTurnsFor(deleted.request).length !== 0) return "The deleted agent got a wake.";
    if (entry(sessionGone)?.reason !== "provider session gone") return "The lost session was not skipped.";
    if (lines.length !== 1) return `Expected one quiet note, saw ${lines.length}.`;
    if (wakeTurnsFor(sessionGone.request).length !== 0) return "The agent with a lost session got a wake.";
    return null;
  });

  await runCase("K: the user cancels it like a wait, or writes first", "12", (details) => {
    details.cancelWaitSeen = cancelWait !== undefined;
    details.cancelNote = cancelWait?.note ?? null;
    details.cancel = `${entry(cancel)?.state}:${entry(cancel)?.reason}`;
    details.takeover = entry(takeover)?.reason ?? null;
    details.takeoverRan = turnsWith(takeoverText).length;
    if (!cancelWait?.note.startsWith("🔄")) return "No resume wait to cancel.";
    if (entry(cancel)?.state !== "cancelled") return "Cancel did not stop the resume.";
    if (wakeTurnsFor(cancel.request).length !== 0) return "The cancelled agent got a wake.";
    if (entry(takeover)?.reason !== "another turn started since the restart")
      return "The new message did not replace the resume.";
    if (wakeTurnsFor(takeover.request).length !== 0) return "The agent that got a new message got a wake.";
    if (turnsWith(takeoverText).length !== 1) return "The user's new message did not run.";
    return null;
  });

  await runCase("L: background subagents that the restart stopped", "subagents", (details) => {
    const wakes = wakeTurnsFor("Subagents: started");
    const noted = entry(subagents);
    details.kind = noted?.kind ?? null;
    details.subagents = (noted?.subagents ?? []).map((item) => `${item.id}=${item.providerAgentId}`);
    details.wakes = wakes.length;
    details.text = wakes[0]?.text?.slice(0, 400) ?? null;
    if (noted?.kind !== "subagents") return "The stopped background subagent was not noted.";
    if (noted.subagents[0]?.providerAgentId !== "a0b1c2d3e4f5") return "The subagent's agent ID was not kept.";
    if (wakes.length !== 1) return `Expected one wake, saw ${wakes.length}.`;
    if (!wakes[0]?.text?.includes("background subagents were stopped"))
      return "The wake does not say that subagents stopped.";
    return null;
  });

  await runCase("M: the phone queue decodes with a wake in it", "13", (details) => {
    details.snapshots = queueChecks.length;
    details.allDecode = queueChecks.every(Boolean);
    const retryQueue = i3.agents.listQueue(retry.id);
    details.retryQueue = retryQueue.deliveries.map(
      (delivery) =>
        `${delivery.status}:${delivery.sender.kind === "routine" ? delivery.sender.routineName : delivery.sender.kind}`,
    );
    if (!queueChecks.every(Boolean) || !isQueueSnapshot(retryQueue)) return "A queue with a wake does not decode.";
    if (
      !retryQueue.deliveries.some(
        (delivery) =>
          delivery.sender.kind === "routine" && delivery.sender.routineId === FORK_RESTART_RESUME_ROUTINE_ID,
      )
    )
      return "The running wake is not in the queue.";
    return null;
  });

  // Stop during the wake: the wake ends, and nothing wakes it again.
  const stopWakeTurn = await need("the held wake of StopWake", () => {
    const wake = i3.agents
      .listQueue(stopWake.id)
      .deliveries.find(
        (delivery) =>
          delivery.sender.kind === "routine" && delivery.sender.routineId === FORK_RESTART_RESUME_ROUTINE_ID,
      );
    const stored = wake ? i3.mailbox.getDelivery(wake.id)?.delivery : undefined;
    return stored?.status === "running" && stored.turnId;
  });
  await runCauseEffect(i3.agents.interrupt(stopWake.id, stopWakeTurn));
  await sleep(STAGGER_MS * 2);
  await runCase("N: Stop ends the wake", "12", (details) => {
    details.wakes = wakeTurnsFor(stopWake.request).length;
    details.queue = unresolved(i3, stopWake.id);
    if (wakeTurnsFor(stopWake.request).length !== 1) return "The stopped wake started again.";
    if (unresolved(i3, stopWake.id) !== 0) return "The stopped wake still holds the queue.";
    return null;
  });
  await shutdown(i3);
  current = null;

  // ---------- I4: the wake of Retry was interrupted: one more try ----------
  const i4 = await start("I4", { OPENBOT_FORK_RESTART_RESUME_GRACE_MS: "800" });
  current = i4;
  await need("the second try of Retry", () => wakeTurnsFor(retry.request).length === 2, 30_000);
  await sleep(STAGGER_MS * 2);
  await runCase("O: an interrupted wake gets one more try", "1", (details) => {
    const wakes = wakeTurnsFor(retry.request);
    const names = wakeMessages(i4, retry.id).map((message) => message.routine?.name ?? "");
    details.wakes = wakes.length;
    details.names = names;
    details.attempt = entry(retry)?.attempt ?? null;
    details.stopWakeWakes = wakeTurnsFor(stopWake.request).length;
    const text = wakes[1]?.text ?? "";
    if (wakes.length !== 2) return `Expected two wakes, saw ${wakes.length}.`;
    if (!text.includes("last automatic try")) return "The second try does not say it is the last.";
    if (!text.includes("Retry: run the long build")) return "The second try lost the original request.";
    if (!names.includes("🔄 Resumed after restart (second try)")) return "No second-try line in the chat.";
    if (wakeTurnsFor(stopWake.request).length !== 1) return "A stopped wake was resumed after the restart.";
    return null;
  });
  await shutdown(i4);
  current = null;

  // ---------- I5: interrupted again: no more tries; then /autoresume off ----------
  await control({ hold: "HOLD5", turnMs: 150 });
  const i5 = await start("I5", { OPENBOT_FORK_RESTART_RESUME_GRACE_MS: "800" });
  current = i5;
  await sleep(800 + STAGGER_MS * 3);
  await runCase("P: no third try", "1", (details) => {
    details.wakes = wakeTurnsFor(retry.request).length;
    details.entry = `${entry(retry)?.state}:${entry(retry)?.reason}:${entry(retry)?.attempt}`;
    if (wakeTurnsFor(retry.request).length !== 2) return "A third wake ran.";
    if (entry(retry)?.state !== "skipped" || !entry(retry)?.reason?.startsWith("retry limit"))
      return "The third try was not refused.";
    return null;
  });
  await runCauseEffect(i5.agents.sendMessage({ agentId: basic.id, text: "/autoresume off" }));
  await need("/autoresume off", () => forkHub.restartResume?.enabled() === false);
  const off = await createAgent(i5, "Off", "HOLD5 Off: work while the switch is off.");
  await runningTurn(i5, off);
  await shutdown(i5);
  current = null;

  // ---------- I6: off; then on again, and a stale turn ----------
  await control({ hold: "HOLD6", turnMs: 150 });
  const i6 = await start("I6", { OPENBOT_FORK_RESTART_RESUME_GRACE_MS: "800" });
  current = i6;
  await sleep(800 + STAGGER_MS * 2);
  const offEnabled = stateFile().enabled;
  await runCase("Q: the switch turns it off and on", "11", async (details) => {
    details.enabledInFile = offEnabled;
    details.entries = entriesOf(off.id).length;
    details.wakes = wakeTurnsFor(off.request).length;
    await runCauseEffect(i6.agents.sendMessage({ agentId: basic.id, text: "/autoresume on" }));
    await need("/autoresume on", () => forkHub.restartResume?.enabled() === true);
    details.enabledAfterOn = stateFile().enabled;
    if (offEnabled !== false) return "/autoresume off was not saved.";
    if (entriesOf(off.id).length !== 0 || wakeTurnsFor(off.request).length !== 0)
      return "A turn was resumed while off.";
    if (stateFile().enabled !== true) return "/autoresume on was not saved.";
    return null;
  });
  const stale = await createAgent(i6, "Stale", "HOLD6 Stale: the app stays down for hours.");
  await runningTurn(i6, stale);
  await shutdown(i6);
  current = null;
  {
    const saved = stateFile();
    saved.aliveAt = new Date(Date.now() - 3 * 60 * 60_000).toISOString();
    writeFileSync(join(userData, "fork-restart-resume.json"), JSON.stringify(saved));
  }

  // ---------- I7: stale; then a signed-out provider ----------
  await control({ hold: "HOLD7", turnMs: 150 });
  const i7 = await start("I7", { OPENBOT_FORK_RESTART_RESUME_GRACE_MS: "800" });
  current = i7;
  await sleep(800 + STAGGER_MS * 2);
  await runCase("R: a turn interrupted more than 2 h ago still resumes, with the time check", "2", async (details) => {
    const wakes =
      (await waitFor(() => {
        const found = wakeTurnsFor(stale.request);
        return found.length > 0 ? found : null;
      })) ?? [];
    details.entry = `${entry(stale)?.state}:${entry(stale)?.reason}`;
    details.wakes = wakes.length;
    const down = JSON.stringify("OpenBot was down for about 3 hours").slice(1, -1);
    const check = JSON.stringify("check that it still makes sense now").slice(1, -1);
    details.saysDowntime = wakes.some((wake) => wake.text?.includes(down));
    if (wakes.length !== 1) return `The long-down turn got ${wakes.length} wakes, not 1.`;
    if (!details.saysDowntime) return "The wake does not say how long OpenBot was down.";
    if (!wakes[0]?.text?.includes(check)) return "The wake does not ask to check time-sensitive steps.";
    return null;
  });
  const notReady = await createAgent(i7, "Not ready", "HOLD7 NotReady: the provider signs out.");
  await runningTurn(i7, notReady);
  await shutdown(i7);
  current = null;

  // ---------- I8: the provider is signed out ----------
  await control({ hold: "HOLD8", turnMs: 150, signedOut: true });
  const i8 = await start("I8", { OPENBOT_FORK_RESTART_RESUME_GRACE_MS: "500" });
  current = i8;
  await waitFor(() => entry(notReady)?.state === "skipped", 20_000);
  await sleep(4_000);
  await runCase("S: a provider that is not ready gets one quiet note, no loop", "9", (details) => {
    const lines = messagesOf(i8, notReady.id).filter((message) => message.text.startsWith("🔄 Not resumed"));
    details.entry = `${entry(notReady)?.state}:${entry(notReady)?.reason}`;
    details.lines = lines.length;
    details.line = lines[0]?.text ?? null;
    details.wakes = wakeTurnsFor(notReady.request).length;
    details.resumeErrors = i8.errors.filter((error) => error.code.includes("restart_resume")).length;
    if (entry(notReady)?.reason !== "provider not ready") return "Not skipped for the provider.";
    if (lines.length !== 1) return `Expected one note, saw ${lines.length}.`;
    if (wakeTurnsFor(notReady.request).length !== 0) return "It got a wake.";
    if (details.resumeErrors !== 0) return "The skip was reported as an error.";
    return null;
  });
  await shutdown(i8);
  current = null;

  report.passed =
    report.cases.length === 19 &&
    report.cases.every((item) => item.passed) &&
    !report.errorEvents.some((error) => error.code.includes("restart_resume"));
  if (!report.passed) process.exitCode = 1;
} catch (error) {
  report.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.exitCode = 1;
} finally {
  if (current) await shutdown(current);
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await rm(root, { recursive: true, force: true });
  process.stdout.write(
    `${JSON.stringify(
      report.cases.map((item) => [item.name, item.passed, item.failure]),
      null,
      1,
    )}\n${report.error ?? ""}\npassed: ${report.passed}\n`,
  );
}
