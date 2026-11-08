// Fork (docs/fork/FEATURES.md, "The plan shows the step that runs now"): checks that the step a
// plan shows is the step the agent works on now, through whole turns. Elias, 8 Nov 2026: the task
// list cards "stay running on step 1 visually even though it's on a later step". Agents keep more
// than one task in progress (52 of 183 task-list updates in his transcripts), and every view showed
// the first one.
//
// Runs the real agent service and the real `ClaudeAgentClient` on a temporary profile, with a
// stand-in `claude` executable that plays a scripted turn of `TaskCreate` / `TaskUpdate` /
// `TodoWrite` calls, one step at a time, in the order Elias's agents did (a later task starts
// while an earlier one is still in progress; a new turn carries the open tasks on). After each step
// the script reads the live conversation, projects it as the renderer does (`toAgentMessages`), and
// reads what each view shows with the views' own functions:
//   - the plan card's header (`planItems` + `activeTask`, as `ConversationTimeline` passes them),
//   - the live-work bar's plan row (`createSubagentDock`; with no running step it names the next one),
// and what the old rule (the first running step) showed. Each must equal the step the agent works on.
// No provider, account or network is used. `bun scripts/fork-plan-current-step-e2e.ts`.
// Writes .openbot-build/fork-plan-current-step-e2e/report.json.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  AGENT_PROVIDERS,
  type ConversationMessage,
  type ConversationPlan,
  currentPlanStep,
  defaultProviderModel,
} from "@openbot/contracts/ipc";
import { Effect } from "effect";
import { createRoot } from "solid-js";
import { activeTask } from "../packages/ui/src/features/conversation/task-list-active";
import type { AgentBrowserHost } from "../src/backend/agent/turn-lifecycle";
import type { AgentClient, DiagnosticOrigin } from "../src/backend/agent-client";
import type { ClaudeCliInfo } from "../src/backend/cli";
import type { AppServerNotification, AppServerRequest, RequestId, ResponseDecoder } from "../src/backend/protocol";
import { providerSync } from "../src/backend/provider-client-effects";
import type { ReadProviderHistory } from "../src/backend/provider-history";

const OUT = resolve(import.meta.dirname, "../.openbot-build/fork-plan-current-step-e2e");
const root = await mkdtemp(join(tmpdir(), "openbot-plan-current-step-"));
const userData = join(root, "user-data");
const home = join(root, "home");
const claudeConfig = join(home, ".claude");
const markers = join(root, "markers");
const claudeExecutable = join(root, "claude");
const CLAUDE_MODEL = defaultProviderModel("claude");

process.env.HOME = home;
process.env.OPENBOT_CLAUDE_PATH = claudeExecutable;
process.env.CLAUDE_CONFIG_DIR = claudeConfig;
mkdirSync(join(claudeConfig, "projects"), { recursive: true });
mkdirSync(markers, { recursive: true });

const { AgentService } = await import("../src/backend/agent-service");
const { AgentStore } = await import("../src/backend/agent-store");
const { ClaudeAgentClient } = await import("../src/backend/claude-client");
const { runCauseEffect } = await import("../src/backend/effect-boundary");
const { MailboxStore } = await import("../src/backend/mailbox-store");
const { OpenBotDatabase } = await import("../src/backend/openbot-database");

/** The renderer modules load at run time, so the Node typecheck does not read the renderer's JSX. */
function rendererUrl(path: string): string {
  return pathToFileURL(resolve(import.meta.dirname, "../src/renderer/src", path)).href;
}
type ViewPlan = ConversationPlan & { stopped: boolean };
interface ViewRow {
  kind: string;
  streaming?: boolean;
  plan?: ViewPlan;
}
const {
  toAgentMessages,
  planItems,
}: {
  toAgentMessages: (messages: readonly ConversationMessage[]) => ViewRow[];
  planItems: (plan: ViewPlan, streaming: boolean) => { id: string; label: string; state: string }[];
} = await import(rendererUrl("app-message-projection.ts"));
const {
  createSubagentDock,
}: {
  createSubagentDock: (deps: {
    rows: () => readonly ViewRow[];
    drawnRows: () => readonly unknown[];
    scrollElement: () => undefined;
    hidden: () => boolean;
  }) => { items: () => readonly { kind: string; plan?: { current: string | null } }[] };
} = await import(rendererUrl("features/conversation/subagent-dock.ts"));

/** A task: its subject and the present-tense form the views show while it runs. */
const TASKS = {
  map: { subject: "Map the 9 pieces to shelf parts", activeForm: "Mapping pieces" },
  style: { subject: "Write the style file", activeForm: "Writing the style" },
  build: { subject: "Build pieces 1-9", activeForm: "Building pieces" },
  ship: { subject: "Side-by-sides, check, commit", activeForm: "Shipping the pack" },
} as const;
type TaskKey = keyof typeof TASKS;
const TASK_KEYS: TaskKey[] = ["map", "style", "build", "ship"];
/** The ids the stand-in gives, in the order of `TaskCreate`. */
const TASK_ID: Record<TaskKey, string> = { map: "1", style: "2", build: "3", ship: "4" };

type Call =
  | { name: "TaskCreate"; task: TaskKey }
  | { name: "TaskUpdate"; task: TaskKey; status?: "in_progress" | "completed"; description?: string }
  | {
      name: "TodoWrite";
      todos: { content: string; activeForm: string; status: "pending" | "in_progress" | "completed" }[];
    };

interface Step {
  label: string;
  calls: Call[];
  /** The task statuses the plan must show after the step: the step reached the conversation. */
  expect: Record<string, "pending" | "inProgress" | "completed">;
  /** The present-tense text of the step the agent works on now, or null when no step runs. */
  real: string | null;
}

const update = (task: TaskKey, status?: "in_progress" | "completed", description?: string): Call => ({
  name: "TaskUpdate",
  task,
  ...(status ? { status } : {}),
  ...(description ? { description } : {}),
});

/** Each turn as Elias's agents played it (Tatiana pack, 8 Nov 2026 02:02–03:45). */
const TURNS: { prompt: string; steps: Step[] }[] = [
  {
    prompt: "plan-turn-1",
    steps: [
      {
        label: "creates 4 tasks",
        calls: TASK_KEYS.map((task) => ({ name: "TaskCreate", task })),
        expect: { map: "pending", style: "pending", build: "pending", ship: "pending" },
        real: null,
      },
      {
        label: "starts task 1",
        calls: [update("map", "in_progress")],
        expect: { map: "inProgress", style: "pending", build: "pending", ship: "pending" },
        real: TASKS.map.activeForm,
      },
      {
        label: "finishes 1, starts 2",
        calls: [update("map", "completed"), update("style", "in_progress")],
        expect: { map: "completed", style: "inProgress", build: "pending", ship: "pending" },
        real: TASKS.style.activeForm,
      },
      {
        label: "starts 3 while 2 stays in progress",
        calls: [update("build", "in_progress")],
        expect: { map: "completed", style: "inProgress", build: "inProgress", ship: "pending" },
        real: TASKS.build.activeForm,
      },
      {
        label: "notes progress on 2 (no status)",
        calls: [update("style", undefined, "style file committed")],
        expect: { map: "completed", style: "inProgress", build: "inProgress", ship: "pending" },
        real: TASKS.build.activeForm,
      },
      {
        label: "finishes 3, starts 4",
        calls: [update("build", "completed"), update("ship", "in_progress")],
        expect: { map: "completed", style: "inProgress", build: "completed", ship: "inProgress" },
        real: TASKS.ship.activeForm,
      },
    ],
  },
  {
    // A new turn shows the open tasks of the last one; the step that ran keeps running.
    prompt: "plan-turn-2",
    steps: [
      {
        label: "next turn: notes progress on 4",
        calls: [update("ship", undefined, "grid video rendered")],
        expect: { style: "inProgress", ship: "inProgress" },
        real: TASKS.ship.activeForm,
      },
      {
        label: "finishes the old task 2",
        calls: [update("style", "completed")],
        expect: { style: "completed", ship: "inProgress" },
        real: TASKS.ship.activeForm,
      },
      {
        label: "finishes 4",
        calls: [update("ship", "completed")],
        expect: { style: "completed", ship: "completed" },
        real: null,
      },
    ],
  },
  {
    // `TodoWrite` sends the whole list each time, as a subagent's list does.
    prompt: "plan-turn-3",
    steps: [
      {
        label: "TodoWrite: render runs",
        calls: [
          {
            name: "TodoWrite",
            todos: [
              { content: "Render before/after", activeForm: "Rendering before/after", status: "in_progress" },
              { content: "Upload to Frame.io", activeForm: "Uploading", status: "pending" },
            ],
          },
        ],
        expect: { "Render before/after": "inProgress", "Upload to Frame.io": "pending" },
        real: "Rendering before/after",
      },
      {
        label: "TodoWrite: upload starts, render still runs",
        calls: [
          {
            name: "TodoWrite",
            todos: [
              { content: "Render before/after", activeForm: "Rendering before/after", status: "in_progress" },
              { content: "Upload to Frame.io", activeForm: "Uploading", status: "in_progress" },
            ],
          },
        ],
        expect: { "Render before/after": "inProgress", "Upload to Frame.io": "inProgress" },
        real: "Uploading",
      },
    ],
  },
];

/** The stand-in's tool calls, as the CLI writes them. */
function cliCalls(calls: Call[]) {
  return calls.map((call) => {
    if (call.name === "TodoWrite") return { name: "TodoWrite", input: { todos: call.todos }, result: null };
    const task = TASKS[call.task];
    if (call.name === "TaskCreate")
      return {
        name: "TaskCreate",
        input: { subject: task.subject, description: task.subject, activeForm: task.activeForm },
        result: { id: TASK_ID[call.task], text: `Task #${TASK_ID[call.task]} created successfully: ${task.subject}` },
      };
    return {
      name: "TaskUpdate",
      input: {
        taskId: TASK_ID[call.task],
        ...(call.status ? { status: call.status } : {}),
        ...(call.description ? { description: call.description } : {}),
      },
      result: null,
    };
  });
}

const SCRIPT = Object.fromEntries(TURNS.map((turn) => [turn.prompt, turn.steps.map((step) => cliCalls(step.calls))]));

/**
 * The stand-in for the Claude CLI. A prompt names a turn of `SCRIPT`. Each step writes its tool calls
 * and their results, then writes `step-<turn>-<n>` and waits for `go-<turn>-<n>`, so the script can
 * read the conversation between steps. The turn ends with "Done.".
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
const sessionId = option("--resume") ?? option("--session-id") ?? randomUUID();
const SCRIPT = ${JSON.stringify(SCRIPT)};
const MARKERS = ${JSON.stringify(markers)};
const write = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
let requests = 0;
const usage = { input_tokens: 10, output_tokens: 20 };
const assistant = (content) => write({ type: "assistant", message: { id: "msg_" + process.pid + "_" + (++requests), type: "message",
  role: "assistant", model: ${JSON.stringify(CLAUDE_MODEL)}, content, stop_reason: null, usage }, parent_tool_use_id: null,
  session_id: sessionId, uuid: randomUUID() });
const toolResult = (id, text, result) => write({ type: "user", message: { role: "user", content: [{ type: "tool_result",
  tool_use_id: id, content: text }] }, parent_tool_use_id: null, session_id: sessionId, uuid: randomUUID(),
  ...(result ? { tool_use_result: result } : {}) });
const waitFor = (file) => new Promise((done) => {
  const timer = setInterval(() => { if (fs.existsSync(file)) { clearInterval(timer); done(); } }, 20);
});
let calls = 0;
const turn = async (message) => {
  const content = message.message?.content;
  const text = typeof content === "string" ? content : (content ?? []).map((block) => block.text ?? "").join("");
  const name = Object.keys(SCRIPT).find((key) => text.includes(key));
  const steps = name ? SCRIPT[name] : [];
  for (const [index, step] of steps.entries()) {
    for (const call of step) {
      const id = "toolu_" + (++calls);
      assistant([{ type: "tool_use", id, name: call.name, input: call.input }]);
      if (call.result) toolResult(id, call.result.text, { task: { id: call.result.id, subject: call.input.subject } });
      else toolResult(id, "Updated task", null);
    }
    fs.writeFileSync(MARKERS + "/step-" + name + "-" + index, "");
    await waitFor(MARKERS + "/go-" + name + "-" + index);
  }
  assistant([{ type: "text", text: "Done." }]);
  write({ type: "result", subtype: "success", is_error: false, result: "Done.", session_id: sessionId, uuid: randomUUID(),
    duration_ms: 1, duration_api_ms: 1, num_turns: 1, total_cost_usd: 0, usage, permission_denials: [] });
};
let queue = Promise.resolve();
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
    else if (message.type === "user") queue = queue.then(() => turn(message));
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

/** The real Claude client. Only the account, usage and model reads are answered here. */
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

async function waitFor<T>(
  label: string,
  read: () => Promise<T | null | undefined | false>,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((done) => setTimeout(done, 20));
  }
}

interface Sample {
  turn: string;
  step: string;
  /** The step the agent works on now. */
  real: string | null;
  /** The plan as stored: each step's status, and its `current` step. */
  plan: { steps: string[]; current: string | null };
  shown: {
    /** The plan card's header while the list is closed. */
    card: string | null;
    /** The live-work bar's plan row. With no running step, it names the next open step. */
    bar: string | null;
    /** The first running step: what both views showed before this fix. */
    before: string | null;
  };
  ok: boolean;
  /** The old rule showed another step than the real one: the bug Elias saw. */
  wrongBefore: boolean;
}

const report: {
  samples: Sample[];
  summary?: { samples: number; shownRight: number; wrongBefore: number; afterTurnEnd: unknown };
  passed: boolean;
  error?: string;
} = { samples: [], passed: false };

const statusKey = (text: string) => TASK_KEYS.find((key) => TASKS[key].subject === text) ?? text;

/** What each view shows for the newest plan of the conversation, with the views' own functions. */
function readViews(messages: readonly ConversationMessage[]) {
  const rows = toAgentMessages(messages);
  const row = rows.findLast((message) => message.kind === "plan");
  const plan = row?.plan;
  if (!row || !plan) return null;
  const streaming = row.streaming === true;
  const items = planItems(plan, streaming);
  const card = activeTask(items, currentPlanStep(plan)?.id)?.label ?? null;
  const bar = createRoot((dispose) => {
    const dock = createSubagentDock({
      rows: () => rows,
      drawnRows: () => [],
      scrollElement: () => undefined,
      hidden: () => false,
    });
    const item = dock.items().find((entry) => entry.kind === "plan");
    dispose();
    return item?.plan?.current ?? null;
  });
  const first = plan.steps.find((step) => step.status === "inProgress");
  const before = streaming && first ? (first.activeText ?? first.text) : null;
  return { plan, streaming, card, bar, before };
}

const matches = (plan: ConversationPlan, expect: Step["expect"]) =>
  plan.steps.length === Object.keys(expect).length &&
  plan.steps.every((step) => expect[statusKey(step.text)] === step.status);

function startService() {
  const database = new OpenBotDatabase(userData);
  const store = new AgentStore(userData, home, database);
  const mailbox = new MailboxStore(userData, store.sharedRoot, store.database);
  const agents = new AgentService({
    store,
    mailbox,
    browser,
    preferredProvider: "claude",
    offProviders: AGENT_PROVIDERS.filter((provider) => provider !== "claude"),
    busyMessageMode: () => "queue",
    clientFactory: (_provider, cli) => new ClaudeStandIn(cli),
  });
  const stop = async () => {
    await runCauseEffect(agents.stop()).catch(() => {});
    database.close();
  };
  return { agents, stop };
}

await writeFile(claudeExecutable, STAND_IN_CLAUDE, { mode: 0o755 });
const service = startService();
try {
  const { agents } = service;
  await runCauseEffect(agents.initialize());
  const agent = await runCauseEffect(
    agents.createAgent({
      name: "Plan steps",
      description: "Checks the step a plan shows.",
      avatarSeed: "plan-steps",
      avatarHue: null,
      initialMessage: TURNS[0]?.prompt ?? "",
      provider: "claude",
      model: CLAUDE_MODEL,
    }),
  );
  const read = async () => (await runCauseEffect(agents.readConversation(agent.id))).messages;
  const idle = () =>
    !agents
      .listQueue(agent.id)
      .deliveries.some((delivery) => ["queued", "starting", "running"].includes(delivery.status));

  for (const [turnIndex, turn] of TURNS.entries()) {
    if (turnIndex > 0) await runCauseEffect(agents.sendMessage({ agentId: agent.id, text: turn.prompt }));
    for (const [index, step] of turn.steps.entries()) {
      const marker = join(markers, `step-${turn.prompt}-${index}`);
      await waitFor(`${turn.prompt} step ${index} in the stand-in`, async () => existsSync(marker));
      const views = await waitFor(`${turn.prompt} step ${index} in the conversation`, async () => {
        const seen = readViews(await read());
        return seen?.streaming && matches(seen.plan, step.expect) ? seen : null;
      });
      // With no running step, the bar names the next open step (its design since FEATURES.md §53).
      const next = views.plan.steps.find((entry) => entry.status !== "completed");
      const barExpected = step.real ?? (next ? (next.activeText ?? next.text) : null);
      const ok = views.card === step.real && views.bar === barExpected;
      report.samples.push({
        turn: turn.prompt,
        step: step.label,
        real: step.real,
        plan: {
          steps: views.plan.steps.map((entry) => `${entry.id}:${entry.status}:${entry.text}`),
          current: views.plan.current ?? null,
        },
        shown: { card: views.card, bar: views.bar, before: views.before },
        ok,
        wrongBefore: views.before !== step.real,
      });
      writeFileSync(join(markers, `go-${turn.prompt}-${index}`), "");
    }
    await waitFor(`${turn.prompt} to end`, async () => idle());
  }
  // After the turn ends, no step runs: the card and the bar name none.
  const ended = readViews(await read());
  const afterTurnEnd = { streaming: ended?.streaming ?? null, card: ended?.card ?? null, bar: ended?.bar ?? null };

  const wrong = report.samples.filter((sample) => !sample.ok);
  report.summary = {
    samples: report.samples.length,
    shownRight: report.samples.length - wrong.length,
    wrongBefore: report.samples.filter((sample) => sample.wrongBefore).length,
    afterTurnEnd,
  };
  assert.deepEqual(
    wrong.map(
      (sample) =>
        `${sample.turn} / ${sample.step}: real ${sample.real}, card ${sample.shown.card}, bar ${sample.shown.bar}`,
    ),
    [],
    "Each view shows the step the agent works on.",
  );
  assert.ok((report.summary.wrongBefore ?? 0) > 0, "The old rule shows a wrong step in this scenario (the bug).");
  assert.deepEqual(afterTurnEnd, { streaming: false, card: null, bar: null }, "An ended turn shows no running step.");
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.exitCode = 1;
} finally {
  await service.stop();
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await rm(root, { recursive: true, force: true });
  process.stdout.write(`${report.passed ? "PASS" : "FAIL"} ${join(OUT, "report.json")}\n`);
  if (report.error) process.stdout.write(`${report.error}\n`);
}
