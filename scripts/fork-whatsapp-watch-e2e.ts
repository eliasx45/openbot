// Fork (docs/fork/FEATURES.md #68): WhatsApp Watch end to end against a fake WhatsApp. A watched
// contact's burst (text, an encrypted image served from this computer, the owner's own reply) becomes
// one turn of the WhatsApp Orchestrator in the owner's "Message yourself" conversation, with the image
// downloaded and decrypted; the orchestrator's answer goes to the self chat; every write toward the
// watched chat (post, reaction, edit, delete, presence, read receipt, chat modify, by phone JID and by
// LID) is refused and never reaches the socket; strangers stay ignored; the self chat and allowed
// contacts work as before; an unsent burst replays after a restart. Runs the real agent service,
// messaging service, WhatsApp driver, runtime, session and store on a temporary profile. Only the
// Baileys socket is fake: no message leaves this computer. `bun scripts/fork-whatsapp-watch-e2e.ts`.
// Writes .openbot-build/fork-whatsapp-watch-e2e/report.json.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Boom } from "@hapi/boom";
import type { MessagingConnection } from "@openbot/contracts/ipc";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import {
  type AnyMessageContent,
  type BaileysEventMap,
  encryptedStream,
  type GroupMetadata,
  type MiscMessageGenerationOptions,
  type UserFacingSocketConfig,
  type WAMessage,
} from "@openbot/whatsapp/baileys";
import { gc } from "bun";
import { Effect, Result } from "effect";
import type { AgentBrowserHost } from "../src/backend/agent/turn-lifecycle";
import { AgentService } from "../src/backend/agent-service";
import { AgentStore } from "../src/backend/agent-store";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { MailboxStore } from "../src/backend/mailbox-store";
import { type MessagingCredentials, MessagingService } from "../src/backend/messaging/messaging-service";
import { whatsAppDriver } from "../src/backend/messaging/whatsapp/whatsapp-driver";
import { WhatsAppRuntime } from "../src/backend/messaging/whatsapp/whatsapp-runtime";
import { MESSAGE_ACK, type WhatsAppAck, type WhatsAppSocket } from "../src/backend/messaging/whatsapp/whatsapp-session";
import { WATCH_TIMING, WhatsAppWatchRefused } from "../src/backend/messaging/whatsapp/whatsapp-watch";
import { OpenBotDatabase } from "../src/backend/openbot-database";
import { SidebarLayoutStore } from "../src/backend/sidebar-layout-store";
import { parseStartWhatsAppLinkInput, parseWhatsAppSenderInput } from "../src/main/ipc/messaging-inputs";

const OUT = resolve(import.meta.dirname, "../.openbot-build/fork-whatsapp-watch-e2e");
const REPORT = join(OUT, "report.json");
const root = await mkdtemp(join(tmpdir(), "openbot-whatsapp-watch-e2e-"));
const userData = join(root, "user-data");
const home = join(root, "home");
const whatsappRoot = join(userData, "whatsapp");

const OWNER = "48600100200";
const OWNER_JID = `${OWNER}@s.whatsapp.net`;
const ICHIRO = "819012345678";
const ICHIRO_JID = `${ICHIRO}@s.whatsapp.net`;
const ICHIRO_LID = "555000111@lid";
const FRIEND = "48600100300";
const FRIEND_JID = `${FRIEND}@s.whatsapp.net`;
const STRANGER_JID = "48600100400@s.whatsapp.net";

// Short bursts here; the app waits two minutes.
WATCH_TIMING.debounceMs = 400;
WATCH_TIMING.maxWaitMs = 5_000;

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
    "The real WhatsApp servers and phones: a fake socket stands in for Baileys. That the phone keeps the chat unread and the contact sees grey ticks only is Elias's live check (night queue, --who elias).",
    "An agent turn: no provider runs. The orchestrator's answer is posted with the same adapter call that a finished turn makes.",
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

async function until<T>(read: () => T | null | undefined | false, label: string, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}.`);
    await new Promise((resume) => setTimeout(resume, 25));
  }
}

const sleep = (ms: number) => new Promise((resume) => setTimeout(resume, ms));

// The fake WhatsApp.

interface Sent {
  jid: string;
  content: AnyMessageContent;
  id: string;
}

/** Every write call that reached the socket, by method, with its arguments. */
interface Write {
  method: string;
  args: unknown[];
}

class FakeSocket implements WhatsAppSocket {
  readonly #events = new EventEmitter();
  readonly #frames = new Set<() => void>();
  readonly #acks = new Set<(node: WhatsAppAck) => void>();
  readonly #phone: FakePhone;
  readonly config: UserFacingSocketConfig;
  ended = false;
  user: { id: string } | undefined;
  readonly ev = {
    on: <T extends keyof BaileysEventMap>(event: T, listener: (arg: BaileysEventMap[T]) => void) => {
      this.#events.on(event, listener);
    },
  };
  readonly ws: WhatsAppSocket["ws"] = {
    on: (event: string, listener: (node: WhatsAppAck) => void) => {
      if (event === MESSAGE_ACK) this.#acks.add(listener);
      else this.#frames.add(() => listener({ attrs: {} }));
    },
  };
  readonly signalRepository = {
    lidMapping: {
      getPNForLID: async (lid: string) => (lid === ICHIRO_LID ? ICHIRO_JID : null),
    },
  };

  constructor(phone: FakePhone, config: UserFacingSocketConfig) {
    this.#phone = phone;
    this.config = config;
  }

  emit<T extends keyof BaileysEventMap>(event: T, arg: BaileysEventMap[T]): void {
    if (this.ended) return;
    for (const frame of this.#frames) frame();
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
    const id = options?.messageId ?? `SENT${this.#phone.sent.length}`;
    this.#phone.sent.push({ jid, content, id });
    this.#phone.writes.push({ method: "sendMessage", args: [jid, content] });
    setTimeout(() => {
      for (const ack of this.#acks) ack({ attrs: { id } });
    }, 0);
    const text = "text" in content && typeof content.text === "string" ? content.text : "";
    return { key: { remoteJid: jid, id, fromMe: true }, message: { conversation: text } } satisfies WAMessage;
  }

  // The write methods of a real Baileys socket that OpenBot never calls. The guard wraps them too.
  async readMessages(keys: unknown[]) {
    this.#phone.writes.push({ method: "readMessages", args: [keys] });
  }
  async sendReceipt(...args: unknown[]) {
    this.#phone.writes.push({ method: "sendReceipt", args });
  }
  async sendReceipts(...args: unknown[]) {
    this.#phone.writes.push({ method: "sendReceipts", args });
  }
  async sendPresenceUpdate(...args: unknown[]) {
    this.#phone.writes.push({ method: "sendPresenceUpdate", args });
  }
  async presenceSubscribe(...args: unknown[]) {
    this.#phone.writes.push({ method: "presenceSubscribe", args });
  }
  async chatModify(...args: unknown[]) {
    this.#phone.writes.push({ method: "chatModify", args });
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
  readonly sent: Sent[] = [];
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
    return this.sent.flatMap((sent) =>
      sent.jid === jid && "text" in sent.content && typeof sent.content.text === "string" ? [sent.content.text] : [],
    );
  }

  reactionsTo(jid: string): number {
    return this.sent.filter((sent) => sent.jid === jid && "react" in sent.content).length;
  }

  /** Every write that names the watched chat anywhere in its arguments. */
  towardWatched(): Write[] {
    return this.writes.filter((write) => {
      const text = JSON.stringify(write.args);
      return text.includes(ICHIRO) || text.includes(ICHIRO_LID);
    });
  }
}

let counter = 0;
function text(input: { chat: string; text: string; fromMe?: boolean; remoteJidAlt?: string; pushName?: string }) {
  counter += 1;
  return {
    key: {
      remoteJid: input.chat,
      fromMe: input.fromMe ?? false,
      id: `IN${counter}`,
      ...(input.remoteJidAlt ? { remoteJidAlt: input.remoteJidAlt } : {}),
    },
    message: { conversation: input.text },
    messageTimestamp: Math.floor(Date.now() / 1_000),
    pushName: input.pushName ?? "Ichiro K.",
  } satisfies WAMessage;
}

// An encrypted image, served from this computer as WhatsApp's media server would serve it.
const IMAGE = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(4_000, 7)]);
const encrypted = await encryptedStream(IMAGE, "image");
const media = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: () => new Response(readFileSync(encrypted.encFilePath)),
});

function image(caption: string): WAMessage {
  counter += 1;
  return {
    key: { remoteJid: ICHIRO_JID, fromMe: false, id: `IMG${counter}` },
    message: {
      imageMessage: {
        url: `http://127.0.0.1:${media.port}/frame.png`,
        mediaKey: encrypted.mediaKey,
        fileEncSha256: encrypted.fileEncSha256,
        fileSha256: encrypted.fileSha256,
        fileLength: encrypted.fileLength,
        mimetype: "image/png",
        caption,
      },
    },
    messageTimestamp: Math.floor(Date.now() / 1_000),
    pushName: "Ichiro K.",
  };
}

// The services.

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

interface Booted {
  agents: AgentService;
  messaging: MessagingService;
  runtime: WhatsAppRuntime;
  mailbox: MailboxStore;
}

async function boot<T>(use: (services: Booted) => Promise<T>): Promise<T> {
  const database = new OpenBotDatabase(userData);
  const store = new AgentStore(userData, home, database);
  const mailbox = new MailboxStore(userData, store.sharedRoot, store.database);
  const sidebar = new SidebarLayoutStore(join(userData, "sidebar-layout.json"));
  await runCauseEffect(sidebar.initialize());
  await runCauseEffect(store.initialize());
  await runCauseEffect(mailbox.initialize());
  const agents = new AgentService({ store, mailbox, browser, sidebarLayout: sidebar });
  const runtime = new WhatsAppRuntime({
    root: whatsappRoot,
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
      onEvent: () => () => {},
      createAgentProfile: (input) => agents.createAgentProfile(input),
      createMemory: (input) => agents.createMemory(input),
      ensureDeletable: (agentId) => agents.ensureAgentDeletable(agentId),
      deleteAgent: (agentId) => agents.deleteAgent(agentId),
      sidebarChatIds: () => agents.sidebarChatIds(),
    },
    credentials,
    drivers: [whatsAppDriver({ runtime })],
    downloadsRoot: join(userData, "messaging-downloads"),
    whatsapp: runtime,
    sidebar,
  });
  await runCauseEffect(messaging.start());
  try {
    return await use({ agents, messaging, runtime, mailbox });
  } finally {
    await runCauseEffect(messaging.stop());
    await runCauseEffect(agents.stop());
    database.close();
    gc(true);
  }
}

function connection(messaging: MessagingService): MessagingConnection | undefined {
  return messaging.whatsappOverview().connections.find((candidate) => candidate.workspaceId === OWNER);
}

function connectionId(agents: AgentService): string {
  const record = agents.messaging.store.connectionForWorkspace("whatsapp", OWNER);
  assert.ok(record, "No WhatsApp connection row.");
  return record.connectionId;
}

function deliveryKey(agents: AgentService, chat: string, id: string): string {
  return `messaging:${connectionId(agents)}:${chat}:${id}`;
}

function received(agents: AgentService, chat: string, id: string): boolean {
  return agents.messaging.received(deliveryKey(agents, chat, id));
}

function values(agents: AgentService): Record<string, string> {
  const stored = credentials.get(connectionId(agents));
  assert.ok(stored, "No stored values.");
  return stored;
}

/** The reason that a write was refused. Fails when the write went through. */
async function refused(effect: Effect.Effect<unknown, unknown>): Promise<string> {
  const result = await Effect.runPromise(Effect.result(effect));
  assert.ok(Result.isFailure(result), "A write toward the watched chat went through.");
  const failure = result.failure;
  return isDynamicRecord(failure) && failure.cause instanceof Error ? failure.cause.message : String(failure);
}

/** The watched message that waits in its burst when OpenBot stops. */
let lateId = "";

try {
  await boot(async ({ agents, messaging, runtime, mailbox }) => {
    let orchestratorId = "";

    await step("link the owner's personal number and add the WhatsApp Orchestrator", async () => {
      await runCauseEffect(messaging.startWhatsAppLink(parseStartWhatsAppLinkInput({ method: "qr", ownNumber: true })));
      await until(() => messaging.whatsappLinkState().qr, "a QR code");
      phone.current().scan();
      await until(() => connection(messaging)?.state === "connected", "connected");
      orchestratorId = (await runCauseEffect(messaging.addWhatsAppOrchestrator({}))).agentId;
      return { orchestratorId };
    });

    await step("settings: watch and allow are exclusive, and the overview lists the watched contact", async () => {
      const add = (sender: unknown) =>
        runCauseEffect(
          messaging.addWhatsAppSender(OWNER, parseWhatsAppSenderInput({ workspaceId: OWNER, sender }).sender),
        );
      await add({ kind: "contact", id: FRIEND, name: "Friend" });
      await add({ kind: "contact", id: ICHIRO, name: "Ichiro" });
      await add({ kind: "watch", id: `+81 90 1234 5678`, name: "Ichiro" });
      const account = messaging.whatsappOverview().accounts[0];
      assert.deepEqual(
        account?.allowedSenders.map((sender) => sender.id),
        [FRIEND],
        "Ichiro stayed an allowed sender after he was watched.",
      );
      assert.deepEqual(account?.watched, [{ id: ICHIRO, kind: "watch", name: "Ichiro" }]);
      return { allowed: account?.allowedSenders.length, watched: account?.watched?.length };
    });

    await step("the owner's own chat starts its conversation as before", async () => {
      const first = text({ chat: OWNER_JID, fromMe: true, text: "Desk, are you there?" });
      phone.current().receive([first]);
      await until(() => received(agents, OWNER_JID, first.key.id), "the owner's message");
      await until(() => phone.reactionsTo(OWNER_JID) === 1, "the 👀 on the owner's message");
      return { linked: Boolean(agents.messaging.store.linkByKey(connectionId(agents), OWNER_JID, "dm")) };
    });

    let watchedHead = "";
    await step(
      "a watched burst (text, image, the owner's reply) is one orchestrator turn in the self chat",
      async () => {
        const writesBefore = phone.writes.length;
        const link = text({ chat: ICHIRO_JID, text: "new review is up: https://f.io/abc123" });
        const shot = image("frame 1280 the logo pops too early");
        const ownReply = text({ chat: ICHIRO_JID, fromMe: true, text: "thanks, on it tomorrow" });
        watchedHead = link.key.id;
        phone.current().receive([link]);
        await sleep(150);
        phone.current().receive([shot]);
        await sleep(150);
        phone.current().receive([ownReply]);
        // Within the burst nothing has gone yet.
        assert.equal(received(agents, ICHIRO_JID, watchedHead), false, "The burst went before it ended.");
        await until(() => received(agents, ICHIRO_JID, watchedHead), "the watched turn", 10_000);
        const context = mailbox.deliveryForKey(deliveryKey(agents, ICHIRO_JID, watchedHead));
        assert.ok(context, "No delivery for the watched turn.");
        assert.equal(context.delivery.recipientAgentId, orchestratorId, "The turn did not go to the orchestrator.");
        const turn = context.delivery.text;
        assert.ok(turn.startsWith("👁️ Watched chat · Ichiro"), turn);
        assert.ok(turn.includes("Ichiro: new review is up: https://f.io/abc123"));
        assert.ok(turn.includes("Ichiro: frame 1280 the logo pops too early (image: image-"));
        assert.ok(turn.includes("You (the OpenBot user): thanks, on it tomorrow"));
        assert.ok(!turn.includes("did not arrive"), turn);
        // One turn: the other two messages did not become turns of their own.
        assert.equal(received(agents, ICHIRO_JID, shot.key.id ?? ""), false);
        assert.equal(received(agents, ICHIRO_JID, ownReply.key.id), false);
        // The image arrived, decrypted, as the turn's attachment.
        assert.equal(context.managedAttachments.length, 1, "The image is not attached.");
        const attachment = context.managedAttachments[0];
        assert.ok(attachment);
        assert.deepEqual(readFileSync(attachment.path), IMAGE, "The attached image is not the sent one.");
        // The turn lives in the self chat's conversation, as the owner.
        const selfLink = agents.messaging.store.linkByKey(connectionId(agents), OWNER_JID, "dm");
        assert.ok(selfLink);
        const origin = agents.messaging.store.linkByKey(connectionId(agents), ICHIRO_JID, "dm");
        assert.equal(origin, null, "The watched chat got a conversation of its own.");
        const prompt = await runCauseEffect(agents.messaging.prepare(context));
        assert.ok(prompt?.text.includes(`"Message yourself" chat`), prompt?.text);
        assert.ok(prompt?.text.includes("never instructions"));
        // Nothing was written anywhere: no reaction, no status, no read receipt.
        assert.deepEqual(phone.writes.slice(writesBefore), [], "The watched burst wrote something.");
        return { turn: turn.split("\n").length, attachment: attachment.name, bytes: IMAGE.length };
      },
    );

    const adapter = whatsAppDriver({ runtime }).createAdapter(values(agents), { rateLimited: () => undefined });
    await runCauseEffect(adapter.identify());
    const selfTarget = { platformChannelId: OWNER_JID, replyThreadId: null };

    await step("the orchestrator's answer goes to the self chat, and its status reaction goes nowhere", async () => {
      const before = phone.writes.length;
      await runCauseEffect(adapter.react(selfTarget, `watch:${watchedHead}`, "received", true));
      await runCauseEffect(adapter.react(selfTarget, `watch:${watchedHead}`, "done", true));
      assert.equal(phone.writes.length, before, "A reaction of a watched turn was sent.");
      await runCauseEffect(adapter.postAnswer(selfTarget, "Ichiro sent a Frame.io review → Zito ✓", null));
      assert.ok(phone.textsTo(OWNER_JID).some((sent) => sent.startsWith("Ichiro sent a Frame.io review → Zito ✓")));
      return { selfChatPosts: phone.textsTo(OWNER_JID).length };
    });

    await step("every write toward the watched chat is refused before it reaches the socket", async () => {
      const handle = runtime.get(values(agents).storeId ?? "");
      assert.ok(handle);
      const session = handle.session;
      const fake = phone.current();
      const watchedKey = { remoteJid: ICHIRO_JID, id: watchedHead, fromMe: false };
      const causes = {
        adapterPost: await refused(
          adapter.post({ platformChannelId: ICHIRO_JID, replyThreadId: null }, { text: "hi" }),
        ),
        adapterAnswer: await refused(
          adapter.postAnswer({ platformChannelId: ICHIRO_JID, replyThreadId: null }, "hi", null),
        ),
        sessionText: await refused(session.send(ICHIRO_JID, { text: "hi" })),
        sessionDevice: await refused(session.send(`${ICHIRO}:3@s.whatsapp.net`, { text: "hi" })),
        sessionLid: await refused(session.send(ICHIRO_LID, { text: "hi" })),
        reaction: await refused(session.send(OWNER_JID, { react: { text: "👀", key: watchedKey } })),
        edit: await refused(session.send(OWNER_JID, { text: "x", edit: watchedKey })),
        delete: await refused(session.send(OWNER_JID, { delete: watchedKey })),
      };
      for (const cause of Object.values(causes).slice(2))
        assert.match(String(cause), /watched_chat/u, "A session write was not refused as watched.");
      // The fake's own methods, which the session wrapped when it made the socket.
      const direct: Array<[string, () => Promise<unknown>]> = [
        ["sendMessage", () => fake.sendMessage(ICHIRO_JID, { text: "hi" })],
        ["readMessages", () => fake.readMessages([watchedKey])],
        ["sendReceipt", () => fake.sendReceipt(ICHIRO_JID, undefined, [watchedHead], "read")],
        ["sendReceipts", () => fake.sendReceipts([watchedKey], "read")],
        ["sendPresenceUpdate", () => fake.sendPresenceUpdate("composing", ICHIRO_JID)],
        ["presenceSubscribe", () => fake.presenceSubscribe(ICHIRO_JID)],
        ["chatModify", () => fake.chatModify({ markRead: true }, ICHIRO_JID)],
      ];
      for (const [method, write] of direct) await assert.rejects(write(), WhatsAppWatchRefused, method);
      assert.deepEqual(phone.towardWatched(), [], "A write toward the watched chat reached the socket.");
      return { causes, socketMethods: direct.map(([method]) => method) };
    });

    await step("a watched message from the LID form is read, and the LID is refused too", async () => {
      const fromLid = text({ chat: ICHIRO_LID, remoteJidAlt: ICHIRO_JID, text: "one more thing" });
      phone.current().receive([fromLid]);
      await until(() => received(agents, ICHIRO_JID, fromLid.key.id), "the LID message as a watched turn");
      const session = runtime.get(values(agents).storeId ?? "")?.session;
      assert.ok(session);
      assert.equal(await session.refuses(ICHIRO_LID), true);
      assert.deepEqual(phone.towardWatched(), []);
      return { id: fromLid.key.id };
    });

    await step(
      "a third waiting watched turn gets the busy notice in the self chat, never in the watched chat",
      async () => {
        // No provider runs here, so Ichiro's two turns above still wait: the third is over his queue limit.
        const extra = text({ chat: ICHIRO_JID, text: "and the music is too loud at 0:40" });
        const before = phone.textsTo(OWNER_JID).length;
        phone.current().receive([extra]);
        await until(() => phone.textsTo(OWNER_JID).length > before, "the busy notice", 5_000);
        assert.deepEqual(phone.towardWatched(), []);
        const selfLink = agents.messaging.store.linkByKey(connectionId(agents), OWNER_JID, "dm");
        assert.ok(selfLink);
        // As if Desk finished them, so the turns below have room.
        await runCauseEffect(agents.messaging.stop(selfLink.linkId, ICHIRO));
        return { notice: phone.textsTo(OWNER_JID).at(-1)?.split("\n")[0] };
      },
    );

    await step("strangers stay ignored; the self chat and allowed contacts work as before", async () => {
      const stranger = text({ chat: STRANGER_JID, text: "hi, dinner?" });
      const friend = text({ chat: FRIEND_JID, text: "can you check the build?", pushName: "Friend" });
      const self = text({ chat: OWNER_JID, fromMe: true, text: "what did Ichiro send?" });
      const reactionsBefore = phone.reactionsTo(OWNER_JID);
      phone.current().receive([stranger, friend, self]);
      await until(() => received(agents, FRIEND_JID, friend.key.id), "the allowed contact's message");
      await until(() => received(agents, OWNER_JID, self.key.id), "the owner's message");
      await until(() => phone.reactionsTo(FRIEND_JID) === 1, "the 👀 for the allowed contact");
      await until(() => phone.reactionsTo(OWNER_JID) === reactionsBefore + 1, "the 👀 in the self chat");
      await sleep(WATCH_TIMING.debounceMs + 200);
      assert.equal(received(agents, STRANGER_JID, stranger.key.id), false, "A stranger reached the agents.");
      assert.equal(phone.textsTo(STRANGER_JID).length + phone.reactionsTo(STRANGER_JID), 0);
      return { ignored: STRANGER_JID.slice(-4) };
    });

    await step("a burst that has not gone when OpenBot stops is kept for the next start", async () => {
      const late = text({ chat: ICHIRO_JID, text: "sent right before the stop" });
      phone.current().receive([late]);
      await sleep(100);
      lateId = late.key.id;
      assert.equal(received(agents, ICHIRO_JID, lateId), false);
      return { pending: lateId };
    });
  });

  await boot(async ({ agents, messaging }) => {
    await step("the kept burst replays after the restart, and unwatching stops the reading", async () => {
      await until(() => connection(messaging)?.state === "connected", "connected again");
      await until(() => received(agents, ICHIRO_JID, lateId), "the replayed watched message");
      await runCauseEffect(messaging.removeWhatsAppSender(OWNER, ICHIRO));
      assert.deepEqual(messaging.whatsappOverview().accounts[0]?.watched, []);
      const after = text({ chat: ICHIRO_JID, text: "are you there?" });
      phone.current().receive([after]);
      await sleep(WATCH_TIMING.debounceMs + 300);
      assert.equal(received(agents, ICHIRO_JID, after.key.id), false, "An unwatched contact still reached Desk.");
      assert.deepEqual(phone.towardWatched(), []);
      return { replayed: lateId };
    });
  });

  report.passed = true;
} finally {
  media.stop(true);
  mkdirSync(OUT, { recursive: true });
  writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`);
  await rm(root, { recursive: true, force: true });
}
process.stdout.write(`WhatsApp Watch check passed. Report: ${REPORT}\n`);
