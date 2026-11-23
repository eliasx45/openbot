// Fork (docs/fork/FEATURES.md #76): where WhatsApp Watch shows, end to end against a fake WhatsApp and
// a fake Codex app-server. With the default "Main chat", a watched contact's burst and the orchestrator's
// answer are in the orchestrator's own chat, the answer still goes to the owner's "Message yourself"
// chat, the watched contact gets nothing, the owner's own self-chat messages run in the same chat, and
// the turn's end is an app event that notifies on this computer at the orchestrator's level ("needs-me"
// by default, so a plain answer stays quiet). "Own thread" puts the next burst in a side thread
// "👁️ Ichiro", whose events reach its tab. "Phone only" keeps it out of the app, as before #76. The
// main chat keeps the watched message after a restart. Runs the real agent service, messaging service,
// WhatsApp driver, runtime, session and store on a temporary profile; only the Baileys socket and the
// Codex process are fake. `bun scripts/fork-whatsapp-watch-main-chat-e2e.ts`.
// Writes .openbot-build/fork-whatsapp-watch-main-chat-e2e/report.json.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Boom } from "@hapi/boom";
import type { AgentEvent, ServerNotificationLevel } from "@openbot/contracts/ipc";
import { AGENT_PROVIDERS } from "@openbot/contracts/ipc";
import type {
  AnyMessageContent,
  BaileysEventMap,
  GroupMetadata,
  MiscMessageGenerationOptions,
  UserFacingSocketConfig,
  WAMessage,
} from "@openbot/whatsapp/baileys";
import { Effect } from "effect";
import type { AgentBrowserHost } from "../src/backend/agent/turn-lifecycle";
import type { MessagingCredentials } from "../src/backend/messaging/messaging-service";
import type { WhatsAppAck, WhatsAppSocket } from "../src/backend/messaging/whatsapp/whatsapp-session";

const OUT = resolve(import.meta.dirname, "../.openbot-build/fork-whatsapp-watch-main-chat-e2e");
const root = await mkdtemp(join(tmpdir(), "openbot-watch-main-chat-e2e-"));
const userData = join(root, "user-data");
const home = join(root, "home");
const fakeCodex = join(root, "codex");
const fakeLog = join(root, "codex.jsonl");

// Before the service modules load: the Codex process and the stores read the home folder.
process.env.HOME = home;
process.env.CODEX_HOME = join(home, ".codex");
process.env.OPENBOT_CODEX_PATH = fakeCodex;
mkdirSync(home, { recursive: true });

const { AgentService } = await import("../src/backend/agent-service");
const { AgentStore } = await import("../src/backend/agent-store");
const { runCauseEffect } = await import("../src/backend/effect-boundary");
const { MailboxStore } = await import("../src/backend/mailbox-store");
const { MessagingService } = await import("../src/backend/messaging/messaging-service");
const { whatsAppDriver } = await import("../src/backend/messaging/whatsapp/whatsapp-driver");
const { WhatsAppRuntime } = await import("../src/backend/messaging/whatsapp/whatsapp-runtime");
const { MESSAGE_ACK } = await import("../src/backend/messaging/whatsapp/whatsapp-session");
const { WATCH_TIMING } = await import("../src/backend/messaging/whatsapp/whatsapp-watch");
const { OpenBotDatabase } = await import("../src/backend/openbot-database");
const { SidebarLayoutStore } = await import("../src/backend/sidebar-layout-store");
const { parseStartWhatsAppLinkInput, parseWhatsAppSenderInput } = await import("../src/main/ipc/messaging-inputs");
const { desktopAgentEventLevel } = await import("../src/main/desktop-notifications");

const OWNER = "48600100200";
const OWNER_JID = `${OWNER}@s.whatsapp.net`;
const ICHIRO = "819012345678";
const ICHIRO_JID = `${ICHIRO}@s.whatsapp.net`;
const ANSWER = "Ichiro sent a Frame.io review → Zito ✓";

WATCH_TIMING.debounceMs = 300;
WATCH_TIMING.maxWaitMs = 3_000;

/** A Codex app-server: a watched turn answers ANSWER, every other turn "Done.". It logs each turn's input. */
const FAKE_CODEX = `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli 0.160.1\\n");
  process.exit(0);
}
const LOG = ${JSON.stringify(fakeLog)};
const config = { config: { mcp_servers: {} }, layers: [{ name: { type: "user", file: "/fake/.codex/config.toml", profile: null }, version: "1", config: { mcp_servers: {} } }] };
let buffer = "";
let threads = 0;
let turns = 0;
process.stdout.on("error", (error) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});
const write = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const answer = (message) => {
  const params = message.params || {};
  switch (message.method) {
    case "initialize": return write({ id: message.id, result: {} });
    case "account/read": return write({ id: message.id, result: { account: { type: "chatgpt", email: "codex@example.com" } } });
    case "account/rateLimits/read": return write({ id: message.id, result: { rateLimits: { limitId: "codex", primary: null, secondary: null }, rateLimitsByLimitId: null } });
    case "model/list": return write({ id: message.id, result: { data: [{ model: "gpt-6-luna", displayName: "GPT-6 Luna" }] } });
    case "plugin/list": return write({ id: message.id, result: { marketplaces: [] } });
    case "config/read": return write({ id: message.id, result: config });
    case "config/batchWrite": return write({ id: message.id, result: {} });
    case "thread/start": return write({ id: message.id, result: { thread: { id: "thread-" + (++threads), turns: [] } } });
    case "thread/resume": return write({ id: message.id, result: { thread: { id: params.threadId, turns: [] } } });
    case "thread/unsubscribe": return write({ id: message.id, result: { status: "Unsubscribed" } });
    case "thread/turns/list":
    case "thread/items/list": return write({ id: message.id, result: { data: [], nextCursor: null } });
    case "thread/read": return write({ id: message.id, result: { thread: { id: params.threadId, turns: [] } } });
    case "turn/start": {
      const turnId = "turn-" + (++turns);
      const text = (params.input || []).map((item) => item.text || "").join("\\n");
      appendFileSync(LOG, JSON.stringify({ threadId: params.threadId, turnId, text }) + "\\n");
      write({ id: message.id, result: { turn: { id: turnId, status: "inProgress", items: [] } } });
      write({ method: "turn/started", params: { threadId: params.threadId, turn: { id: turnId } } });
      const reply = text.includes("👁️ Ichiro:") ? ${JSON.stringify(ANSWER)} : "Done.";
      return setTimeout(() => {
        const item = { type: "agentMessage", id: "message-" + turnId, text: reply, phase: "final_answer" };
        write({ method: "item/completed", params: { threadId: params.threadId, turnId, item } });
        write({ method: "turn/completed", params: { threadId: params.threadId, turn: { id: turnId, status: "completed" } } });
      }, 40);
    }
    case "turn/interrupt": {
      write({ id: message.id, result: {} });
      return write({ method: "turn/completed", params: { threadId: params.threadId, turn: { id: params.turnId, status: "interrupted" } } });
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

interface Step {
  name: string;
  passed: boolean;
  detail?: unknown;
  error?: string;
}
const report: { steps: Step[]; passed: boolean; unverified: string[] } = {
  steps: [],
  passed: false,
  unverified: [
    "A real phone and WhatsApp servers: a fake socket stands in for Baileys.",
    "A real model: a fake Codex app-server answers each turn.",
    "The macOS notification itself: the check runs the desktop level decision on the turn's app event; Electron's Notification is not shown here.",
  ],
};

async function step(name: string, run: () => Promise<unknown>): Promise<void> {
  const entry: Step = { name, passed: false };
  report.steps.push(entry);
  try {
    entry.detail = await run();
    entry.passed = true;
    process.stdout.write(`✓ ${name}\n`);
  } catch (error) {
    entry.error = error instanceof Error ? error.message : String(error);
    process.stdout.write(`✗ ${name}: ${entry.error}\n`);
    throw error;
  }
}

async function until<T>(read: () => T | null | undefined | false, label: string, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}.`);
    await new Promise((resume) => setTimeout(resume, 25));
  }
}

// The fake WhatsApp: only what the driver calls.

interface Write {
  method: string;
  jid: string;
  content: unknown;
}

class FakeSocket implements WhatsAppSocket {
  readonly #events = new EventEmitter();
  readonly #ws = new EventEmitter();
  readonly #phone: FakePhone;
  readonly config: UserFacingSocketConfig;
  ended = false;
  user: { id: string } | undefined;
  readonly ev = {
    on: <T extends keyof BaileysEventMap>(event: T, listener: (arg: BaileysEventMap[T]) => void) => {
      this.#events.on(event, listener);
    },
  };
  readonly ws: WhatsAppSocket["ws"] = this.#ws;
  readonly signalRepository = { lidMapping: { getPNForLID: async () => null, getLIDForPN: async () => null } };

  constructor(phone: FakePhone, config: UserFacingSocketConfig) {
    this.#phone = phone;
    this.config = config;
  }

  emit<T extends keyof BaileysEventMap>(event: T, arg: BaileysEventMap[T]): void {
    if (this.ended) return;
    this.#ws.emit("frame");
    this.#events.emit(event, arg);
  }

  boot(): void {
    const me = this.config.auth.creds.me;
    if (me?.id) {
      this.user = { id: me.id };
      this.emit("connection.update", { connection: "open" });
    } else this.emit("connection.update", { qr: `2@fake-qr-${this.#phone.sockets.length}` });
  }

  scan(): void {
    this.emit("creds.update", { me: { id: `${OWNER}:5@s.whatsapp.net`, lid: "777001:5@lid", name: "Elias" } });
    this.emit("connection.update", {
      connection: "close",
      lastDisconnect: { error: new Boom("closed", { statusCode: 515 }), date: new Date() },
    });
  }

  receive(messages: WAMessage[]): void {
    this.emit("messages.upsert", { messages, type: "notify" });
  }

  async sendMessage(jid: string, content: AnyMessageContent, options?: MiscMessageGenerationOptions) {
    if (this.ended) throw new Error("socket closed");
    const id = options?.messageId ?? `SENT${this.#phone.writes.length}`;
    this.#phone.writes.push({ method: "sendMessage", jid, content });
    setTimeout(() => {
      this.#ws.emit(MESSAGE_ACK, { attrs: { id } } satisfies WhatsAppAck);
    }, 0);
    const text = "text" in content && typeof content.text === "string" ? content.text : "";
    return { key: { remoteJid: jid, id, fromMe: true }, message: { conversation: text } } satisfies WAMessage;
  }
  async readMessages(keys: unknown[]) {
    this.#phone.writes.push({ method: "readMessages", jid: "", content: keys });
  }
  async sendPresenceUpdate(...args: unknown[]) {
    this.#phone.writes.push({ method: "sendPresenceUpdate", jid: String(args[1] ?? ""), content: args });
  }
  async requestPairingCode(): Promise<string> {
    return "ABCD1234";
  }
  async logout(): Promise<void> {}
  end(): void {
    this.ended = true;
  }
  async groupFetchAllParticipating() {
    return {};
  }
  async groupMetadata(jid: string): Promise<GroupMetadata> {
    return { id: jid, owner: undefined, subject: "Group", participants: [] };
  }
  async onWhatsApp(...phoneNumbers: string[]) {
    return phoneNumbers.map((number) => ({ jid: `${number}@s.whatsapp.net`, exists: true }));
  }
  async updateMediaMessage(message: WAMessage): Promise<WAMessage> {
    return message;
  }
}

class FakePhone {
  readonly sockets: FakeSocket[] = [];
  readonly writes: Write[] = [];
  readonly create = (config: UserFacingSocketConfig): WhatsAppSocket => {
    const socket = new FakeSocket(this, config);
    this.sockets.push(socket);
    queueMicrotask(() => socket.boot());
    return socket;
  };
  current(): FakeSocket {
    const socket = this.sockets.findLast((candidate) => !candidate.ended);
    assert.ok(socket, "No open fake socket.");
    return socket;
  }
  textsTo(jid: string): string[] {
    return this.writes.flatMap((write) => {
      const content = write.content;
      return write.method === "sendMessage" &&
        write.jid === jid &&
        typeof content === "object" &&
        content !== null &&
        "text" in content &&
        typeof content.text === "string"
        ? [content.text]
        : [];
    });
  }
  towardWatched(): Write[] {
    return this.writes.filter((write) => JSON.stringify(write).includes(ICHIRO));
  }
}

let counter = 0;
function text(input: { chat: string; text: string; fromMe?: boolean }): WAMessage {
  counter += 1;
  return {
    key: { remoteJid: input.chat, fromMe: input.fromMe ?? false, id: `IN${counter}` },
    message: { conversation: input.text },
    messageTimestamp: Math.floor(Date.now() / 1_000),
    pushName: "Ichiro K.",
  };
}

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

function memoryCredentials(): MessagingCredentials {
  const values = new Map<string, Record<string, string>>();
  return {
    keys: () => [...values.keys()],
    status: (connectionId) => (values.has(connectionId) ? "saved" : "missing"),
    get: (connectionId) => values.get(connectionId) ?? null,
    set: (connectionId, value) => Effect.sync(() => void values.set(connectionId, value)),
    clear: (connectionId) => Effect.sync(() => void values.delete(connectionId)),
    retain: (connectionIds) =>
      Effect.sync(() => {
        for (const key of values.keys()) if (!connectionIds.has(key)) values.delete(key);
      }),
  };
}

const credentials = memoryCredentials();
const phone = new FakePhone();
/** The owner's notification level of each agent, as the main process keeps it. */
const levels = new Map<string, ServerNotificationLevel>();
const defaultLevelCalls: string[] = [];

type Agents = InstanceType<typeof AgentService>;
type Messaging = InstanceType<typeof MessagingService>;

async function boot<T>(use: (agents: Agents, messaging: Messaging, events: AgentEvent[]) => Promise<T>): Promise<T> {
  const database = new OpenBotDatabase(userData);
  const store = new AgentStore(userData, home, database);
  const mailbox = new MailboxStore(userData, store.sharedRoot, store.database);
  busyMailbox = mailbox;
  const sidebar = new SidebarLayoutStore(join(userData, "sidebar-layout.json"));
  await runCauseEffect(sidebar.initialize());
  const agents = new AgentService({
    store,
    mailbox,
    browser,
    sidebarLayout: sidebar,
    preferredProvider: "codex",
    offProviders: AGENT_PROVIDERS.filter((provider) => provider !== "codex"),
    timezone: () => "UTC",
  });
  await runCauseEffect(agents.initialize());
  // What the app sees: the events that MessagingThreads and AgentTasks did not take.
  const events: AgentEvent[] = [];
  agents.on("event", (event: AgentEvent) => events.push(event));
  const runtime = new WhatsAppRuntime({
    root: join(userData, "whatsapp"),
    createSocket: phone.create,
    makeSignalRepository: () => {
      throw new Error("Not used by the fake socket.");
    },
    fetchVersion: async () => null,
  });
  const messaging = new MessagingService({
    threads: agents.messaging,
    agents: {
      listAgents: () => agents.listAgents(),
      respondToApproval: (input) => agents.respondToApproval(input),
      approvalExecutionThreadId: (requestId) => agents.approvalExecutionThreadId(requestId),
      onEvent: (listener) => {
        agents.on("event", listener);
        return () => agents.off("event", listener);
      },
      createAgentProfile: (input) => agents.createAgentProfile(input),
      createMemory: (input) => agents.createMemory(input),
      ensureDeletable: (agentId) => agents.ensureAgentDeletable(agentId),
      deleteAgent: (agentId) => agents.deleteAgent(agentId),
      sidebarChatIds: () => agents.sidebarChatIds(),
      defaultNotificationLevel: (agentId) => {
        defaultLevelCalls.push(agentId);
        if (!levels.has(agentId)) levels.set(agentId, "needs-me");
      },
    },
    credentials,
    drivers: [whatsAppDriver({ runtime })],
    downloadsRoot: join(userData, "messaging-downloads"),
    whatsapp: runtime,
    sidebar,
  });
  await runCauseEffect(messaging.start());
  try {
    return await use(agents, messaging, events);
  } finally {
    await runCauseEffect(messaging.stop());
    await runCauseEffect(agents.stop());
    database.close();
  }
}

function connectionId(agents: Agents): string {
  const record = agents.messaging.store.connectionForWorkspace("whatsapp", OWNER);
  assert.ok(record, "No WhatsApp connection row.");
  return record.connectionId;
}

function selfLink(agents: Agents) {
  const link = agents.messaging.store.linkByKey(connectionId(agents), OWNER_JID, "dm");
  assert.ok(link, "No self-chat link.");
  return link;
}

function codexTurns(): { threadId: string; text: string }[] {
  try {
    return readFileSync(fakeLog, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

const SERVER = { notificationsMuted: false, notificationLevel: "all" as const };

/** A watched burst of one message, then waits for its answer in the self chat. */
async function burst(agents: Agents, words: string): Promise<{ answers: number }> {
  const before = phone.textsTo(OWNER_JID).filter((sent) => sent.startsWith(ANSWER)).length;
  phone.current().receive([text({ chat: ICHIRO_JID, text: words })]);
  await until(
    () => phone.textsTo(OWNER_JID).filter((sent) => sent.startsWith(ANSWER)).length > before,
    "the orchestrator's answer in the self chat",
  );
  await until(() => agents.messaging.store.links(orchestrator).every((link) => !busy(agents, link.linkId)), "idle");
  return { answers: before + 1 };
}

let orchestrator = "";
let busyMailbox: InstanceType<typeof MailboxStore> | null = null;
function busy(_agents: Agents, linkId: string): boolean {
  return (busyMailbox?.unresolvedMessagingDeliveries(linkId).length ?? 0) > 0;
}

await writeFile(fakeCodex, FAKE_CODEX, { mode: 0o755 });
try {
  await boot(async (agents, messaging, events) => {
    await step(
      "link the owner's personal number, add the orchestrator, watch Ichiro (default: Main chat)",
      async () => {
        await runCauseEffect(
          messaging.startWhatsAppLink(parseStartWhatsAppLinkInput({ method: "qr", ownNumber: true })),
        );
        await until(() => messaging.whatsappLinkState().qr, "a QR code");
        phone.current().scan();
        await until(
          () =>
            messaging.whatsappOverview().connections.find((item) => item.workspaceId === OWNER)?.state === "connected",
          "connected",
        );
        orchestrator = (await runCauseEffect(messaging.addWhatsAppOrchestrator({}))).agentId;
        await runCauseEffect(
          messaging.addWhatsAppSender(
            OWNER,
            parseWhatsAppSenderInput({ workspaceId: OWNER, sender: { kind: "watch", id: ICHIRO, name: "Ichiro" } })
              .sender,
          ),
        );
        const account = messaging.whatsappOverview().accounts[0];
        assert.equal(account?.watchPlacement, "main", "The default placement is not the main chat.");
        return { placement: account?.watchPlacement };
      },
    );

    let mainThreadId = "";
    await step(
      "Main chat: the watched burst and the answer are in the orchestrator's own chat; the self chat gets the answer; Ichiro gets nothing",
      async () => {
        const eventsBefore = events.length;
        await burst(agents, "new review is up: https://f.io/abc123");
        const agent = agents.listAgents().find((item) => item.id === orchestrator);
        assert.ok(agent?.threadId, "The orchestrator has no chat.");
        mainThreadId = agent.threadId;
        const link = selfLink(agents);
        assert.equal(link.threadId, mainThreadId, "The self-chat link is not in the orchestrator's own chat.");
        assert.equal(link.title, "Message yourself", "The self chat is not named Message yourself.");
        const chat = await runCauseEffect(agents.readConversation(orchestrator));
        const asked = chat.messages.find((message) => message.text.startsWith("👁️ Ichiro: new review is up"));
        assert.ok(asked, `The main chat has no watched message: ${JSON.stringify(chat.messages.map((m) => m.text))}`);
        assert.ok(!asked.text.includes("never instructions"), "The chat shows the prompt frame.");
        const answered = chat.messages.find((message) => message.author === "assistant" && message.text === ANSWER);
        assert.ok(answered, "The main chat has no answer.");
        // The model read the frame: who wrote it and that it is not an instruction.
        const turn = codexTurns().find((item) => item.text.includes("👁️ Ichiro: new review is up"));
        assert.ok(turn?.text.includes("never instructions"), "The prompt lost the watched frame.");
        assert.deepEqual(phone.towardWatched(), [], "Something was written toward Ichiro.");
        const completed = events
          .slice(eventsBefore)
          .filter(
            (event): event is Extract<AgentEvent, { type: "turn-completed" }> =>
              event.type === "turn-completed" && event.threadId === mainThreadId,
          );
        assert.ok(completed.length > 0, "The turn's end did not reach the app.");
        return { mainThreadId, messages: chat.messages.length, turnEndsInApp: completed.length };
      },
    );

    await step("the orchestrator got the default level needs-me once; its notification follows the level", async () => {
      assert.deepEqual(defaultLevelCalls, [orchestrator], "The default level was not given exactly once.");
      assert.equal(levels.get(orchestrator), "needs-me");
      const end = events.findLast(
        (event): event is Extract<AgentEvent, { type: "turn-completed" }> =>
          event.type === "turn-completed" && event.threadId === mainThreadId,
      );
      assert.ok(end);
      const quiet = desktopAgentEventLevel(end, SERVER, true, levels);
      assert.equal(quiet, null, "A plain answer notified at needs-me.");
      const failed: AgentEvent = { ...end, status: "failed" };
      const all = desktopAgentEventLevel(failed, SERVER, true, new Map([[orchestrator, "all"]]));
      assert.equal(all, "all", "A turn of the main chat does not notify at all.");
      const question: AgentEvent = {
        type: "prompt",
        agentId: orchestrator,
        threadId: mainThreadId,
        turnId: end.turnId,
        requestId: "q1",
        questions: [],
      };
      assert.equal(desktopAgentEventLevel(question, SERVER, true, levels), "needs-me", "A question did not notify.");
      return { level: levels.get(orchestrator), plainAnswer: quiet, question: "needs-me" };
    });

    await step(
      "the owner's own self-chat message runs in the same main chat, and its answer goes to the self chat",
      async () => {
        const before = phone.textsTo(OWNER_JID).length;
        phone.current().receive([text({ chat: OWNER_JID, fromMe: true, text: "what did Ichiro send?" })]);
        await until(
          () =>
            phone
              .textsTo(OWNER_JID)
              .slice(before)
              .some((sent) => sent.startsWith("Done.")),
          "the answer",
        );
        const chat = await runCauseEffect(agents.readConversation(orchestrator));
        assert.ok(chat.messages.some((message) => message.text.includes("what did Ichiro send?")));
        const turn = codexTurns().find((item) => item.text.includes("what did Ichiro send?"));
        const watchedTurn = codexTurns().find((item) => item.text.includes("👁️ Ichiro: new review is up"));
        assert.equal(turn?.threadId, watchedTurn?.threadId, "The owner's question ran in another provider session.");
        assert.deepEqual(phone.towardWatched(), []);
        return { sameSession: true };
      },
    );

    await step('Own thread: the next burst runs in a side thread "👁️ Ichiro" whose events reach its tab', async () => {
      await runCauseEffect(messaging.setWhatsAppWatchPlacement(OWNER, "thread"));
      const eventsBefore = events.length;
      await burst(agents, "and the logo pops too early at 0:12");
      const link = selfLink(agents);
      const tasks = agents.listTasks(orchestrator).tasks;
      const task = tasks.find((item) => item.threadId === link.threadId);
      assert.ok(task, `The self chat is not in a side thread: ${JSON.stringify(tasks.map((t) => t.title))}`);
      assert.equal(task.title, "👁️ Ichiro");
      const conversation = agents.readTask(orchestrator, task.id);
      assert.ok(conversation.messages.some((message) => message.text.startsWith("👁️ Ichiro: and the logo")));
      const tabEvents = events
        .slice(eventsBefore)
        .filter((event) => event.type === "agent-task-conversation" || event.type === "thread-turn-completed");
      assert.ok(tabEvents.length > 0, "The side thread's events did not reach the app.");
      assert.deepEqual(phone.towardWatched(), []);
      return { title: task.title, tabEvents: tabEvents.length };
    });

    await step(
      "Phone only: the next burst runs in a hidden thread, as before #76; the self chat still gets the answer",
      async () => {
        await runCauseEffect(messaging.setWhatsAppWatchPlacement(OWNER, "phone"));
        const eventsBefore = events.length;
        await burst(agents, "music too loud at 0:40");
        const link = selfLink(agents);
        assert.notEqual(link.threadId, mainThreadId);
        assert.ok(!agents.listTasks(orchestrator).tasks.some((task) => task.threadId === link.threadId));
        const shown = events
          .slice(eventsBefore)
          .filter(
            (event) =>
              (event.type === "turn-completed" || event.type === "turn-started") && event.threadId === link.threadId,
          );
        assert.deepEqual(shown, [], "A phone-only turn reached the app.");
        assert.deepEqual(phone.towardWatched(), []);
        // Back to the default for the restart below.
        await runCauseEffect(messaging.setWhatsAppWatchPlacement(OWNER, "main"));
        return { hiddenThread: true };
      },
    );
  });

  await boot(async (agents) => {
    await step("after a restart the main chat still shows the watched message and its answer", async () => {
      const chat = await runCauseEffect(agents.readConversation(orchestrator));
      assert.ok(chat.messages.some((message) => message.text.startsWith("👁️ Ichiro: new review is up")));
      assert.ok(chat.messages.some((message) => message.author === "assistant" && message.text === ANSWER));
      return { messages: chat.messages.length };
    });
  });

  report.passed = true;
} finally {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await rm(root, { recursive: true, force: true });
}
process.stdout.write(
  `WhatsApp Watch placement check passed (${report.steps.length} steps). ${join(OUT, "report.json")}\n`,
);
