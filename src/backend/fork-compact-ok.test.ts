// Fork (docs/fork/FEATURES.md #110): a `/compact` turn that compacted ends as completed, with no
// "Claude ended the turn with no answer" error, both for the "Compact before the cache goes cold"
// routine and for a `/compact` the user typed. A `/compact` whose compaction failed, and any other turn
// with no answer (also one with an automatic compaction), still fail. Runs the real AgentService and
// ClaudeAgentClient against a stand-in `claude` CLI, after scripts/claude-empty-turn-e2e.ts.
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_PROVIDERS, agentProviderDescriptor, defaultProviderModel } from "@openbot/contracts/ipc";
import { isString } from "@openbot/contracts/runtime-values";
import { sourceText } from "@openbot/i18n/source";
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentBrowserHost } from "./agent/turn-lifecycle";
import type { AgentClient, DiagnosticOrigin } from "./agent-client";
import type { AgentService as AgentServiceType } from "./agent-service";
import type { ClaudeCliInfo } from "./cli";
import { FORK_COMPACT_ROUTINE_ID, forkCompactPrompt, isCompactCommand } from "./fork-cache-compact";
import type { OpenBotDatabase as OpenBotDatabaseType } from "./openbot-database";
import {
  type AppServerNotification,
  type AppServerRequest,
  isRecord,
  type RequestId,
  type ResponseDecoder,
} from "./protocol";
import { providerSync } from "./provider-client-effects";
import type { ReadProviderHistory } from "./provider-history";

const CLAUDE_MODEL = defaultProviderModel("claude");
const NO_ANSWER = sourceText("error.provider.acpNoAnswer", { provider: agentProviderDescriptor("claude").displayName });
const TIMEOUT_MS = 60_000;

/** A `claude` CLI that answers, ends with no answer, or runs `/compact` (which may fail). */
function standInClaude(projectsDir: string, logPath: string): string {
  return `#!${process.execPath}
const fs = require("node:fs");
const { join } = require("node:path");
const { randomUUID } = require("node:crypto");
const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("2.1.329 (Claude Code)\\n");
  process.exit(0);
}
const option = (name) => {
  const index = args.findIndex((arg) => arg === name || arg.startsWith(name + "="));
  if (index < 0) return null;
  return args[index] === name ? (args[index + 1] ?? null) : args[index].slice(name.length + 1);
};
const sessionId = option("--resume") ?? option("--session-id") ?? randomUUID();
const transcript = join(${JSON.stringify(projectsDir)}, sessionId + ".jsonl");
const log = (entry) => fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(entry) + "\\n");
const write = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
let parentUuid = null;
const save = (entry) => {
  fs.appendFileSync(transcript, JSON.stringify({ ...entry, parentUuid, sessionId, timestamp: new Date().toISOString(), isSidechain: false }) + "\\n");
  parentUuid = entry.uuid;
};
const frame = (message) => ({ ...message, parent_tool_use_id: null, session_id: sessionId, uuid: randomUUID() });
const assistant = (message, text) => {
  const uuid = randomUUID();
  const reply = { id: "msg_" + uuid, type: "message", role: "assistant", model: ${JSON.stringify(CLAUDE_MODEL)},
    content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } };
  save({ type: "assistant", uuid, message: reply });
  write(frame({ type: "assistant", message: reply, user_message_uuid: message.uuid }));
};
const result = (message, text) =>
  write(frame({ type: "result", subtype: "success", is_error: false, result: text,
    user_message_uuid: message.uuid, user_message_uuids: [message.uuid], terminal_reason: "completed",
    duration_ms: 1, duration_api_ms: 1, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 },
    permission_denials: [] }));
const compact = (failed) => {
  write(frame({ type: "system", subtype: "status", status: "compacting" }));
  if (failed) {
    write(frame({ type: "system", subtype: "status", status: null, compact_result: "failed", compact_error: "Compaction failed." }));
    return;
  }
  write(frame({ type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "manual", pre_tokens: 120000 } }));
  write(frame({ type: "system", subtype: "status", status: null, compact_result: "success" }));
};
const turn = (message) => {
  const text = JSON.stringify(message.message);
  log({ prompt: text });
  save({ type: "user", uuid: message.uuid, message: message.message });
  if (text.includes("/compact")) {
    compact(text.includes("COMPACT-FAILS"));
    result(message, "");
    return;
  }
  if (text.includes("AUTO-COMPACT-THEN-EMPTY")) {
    compact(false);
    result(message, "");
    return;
  }
  if (text.includes("EMPTY-TURN")) {
    result(message, "");
    return;
  }
  assistant(message, "Done.");
  result(message, "Done.");
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
}

interface ClientEvents {
  notification: [notification: AppServerNotification];
  request: [request: AppServerRequest];
  exit: [error: Error];
  diagnostic: [message: string, origin?: DiagnosticOrigin];
}

const unused = () => Effect.die(new Error("Not used by this test."));
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

async function waitFor<T>(label: string, read: () => T | null | undefined | false): Promise<T> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((done) => setTimeout(done, 25));
  }
}

interface Outcome {
  delivery: string;
  row: string | null;
  errors: string[];
  answer: string | null;
}

describe("a /compact turn with no answer (fork #110)", () => {
  const saved = {
    HOME: process.env.HOME,
    path: process.env.OPENBOT_CLAUDE_PATH,
    config: process.env.CLAUDE_CONFIG_DIR,
  };
  let root = "";
  let logPath = "";
  let agents: AgentServiceType;
  let database: OpenBotDatabaseType;
  let agentId = "";
  let threadId = "";
  const errors: { agentId: string | null; message: string }[] = [];
  let runCause: typeof import("./effect-boundary").runCauseEffect;

  const prompts = (): string[] =>
    existsSync(logPath)
      ? readFileSync(logPath, "utf8")
          .split("\n")
          .filter(Boolean)
          .flatMap((line) => {
            const entry = JSON.parse(line);
            return isRecord(entry) && isString(entry.prompt) ? [entry.prompt] : [];
          })
      : [];
  const idle = () =>
    !agents
      .listQueue(agentId)
      .deliveries.some((delivery) => ["queued", "starting", "running"].includes(delivery.status));

  async function settle(text: string, send: () => Promise<unknown>): Promise<Outcome> {
    const errorsBefore = errors.length;
    await send();
    const delivery = await waitFor(`"${text}" to settle`, () => {
      const found = agents.listQueue(agentId).deliveries.find((item) => item.text === text);
      return found && ["completed", "failed", "interrupted", "cancelled"].includes(found.status) && idle()
        ? found
        : null;
    });
    const shown = database.readConversationPage(agentId, threadId, { type: "latest" }, 200).messages;
    const start = shown.findLastIndex((message) => message.author === "user" && message.text === text);
    return {
      delivery: delivery.status,
      row: shown[start]?.status ?? null,
      errors: errors
        .slice(errorsBefore)
        .filter((error) => error.agentId === agentId)
        .map((error) => error.message),
      answer:
        shown.slice(start + 1).findLast((message) => message.author === "assistant" && message.text.trim() !== "")
          ?.text ?? null,
    };
  }

  const sendUser = (text: string) => settle(text, () => runCause(agents.sendMessage({ agentId, text })));

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "openbot-fork-compact-ok-"));
    const home = join(root, "home");
    const claudeConfig = join(home, ".claude");
    const projectsDir = join(claudeConfig, "projects", "stand-in");
    const executable = join(root, "claude");
    logPath = join(root, "stand-in.jsonl");
    mkdirSync(projectsDir, { recursive: true });
    process.env.HOME = home;
    process.env.OPENBOT_CLAUDE_PATH = executable;
    process.env.CLAUDE_CONFIG_DIR = claudeConfig;
    await writeFile(executable, standInClaude(projectsDir, logPath), { mode: 0o755 });

    const { AgentService } = await import("./agent-service");
    const { AgentStore } = await import("./agent-store");
    const { ClaudeAgentClient } = await import("./claude-client");
    const { runCauseEffect } = await import("./effect-boundary");
    const { MailboxStore } = await import("./mailbox-store");
    const { OpenBotDatabase } = await import("./openbot-database");
    runCause = runCauseEffect;

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
      holdsBackgroundWork(externalThreadId: string) {
        return this.#real.holdsBackgroundWork(externalThreadId);
      }
      wakesAfterBackgroundWork(externalThreadId: string) {
        return this.#real.wakesAfterBackgroundWork(externalThreadId);
      }
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

    const userData = join(root, "user-data");
    database = new OpenBotDatabase(userData);
    const store = new AgentStore(userData, home, database);
    const mailbox = new MailboxStore(userData, store.sharedRoot, store.database);
    agents = new AgentService({
      store,
      mailbox,
      browser,
      preferredProvider: "claude",
      offProviders: AGENT_PROVIDERS.filter((provider) => provider !== "claude"),
      clientFactory: (_provider, cli) => new ClaudeStandIn(cli),
    });
    agents.on("event", (event) => {
      if (event.type === "error") errors.push({ agentId: event.agentId ?? null, message: event.message });
    });
    await runCauseEffect(agents.initialize());
    const agent = await runCauseEffect(
      agents.createAgent({
        name: "Compact",
        description: "Checks a /compact turn.",
        avatarSeed: "compact",
        avatarHue: null,
        initialMessage: "First message.",
        provider: "claude",
        model: CLAUDE_MODEL,
      }),
    );
    agentId = agent.id;
    await waitFor("the first turn to end", () => prompts().length > 0 && idle());
    threadId = store.list().find((item) => item.id === agentId)?.threadId ?? "";
    if (!threadId) throw new Error("The agent has no chat thread.");
  }, TIMEOUT_MS);

  afterAll(async () => {
    if (agents) await runCause(agents.stop()).catch(() => {});
    database?.close();
    await rm(root, { recursive: true, force: true });
    for (const [key, value] of [
      ["HOME", saved.HOME],
      ["OPENBOT_CLAUDE_PATH", saved.path],
      ["CLAUDE_CONFIG_DIR", saved.config],
    ] as const)
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  }, TIMEOUT_MS);

  it("knows the /compact command", () => {
    expect(isCompactCommand(forkCompactPrompt())).toBe(true);
    expect(isCompactCommand("/compact")).toBe(true);
    expect(isCompactCommand("  /compact keep the plan")).toBe(true);
    expect(isCompactCommand("/compaction")).toBe(false);
    expect(isCompactCommand("please /compact")).toBe(false);
  });

  it(
    "completes the cache-compact routine run that compacted",
    async () => {
      const text = forkCompactPrompt();
      const outcome = await settle(text, () =>
        runCause(
          agents.enqueueRoutineHandoff({
            run: {
              id: `${agentId}:1`,
              routineId: FORK_COMPACT_ROUTINE_ID,
              routineName: "🗜 Compact before the cache goes cold (120k tokens)",
              scheduledFor: new Date().toISOString(),
            },
            agentId,
            text,
            idempotencyKey: `${FORK_COMPACT_ROUTINE_ID}:${agentId}:1`,
          }),
        ),
      );
      expect(outcome).toMatchObject({ delivery: "completed", row: "completed", errors: [], answer: null });
    },
    TIMEOUT_MS,
  );

  it(
    "completes a typed /compact that compacted",
    async () => {
      const outcome = await sendUser("/compact keep the plan");
      expect(outcome).toMatchObject({ delivery: "completed", errors: [], answer: null });
    },
    TIMEOUT_MS,
  );

  it(
    "fails a /compact whose compaction failed",
    async () => {
      const outcome = await sendUser("/compact COMPACT-FAILS");
      expect(outcome.delivery).toBe("failed");
      expect(outcome.errors).toEqual([NO_ANSWER]);
    },
    TIMEOUT_MS,
  );

  it(
    "still fails any other turn with no answer, also one with an automatic compaction",
    async () => {
      expect(await sendUser("PLAIN")).toMatchObject({ delivery: "completed", errors: [], answer: "Done." });
      expect(await sendUser("EMPTY-TURN")).toMatchObject({ delivery: "failed", errors: [NO_ANSWER] });
      expect(await sendUser("AUTO-COMPACT-THEN-EMPTY")).toMatchObject({ delivery: "failed", errors: [NO_ANSWER] });
    },
    TIMEOUT_MS,
  );
});
