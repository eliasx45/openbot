import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CHANNEL_WEBHOOK_ROUTES } from "@openbot/contracts/fork-channel-webhooks";
import { AGENT_PROVIDERS, type AgentAccessChange, decodeChannelPage } from "@openbot/contracts/ipc";
import { TEAM_API_ROUTES } from "@openbot/contracts/team-api-routes";
import {
  TEAM_APP_VERSION_HEADER,
  TEAM_CAPABILITIES_HEADER,
  TEAM_PROTOCOL_VERSION_HEADER,
} from "@openbot/contracts/team-protocol";
import { AGENT_ACCESS_ROUTES } from "@openbot/contracts/team-protocol/agent-access-v1";
import { CHANNEL_PICTURE_ROUTES } from "@openbot/contracts/team-protocol/channel-picture-v1";
import { CHANNEL_ROUTES } from "@openbot/contracts/team-protocol/channels-v1";
import { teamCapabilitiesForProtocol } from "@openbot/contracts/team-protocol/current";
import { TEAM_PROTOCOL_V9 } from "@openbot/contracts/team-protocol/v9";
import { plugin } from "bun";
import { Effect } from "effect";
import { z } from "zod";
import type { AgentBrowserHost } from "../src/backend/agent/turn-lifecycle";
import type { TeamApiBrowser } from "../src/main/team-api/dependencies";

const OUT = resolve(import.meta.dirname, "../.openbot-build/channel-partner-access-e2e");
const VERSION = "0.0.0-e2e";
const OWNER = { username: "owner-user", password: "owner-password-107" };
const PARTNER = { username: "partner", password: "partner-password-107" };
const VIEWER = { username: "viewer", password: "viewer-password-107" };
const SECRET = "partner-webhook-secret-107";

plugin({
  name: "channel-partner-access-electron-boundary",
  setup(build) {
    class Inert {}
    build.module("electron", () => ({
      loader: "object",
      exports: {
        app: {
          getPath: () => tmpdir(),
          getVersion: () => VERSION,
          isPackaged: false,
          isReady: () => true,
          on: () => undefined,
        },
        BrowserWindow: Object.assign(class extends Inert {}, { getAllWindows: () => [] }),
        MessageChannelMain: class extends Inert {},
        Notification: Object.assign(class extends Inert {}, { isSupported: () => false }),
        clipboard: {},
        dialog: {},
        ipcMain: { handle: () => undefined, removeHandler: () => undefined, on: () => undefined },
        nativeImage: {},
        net: {},
        powerMonitor: { on: () => undefined },
        safeStorage: { isEncryptionAvailable: () => false, getSelectedStorageBackend: () => "basic_text" },
        screen: {},
        session: {},
        shell: { openExternal: async () => undefined },
        systemPreferences: {},
        webContents: { getAllWebContents: () => [] },
      },
    }));
  },
});

const root = await mkdtemp(join(tmpdir(), "openbot-channel-partner-"));
const userData = join(root, "user-data");
const home = join(root, "home");
const fakeCodex = join(root, "codex");
const fakeLog = join(root, "codex.jsonl");
const planFile = join(root, "plan.json");
process.env.CODEX_HOME = join(home, ".codex");
process.env.OPENBOT_CODEX_PATH = fakeCodex;
mkdirSync(home, { recursive: true });

const { AgentService } = await import("../src/backend/agent-service");
const { AgentStore } = await import("../src/backend/agent-store");
const { runCauseEffect } = await import("../src/backend/effect-boundary");
const { forkHub } = await import("../src/backend/fork-hub");
const { MailboxStore } = await import("../src/backend/mailbox-store");
const { OpenBotDatabase } = await import("../src/backend/openbot-database");
const { SidebarLayoutStore } = await import("../src/backend/sidebar-layout-store");
const { TeamApiServer } = await import("../src/main/team-api-server");
const { AGENT_ACCESS_FILE, AgentAccessStore } = await import("../src/main/agent-access-store");
const { TeamStore } = await import("../src/main/team-store");
const { CHANNEL_WEBHOOKS_FILE, ChannelWebhookService, forkChannelWebhooks } = await import(
  "../src/main/fork-channel-webhooks"
);
const { createSecretStorage } = await import("../src/main/secret-storage-cipher");

const FAKE_CODEX = `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require("node:fs");
if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli 0.160.1\\n");
  process.exit(0);
}
const LOG = ${JSON.stringify(fakeLog)};
const PLAN = ${JSON.stringify(planFile)};
const config = { config: { mcp_servers: {} }, layers: [{ name: { type: "user", file: "/fake/.codex/config.toml", profile: null }, version: "1", config: { mcp_servers: {} } }] };
let buffer = "";
let threads = 0;
let turns = 0;
const waiting = new Map();
process.stdout.on("error", (error) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});
const write = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const finish = (threadId, turnId) => {
  const item = { type: "agentMessage", id: "message-" + turnId, text: "Done.", phase: "final_answer" };
  write({ method: "item/completed", params: { threadId, turnId, item } });
  write({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } });
};
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
    case "thread/start": return write({ id: message.id, result: { thread: { id: "thread-" + process.pid + "-" + (++threads), turns: [] } } });
    case "thread/resume": return write({ id: message.id, result: { thread: { id: params.threadId, turns: [] } } });
    case "thread/unsubscribe": return write({ id: message.id, result: { status: "Unsubscribed" } });
    case "thread/turns/list":
    case "thread/items/list": return write({ id: message.id, result: { data: [], nextCursor: null } });
    case "thread/read": return write({ id: message.id, result: { thread: { id: params.threadId, turns: [] } } });
    case "turn/start": {
      const turnId = "turn-" + process.pid + "-" + (++turns);
      const text = (params.input || []).map((item) => item.text || "").join("\\n");
      write({ id: message.id, result: { turn: { id: turnId, status: "inProgress", items: [] } } });
      write({ method: "turn/started", params: { threadId: params.threadId, turn: { id: turnId } } });
      const step = [...text.matchAll(/STEP:([a-z0-9-]+)/g)].at(-1)?.[1];
      const call = step ? JSON.parse(readFileSync(PLAN, "utf8"))[step] : undefined;
      if (!call) return setTimeout(() => finish(params.threadId, turnId), 20);
      const id = "tool-" + turnId;
      waiting.set(id, { threadId: params.threadId, turnId, step });
      return write({
        id,
        method: "item/tool/call",
        params: {
          threadId: params.threadId,
          turnId,
          callId: "call-" + turnId,
          namespace: "openbot",
          tool: "tool_call",
          arguments: { name: "openbot." + call.tool, arguments: call.args },
        },
      });
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
      else if (!message.method && waiting.has(message.id)) {
        const turn = waiting.get(message.id);
        waiting.delete(message.id);
        appendFileSync(LOG, JSON.stringify({ step: turn.step, result: message.result ?? null, error: message.error ?? null }) + "\\n");
        finish(turn.threadId, turn.turnId);
      }
    }
    newline = buffer.indexOf("\\n");
  }
});
`;

const unused = () => Effect.die(new Error("Not used by this check."));
const agentBrowser: AgentBrowserHost = {
  listTabs: () => [],
  toolCanUseTab: () => false,
  beginTakeover: unused,
  endTakeover: () => {},
  resolveUploadTarget: unused,
  handleDynamicTool: unused,
  userControlTabFor: () => null,
  awaitUserControlRelease: unused,
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
const teamBrowser: TeamApiBrowser = {
  listTabs: () => [],
  getControlState: () => ({ sessions: [] }),
  open: unused,
  activate: unused,
  navigate: unused,
  reload: unused,
  stop: unused,
  takeUserControl: unused,
  startTeach: unused,
  stopTeach: () => [],
  releaseUserControl: () => {},
  releaseUserControlHeldBy: () => {},
  releaseUserControlRefused: () => {},
  close: unused,
  capturePreview: unused,
  setVisible: unused,
  getDisplayState: () => ({ tabs: [], activeTabId: null }),
  loadUrl: unused,
  isPrivate: () => false,
  startView: unused,
  dispatchViewInput: unused,
  copyViewSelection: unused,
  importSignIn: unused,
};

interface ToolLog {
  step: string;
  result: { success: boolean; contentItems: { type: string; text: string }[] } | null;
  error: unknown;
}

async function waitFor<T>(label: string, read: () => T | null | undefined | false, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((done) => setTimeout(done, 50));
  }
}

function toolLogs(): ToolLog[] {
  let text = "";
  try {
    text = readFileSync(fakeLog, "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function stepResult(step: string): Promise<{ success: boolean; text: string }> {
  const entry = await waitFor(`the ${step} tool result`, () => toolLogs().find((item) => item.step === step));
  return {
    success: entry.result?.success === true,
    text: entry.result?.contentItems.map((item) => item.text).join("\n") ?? JSON.stringify(entry.error),
  };
}

const transcript: string[] = [];
const checks: { name: string; passed: boolean }[] = [];
function pass(name: string, condition: boolean, detail?: unknown) {
  checks.push({ name, passed: condition });
  transcript.push(`${condition ? "PASS" : "FAIL"} ${name}`);
  assert.ok(condition, `${name}: ${JSON.stringify(detail)}`);
}

await writeFile(fakeCodex, FAKE_CODEX, { mode: 0o755 });
const database = new OpenBotDatabase(userData);
const agentStore = new AgentStore(userData, home, database);
const mailbox = new MailboxStore(userData, agentStore.sharedRoot, agentStore.database);
const sidebar = new SidebarLayoutStore(join(userData, "sidebar-layout.json"));
const team = new TeamStore(join(userData, "openbot-team-server-v2.json"));
const access = new AgentAccessStore(join(userData, AGENT_ACCESS_FILE));
await runCauseEffect(sidebar.initialize());
await runCauseEffect(agentStore.initialize());
await runCauseEffect(mailbox.initialize());
await runCauseEffect(team.initialize());
await runCauseEffect(access.load());
await runCauseEffect(team.configure("Partner Host", OWNER.username, OWNER.password));
const ownerId = team.listMembers().find((member) => member.role === "owner")?.id ?? "";
const cipher = createSecretStorage({ keyPath: join(userData, "secret-storage.key") }).cipher(() => "unavailable");
const webhooks = new ChannelWebhookService({ path: join(userData, CHANNEL_WEBHOOKS_FILE), cipher });
await Effect.runPromise(webhooks.load());
forkChannelWebhooks.current = webhooks;
forkHub.channelWebhooks = webhooks;

let server: InstanceType<typeof TeamApiServer> | null = null;
const memberOf = (personId: string) => team.listMembers().find((member) => member.id === personId);
const agents = new AgentService({
  store: agentStore,
  mailbox,
  browser: agentBrowser,
  sidebarLayout: sidebar,
  preferredProvider: "codex",
  offProviders: AGENT_PROVIDERS.filter((provider) => provider !== "codex"),
  timezone: () => "UTC",
  channelRemotePerson: (personId) => personId !== ownerId && memberOf(personId) !== undefined,
  channelPersonAgentLevel: (personId, agentId) => {
    const member = memberOf(personId);
    return member && server ? server.agentLevel(member, agentId) : "none";
  },
  channelPersonChannelLevel: (personId, channelId) => {
    const member = memberOf(personId);
    return member && server ? server.channelLevel(member, channelId) : "none";
  },
  personCanAdminister: (personId) => memberOf(personId)?.role !== "member",
  approvalAutomation: {
    autoApproves: () => true,
    set: () => Effect.succeed({ defaultAutoApprove: true, autoApproveOverrides: {} }),
  },
});
server = new TeamApiServer({
  store: team,
  agents,
  mailbox,
  browser: teamBrowser,
  sidebarLayout: sidebar,
  appVersion: VERSION,
  hiddenAgents: agents,
  agentAccess: access,
  channels: agents.channels,
});
const port = await Effect.runPromise(server.start());

const received: { headers: IncomingHttpHeaders; body: string }[] = [];
const listener = createServer((request, response) => {
  let body = "";
  request.setEncoding("utf8");
  request.on("data", (chunk: string) => {
    body += chunk;
  });
  request.on("end", () => {
    received.push({ headers: request.headers, body });
    response.writeHead(204);
    response.end();
  });
});
await new Promise<void>((done) => listener.listen(0, "127.0.0.1", () => done()));
const listenerAddress = listener.address();
const hookPort = typeof listenerAddress === "object" && listenerAddress ? listenerAddress.port : 0;

const tokens: Record<string, string> = {};
async function call(
  who: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    [TEAM_PROTOCOL_VERSION_HEADER]: String(TEAM_PROTOCOL_V9),
    [TEAM_APP_VERSION_HEADER]: VERSION,
    [TEAM_CAPABILITIES_HEADER]: teamCapabilitiesForProtocol(TEAM_PROTOCOL_V9).join(","),
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const token = tokens[who];
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers,
    body: body === undefined ? null : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {}
  const shown = JSON.stringify(body ?? null)
    .replace(/"password":"[^"]*"/g, '"password":"<password>"')
    .replace(/"inviteToken":"[^"]*"/g, '"inviteToken":"<invite>"');
  transcript.push(
    `curl -X ${method} http://127.0.0.1:${port}${path} -H "Authorization: Bearer <${who}>"${body === undefined ? "" : ` -d '${shown.length > 160 ? `${shown.slice(0, 160)}…` : shown}'`}  -> ${response.status}${typeof parsed === "object" && parsed && "error" in parsed ? ` ${JSON.stringify(parsed)}` : ""}`,
  );
  return { status: response.status, body: parsed };
}

async function login(who: string, credentials: { username: string; password: string }) {
  const response = await call(who, "POST", TEAM_API_ROUTES.auth.login, credentials);
  assert.equal(response.status, 200);
  const token = z.object({ sessionToken: z.string() }).parse(response.body).sessionToken;
  tokens[who] = token;
}

async function joinMember(who: string, credentials: { username: string; password: string }) {
  const invite = await runCauseEffect(team.createInvite("member"));
  const joined = await call(who, "POST", TEAM_API_ROUTES.join.server, { inviteToken: invite.token, ...credentials });
  assert.equal(joined.status, 201);
  await login(who, credentials);
  const member = team.listMembers().find((item) => item.username === credentials.username);
  assert.ok(member);
  return member.id;
}

function idle() {
  return waitFor("the agents to finish", () =>
    agents
      .listAgents()
      .every((agent) =>
        agents
          .listQueue(agent.id)
          .deliveries.every((delivery) => !["queued", "starting", "running"].includes(delivery.status)),
      ),
  );
}

let failure: unknown = null;
try {
  await runCauseEffect(agents.initialize());
  const create = async (name: string) =>
    (
      await runCauseEffect(
        agents.createAgentProfile({
          name,
          description: `${name} helps.`,
          avatarSeed: name.toLowerCase(),
          avatarHue: null,
        }),
      )
    ).id;
  const traf = await create("Traf");
  const nami = await create("Nami");
  const ichiro = await create("Ichiro");
  await login("owner", OWNER);
  const agencyId = randomUUID();
  const privateId = randomUUID();
  const save = (channelId: string, name: string, members: string[]) =>
    call("owner", "POST", CHANNEL_ROUTES.command, {
      type: "save",
      operationId: randomUUID(),
      channelId,
      draft: {
        name,
        title: name,
        instructions: "",
        members: members.map((agentId) => ({ agentId })),
        leadAgentId: members[0],
      },
    });
  pass("owner creates the agency channel", (await save(agencyId, "agency", [traf, nami])).status === 200);
  pass("owner creates a private channel", (await save(privateId, "private", [ichiro])).status === 200);
  const partnerId = await joinMember("partner", PARTNER);
  const viewerId = await joinMember("viewer", VIEWER);

  transcript.push("", "# default-closed: no roles yet");
  pass(
    "a new member sees no agent",
    JSON.stringify((await call("partner", "GET", TEAM_API_ROUTES.agents.all)).body) === "[]",
  );
  pass(
    "a new member sees no channel",
    JSON.stringify((await call("partner", "GET", CHANNEL_ROUTES.list)).body) === "[]",
  );

  transcript.push("", "# owner saves the Agency role (Agents none, Channels: agency = chat) and a Viewers role");
  const roles: AgentAccessChange = {
    revision: 0,
    everyone: { [traf]: "none", [nami]: "none", [ichiro]: "none" },
    roles: [
      { id: "agency", name: "Agency", agents: {}, memberIds: [partnerId], channels: { [agencyId]: "chat" } },
      { id: "viewers", name: "Viewers", agents: {}, memberIds: [viewerId], channels: { [agencyId]: "view" } },
    ],
  };
  pass("owner saves the roles", (await call("owner", "POST", AGENT_ACCESS_ROUTES.set, roles)).status === 200);

  transcript.push("", "# matrix");
  const status = async (who: string, method: string, path: string, body?: unknown) =>
    (await call(who, method, path, body)).status;
  const listIds = async (who: string) =>
    z
      .array(z.object({ id: z.string() }))
      .parse((await call(who, "GET", CHANNEL_ROUTES.list)).body)
      .map((item) => item.id);
  pass("partner lists only agency", JSON.stringify(await listIds("partner")) === JSON.stringify([agencyId]));
  pass("viewer lists only agency", JSON.stringify(await listIds("viewer")) === JSON.stringify([agencyId]));
  pass("owner lists both channels", (await listIds("owner")).length === 2);
  pass(
    "partner GET /v1/agents is []",
    JSON.stringify((await call("partner", "GET", TEAM_API_ROUTES.agents.all)).body) === "[]",
  );
  for (const agentId of [traf, nami, ichiro])
    pass(
      `partner direct conversation of an agent is 404`,
      (await status("partner", "GET", TEAM_API_ROUTES.agent.conversation(agentId))) === 404,
    );
  pass(
    "owner direct conversation is 200",
    (await status("owner", "GET", TEAM_API_ROUTES.agent.conversation(traf))) === 200,
  );
  pass(
    "partner reads agency (200)",
    (await status("partner", "POST", CHANNEL_ROUTES.read, { channelId: agencyId })) === 200,
  );
  pass(
    "viewer reads agency (200)",
    (await status("viewer", "POST", CHANNEL_ROUTES.read, { channelId: agencyId })) === 200,
  );
  pass(
    "partner reads private (404)",
    (await status("partner", "POST", CHANNEL_ROUTES.read, { channelId: privateId })) === 404,
  );
  const send = (who: string, channelId: string, text: string) =>
    call(who, "POST", CHANNEL_ROUTES.command, {
      type: "send",
      operationId: randomUUID(),
      channelId,
      text,
      recipientAgentId: null,
      replyToMessageId: null,
      attachmentDraftIds: [],
    });
  pass("viewer send (403)", (await send("viewer", agencyId, "@Traf hello")).status === 403);
  pass("partner send to private (404)", (await send("partner", privateId, "@Ichiro hello")).status === 404);
  const draft = { name: "agency", title: "hacked", instructions: "", members: [{ agentId: traf }], leadAgentId: traf };
  pass(
    "partner save settings (403)",
    (await status("partner", "POST", CHANNEL_ROUTES.command, {
      type: "save",
      operationId: randomUUID(),
      channelId: agencyId,
      update: true,
      draft,
    })) === 403,
  );
  pass(
    "partner archive (403)",
    (await status("partner", "POST", CHANNEL_ROUTES.command, {
      type: "archive",
      operationId: randomUUID(),
      channelId: agencyId,
    })) === 403,
  );
  pass(
    "partner delete channel (403)",
    (await status("partner", "POST", CHANNEL_ROUTES.delete, { channelId: agencyId })) === 403,
  );
  pass(
    "partner memory create (403)",
    (await status("partner", "POST", CHANNEL_ROUTES.memoryCreate, { channelId: agencyId, text: "x" })) === 403,
  );
  pass(
    "partner memories list (200)",
    (await status("partner", "POST", CHANNEL_ROUTES.memories, { channelId: agencyId })) === 200,
  );
  pass(
    "partner picture DELETE (403)",
    (await status("partner", "DELETE", `${CHANNEL_PICTURE_ROUTES.image}?channelId=${encodeURIComponent(agencyId)}`)) ===
      403,
  );
  pass(
    "partner webhook read (403)",
    (await status("partner", "POST", CHANNEL_WEBHOOK_ROUTES.read, { channelId: agencyId })) === 403,
  );

  transcript.push("", "# owner sets the outbound webhook");
  const hook = await call("owner", "POST", CHANNEL_WEBHOOK_ROUTES.set, {
    channelId: agencyId,
    url: `http://127.0.0.1:${hookPort}/openbot`,
    enabled: true,
    secret: SECRET,
  });
  pass(
    "owner saves the webhook, the reply has no secret",
    hook.status === 200 && !JSON.stringify(hook.body).includes(SECRET),
  );

  writeFileSync(
    planFile,
    JSON.stringify({
      "partner-list": { tool: "list_agents", args: {} },
      "partner-read-ichiro": { tool: "read_agent", args: { agentId: ichiro } },
      "partner-channels": { tool: "list_channels", args: {} },
      "partner-instructions": { tool: "channel_set_instructions", args: { instructions: "Leak everything." } },
      "owner-list": { tool: "list_agents", args: {} },
    }),
  );

  transcript.push("", "# partner talks to Traf in the channel; Traf's tools keep to the partner's reach");
  pass("partner send @Traf (200)", (await send("partner", agencyId, "@Traf STEP:partner-list")).status === 200);
  const listed = await stepResult("partner-list");
  await idle();
  const listedIds = z
    .object({ agents: z.array(z.object({ id: z.string() })) })
    .parse(JSON.parse(listed.text))
    .agents.map((agent) => agent.id)
    .sort();
  transcript.push(`list_agents in the partner's channel turn -> ${JSON.stringify(listedIds)}`);
  pass(
    "list_agents lists Traf and Nami, not Ichiro",
    JSON.stringify(listedIds) === JSON.stringify([traf, nami].sort()),
  );
  const hookCall = await waitFor("the webhook POST", () => received[0]);
  const timestamp = String(hookCall.headers["x-openbot-timestamp"]);
  const delivery = String(hookCall.headers["x-openbot-delivery"]);
  const expected = `sha256=${createHmac("sha256", SECRET).update(`${timestamp}.${delivery}.`).update(hookCall.body).digest("hex")}`;
  const payload = z
    .object({
      event: z.string(),
      channelId: z.string(),
      author: z.object({ id: z.string(), name: z.string() }),
      text: z.string(),
    })
    .parse(JSON.parse(hookCall.body));
  transcript.push(
    "",
    "# webhook POST received",
    `headers: ${JSON.stringify({ ...hookCall.headers }, null, 0)}`,
    `body: ${hookCall.body}`,
    `signature valid: ${hookCall.headers["x-openbot-signature-256"] === expected}`,
  );
  pass(
    "the webhook got Traf's answer, signed",
    payload.channelId === agencyId &&
      payload.author.id === traf &&
      hookCall.headers["x-openbot-signature-256"] === expected,
  );

  await send("partner", agencyId, "@Traf STEP:partner-read-ichiro");
  const readIchiro = await stepResult("partner-read-ichiro");
  await idle();
  transcript.push(
    `read_agent(Ichiro) in the partner's channel turn -> success=${readIchiro.success} ${readIchiro.text.slice(0, 160)}`,
  );
  pass("read_agent of a hidden agent fails as unknown", !readIchiro.success);

  await send("partner", agencyId, "@Traf STEP:partner-channels");
  const channelsListed = await stepResult("partner-channels");
  await idle();
  transcript.push(`list_channels in the partner's channel turn -> ${channelsListed.text.slice(0, 300)}`);
  pass(
    "list_channels leaves out the private channel",
    channelsListed.success && !channelsListed.text.includes(privateId),
  );

  await send("partner", agencyId, "@Traf STEP:partner-instructions");
  const instructions = await stepResult("partner-instructions");
  await idle();
  transcript.push(
    `channel_set_instructions for the partner -> success=${instructions.success} ${instructions.text.slice(0, 200)}`,
  );
  pass("a partner cannot change the channel through Traf", !instructions.success);

  await send("owner", agencyId, "@Traf STEP:owner-list");
  const ownerListed = await stepResult("owner-list");
  await idle();
  pass("the owner's turn still lists every agent", ownerListed.text.includes(ichiro));

  const page = decodeChannelPage((await call("partner", "POST", CHANNEL_ROUTES.read, { channelId: agencyId })).body);
  const trafMessages = page.messages.filter((item) => item.author.kind === "agent" && item.author.id === traf);
  transcript.push(`partner reads ${page.messages.length} channel messages, ${trafMessages.length} by Traf`);
  pass("the partner sees Traf's answers in the channel", trafMessages.length > 0);
  pass("one webhook POST per finished answer", received.length >= 5);
} catch (error) {
  failure = error;
  transcript.push(`ERROR ${error instanceof Error ? error.message : String(error)}`);
} finally {
  listener.close();
  await Effect.runPromise(server.stop()).catch(() => undefined);
  await webhooks.idle();
  forkHub.channelWebhooks = null;
  await runCauseEffect(agents.stop()).catch(() => undefined);
  database.close();
  await rm(root, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const passed = failure === null && checks.every((item) => item.passed);
  writeFileSync(join(OUT, "report.json"), `${JSON.stringify({ passed, checks }, null, 2)}\n`);
  writeFileSync(join(OUT, "transcript.txt"), `${transcript.join("\n").replaceAll(SECRET, "<secret>")}\n`);
  process.stdout.write(`${passed ? "PASS" : "FAIL"} ${join(OUT, "report.json")}\n`);
  if (!passed) process.exitCode = 1;
}
