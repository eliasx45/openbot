// @vitest-environment node
// Fork (docs/fork/FEATURES.md #107): channel-only partner access through the real Team API server.

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHANNEL_WEBHOOK_ROUTES } from "@openbot/contracts/fork-channel-webhooks";
import {
  type AgentAccessChange,
  type ChannelMessage,
  decodeAgentAccessSnapshot,
  decodeChannelPage,
  decodeChannelSummaries,
} from "@openbot/contracts/ipc";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { TEAM_API_ROUTES } from "@openbot/contracts/team-api-routes";
import {
  TEAM_APP_VERSION_HEADER,
  TEAM_CAPABILITIES_HEADER,
  TEAM_PROTOCOL_VERSION_HEADER,
} from "@openbot/contracts/team-protocol";
import { AGENT_ACCESS_CODECS, AGENT_ACCESS_ROUTES } from "@openbot/contracts/team-protocol/agent-access-v1";
import { CHANNEL_PICTURE_ROUTES } from "@openbot/contracts/team-protocol/channel-picture-v1";
import { CHANNEL_ROUTES } from "@openbot/contracts/team-protocol/channels-v1";
import { teamCapabilitiesForProtocol } from "@openbot/contracts/team-protocol/current";
import { STORAGE_CHANNEL_ROUTES } from "@openbot/contracts/team-protocol/storage-channel-v1";
import { TEAM_PROTOCOL_V9 } from "@openbot/contracts/team-protocol/v9";
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@openbot/contracts/input-limits", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openbot/contracts/input-limits")>()),
  DEFAULT_TEAM_MEMBER_LIMIT: 10,
}));

vi.mock("electron", () => {
  class Inert {}
  return {
    app: { getPath: () => tmpdir(), getVersion: () => "0.0.0-test", isPackaged: false, on: () => undefined },
    BrowserWindow: Object.assign(class extends Inert {}, { getAllWindows: () => [] }),
    MessageChannelMain: class extends Inert {},
    Notification: Object.assign(class extends Inert {}, { isSupported: () => false }),
    clipboard: {},
    dialog: {},
    ipcMain: { handle: () => undefined, removeHandler: () => undefined, on: () => undefined },
    nativeImage: {},
    net: {},
    powerMonitor: { on: () => undefined },
    safeStorage: { isEncryptionAvailable: () => false },
    screen: {},
    session: {},
    shell: { openExternal: async () => undefined },
    systemPreferences: {},
    webContents: { getAllWebContents: () => [] },
  };
});

const VERSION = "0.0.0-test";
const OWNER = { username: "owner-user", password: "owner-password-123" };
const CHAT = { username: "partner-chat", password: "partner-password-123" };
const VIEW = { username: "partner-view", password: "partner-password-456" };
const NONE = { username: "partner-none", password: "partner-password-789" };

type Host = Awaited<ReturnType<typeof startHost>>;
let host: Host;
let root = "";
const tokens: Record<"owner" | "chat" | "view" | "none", string> = { owner: "", chat: "", view: "", none: "" };
const ids = { channel: "", other: "", inside: "", outside: "", insideFile: "", outsideFile: "", channelFile: "" };

async function startHost() {
  const { AgentService } = await import("../backend/agent-service");
  const { AgentStore } = await import("../backend/agent-store");
  const { runCauseEffect } = await import("../backend/effect-boundary");
  const { MailboxStore } = await import("../backend/mailbox-store");
  const { OpenBotDatabase } = await import("../backend/openbot-database");
  const { SidebarLayoutStore } = await import("../backend/sidebar-layout-store");
  const { StorageUsageScanner, StorageUsageService } = await import("../backend/storage-usage");
  const { TeamApiServer } = await import("./team-api-server");
  const { AGENT_ACCESS_FILE, AgentAccessStore } = await import("./agent-access-store");
  const { TeamStore } = await import("./team-store");
  const { ChannelWebhookService, forkChannelWebhooks } = await import("./fork-channel-webhooks");
  const userData = join(root, "user-data");
  const database = new OpenBotDatabase(userData);
  const agentStore = new AgentStore(userData, join(root, "home"), database);
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
  const unused = () => Effect.die(new Error("Not used by this test."));
  const agents = new AgentService({
    store: agentStore,
    mailbox,
    sidebarLayout: sidebar,
    browser: {
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
    },
  });
  const storageSources = {
    roots: {
      database: join(userData, "openbot.db"),
      downloads: join(root, "downloads"),
      caches: [join(userData, "remote-attachments")],
      logs: [join(userData, "logs")],
      runtimes: join(root, "runtimes"),
      data: userData,
    },
    database: () => database.connection,
    mailbox,
    agents: () => agents.listAgents(),
  };
  const channelSources = {
    ...storageSources,
    channelFiles: (channelId: string) =>
      agents.channels.store.exists(channelId)
        ? agents.channels.store
            .messages(channelId)
            .flatMap((entry) =>
              (entry.message.attachments ?? []).map((item) => ({ attachmentId: item.id, messageId: entry.id })),
            )
        : null,
  };
  const storage = new StorageUsageService(new StorageUsageScanner(channelSources), channelSources);
  const webhooks = new ChannelWebhookService({
    path: join(userData, "openbot-channel-webhooks-v1.json"),
    cipher: { encrypt: (value) => Buffer.from(value), decrypt: (value) => value.toString() },
  });
  forkChannelWebhooks.current = webhooks;
  const unusedBrowser = () => Effect.die(new Error("Not used by this test."));
  const server = new TeamApiServer({
    store: team,
    agents,
    mailbox,
    browser: {
      listTabs: () => [],
      getControlState: () => ({ sessions: [] }),
      open: unusedBrowser,
      activate: unusedBrowser,
      navigate: unusedBrowser,
      reload: unusedBrowser,
      stop: unusedBrowser,
      takeUserControl: unusedBrowser,
      startTeach: unusedBrowser,
      stopTeach: () => [],
      releaseUserControl: () => {},
      releaseUserControlHeldBy: () => {},
      releaseUserControlRefused: () => {},
      close: unusedBrowser,
      capturePreview: unusedBrowser,
      setVisible: unusedBrowser,
      getDisplayState: () => ({ tabs: [], activeTabId: null }),
      loadUrl: unusedBrowser,
      isPrivate: () => false,
      startView: unusedBrowser,
      dispatchViewInput: unusedBrowser,
      copyViewSelection: unusedBrowser,
      importSignIn: unusedBrowser,
    },
    sidebarLayout: sidebar,
    appVersion: VERSION,
    hiddenAgents: agents,
    agentAccess: access,
    channels: agents.channels,
    storage,
  });
  const port = await Effect.runPromise(server.start());
  return {
    database,
    agents,
    mailbox,
    team,
    access,
    server,
    storage,
    port,
    runCauseEffect,
    webhooks,
    sharedRoot: agentStore.sharedRoot,
  };
}

async function call(
  method: string,
  path: string,
  token: string | null,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    [TEAM_PROTOCOL_VERSION_HEADER]: String(TEAM_PROTOCOL_V9),
    [TEAM_APP_VERSION_HEADER]: VERSION,
    [TEAM_CAPABILITIES_HEADER]: teamCapabilitiesForProtocol(TEAM_PROTOCOL_V9).join(","),
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`http://127.0.0.1:${host.port}${path}`, {
    method,
    headers,
    body: body === undefined ? null : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed };
}

async function login(credentials: { username: string; password: string }): Promise<string> {
  const response = await call("POST", TEAM_API_ROUTES.auth.login, null, credentials);
  expect(response.status).toBe(200);
  const token = isDynamicRecord(response.body) ? response.body.sessionToken : undefined;
  if (typeof token !== "string") throw new Error("No session token.");
  return token;
}

async function joinMember(credentials: { username: string; password: string }): Promise<string> {
  const invite = await host.runCauseEffect(host.team.createInvite("member"));
  const joined = await call("POST", TEAM_API_ROUTES.join.server, null, { inviteToken: invite.token, ...credentials });
  expect(joined.status, JSON.stringify(joined.body)).toBe(201);
  const member = host.team.listMembers().find((item) => item.username === credentials.username);
  if (!member) throw new Error("The member did not join.");
  return member.id;
}

async function attachment(agentId: string, name: string, channelId?: string): Promise<string> {
  const [draft] = await host.runCauseEffect(
    host.mailbox.prepareImportedAttachments([], [{ name, mimeType: "text/plain", bytes: Buffer.from(name) }]),
  );
  if (!draft) throw new Error("No draft.");
  const receipt = await host.runCauseEffect(
    host.mailbox.enqueue({
      sender: { kind: "user" },
      recipientAgentIds: [agentId],
      text: name,
      draftIds: [draft.id],
      ...(channelId ? { channelId } : {}),
    }),
  );
  for (const delivery of receipt.deliveries) {
    await host.runCauseEffect(host.mailbox.markStarting(delivery.id));
    await host.runCauseEffect(host.mailbox.markRunning(delivery.id, `turn-${delivery.id}`));
    await host.runCauseEffect(host.mailbox.markTerminal(delivery.id, "completed"));
  }
  const stored = host.mailbox.listStoredFiles().find((file) => file.attachment.name === name);
  if (!stored) throw new Error("The file was not stored.");
  return stored.attachment.id;
}

function agentMessage(channelId: string, agentId: string, name: string, text: string): ChannelMessage {
  return {
    id: randomUUID(),
    channelId,
    sequence: 0,
    author: { kind: "agent", id: agentId, name },
    taskId: null,
    superseded: false,
    message: {
      id: randomUUID(),
      author: "assistant",
      text,
      createdAt: new Date().toISOString(),
      status: "completed",
    },
  };
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "openbot-fork-107-"));
  host = await startHost();
  const create = async (name: string) =>
    (
      await host.runCauseEffect(
        host.agents.createAgentProfile({ name, description: name, avatarSeed: name.toLowerCase(), avatarHue: null }),
      )
    ).id;
  ids.inside = await create("Traf");
  ids.outside = await create("Ichiro");
  ids.channel = randomUUID();
  ids.other = randomUUID();
  const store = host.agents.channels.store;
  const agency = store.create(ids.channel, {
    name: "agency",
    title: "Agency",
    instructions: "",
    members: [{ agentId: ids.inside }],
    leadAgentId: ids.inside,
  });
  store.update(agency, { messages: [agentMessage(ids.channel, ids.inside, "Traf", "Hello partner.")] });
  store.update(
    store.create(ids.other, {
      name: "private",
      title: "Private",
      instructions: "",
      members: [{ agentId: ids.outside }],
      leadAgentId: ids.outside,
    }),
  );
  ids.insideFile = await attachment(ids.inside, "traf-direct.txt");
  ids.outsideFile = await attachment(ids.outside, "ichiro-direct.txt");
  ids.channelFile = await attachment(ids.inside, "agency-channel.txt", ids.channel);
  tokens.owner = await login(OWNER);
  const chatId = await joinMember(CHAT);
  const viewId = await joinMember(VIEW);
  await joinMember(NONE);
  tokens.chat = await login(CHAT);
  tokens.view = await login(VIEW);
  tokens.none = await login(NONE);
  const change: AgentAccessChange = {
    revision: 0,
    everyone: {},
    roles: [
      { id: "agency", name: "Agency", agents: {}, memberIds: [chatId], channels: { [ids.channel]: "chat" } },
      { id: "viewers", name: "Viewers", agents: {}, memberIds: [viewId], channels: { [ids.channel]: "view" } },
    ],
  };
  AGENT_ACCESS_CODECS.get(AGENT_ACCESS_ROUTES.set)?.request(change);
  const saved = await call("POST", AGENT_ACCESS_ROUTES.set, tokens.owner, change);
  expect(saved.status).toBe(200);
}, 60_000);

afterAll(async () => {
  await Effect.runPromise(host.server.stop()).catch(() => undefined);
  await Effect.runPromise(host.storage.dispose()).catch(() => undefined);
  await host.runCauseEffect(host.agents.stop()).catch(() => undefined);
  host.database.close();
  await rm(root, { recursive: true, force: true });
});

type Who = keyof typeof tokens;
const WHO: Who[] = ["owner", "chat", "view", "none"];

async function statuses(request: (who: Who) => Promise<{ status: number }>): Promise<Record<Who, number>> {
  const result = { owner: 0, chat: 0, view: 0, none: 0 };
  for (const who of WHO) result[who] = (await request(who)).status;
  return result;
}

describe("fork #107 channel-only partner access", () => {
  it("closes unlisted agents and channels to members, and saves channel levels", async () => {
    const read = await call("POST", AGENT_ACCESS_ROUTES.read, tokens.chat, {});
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ mine: {}, mineChannels: { [ids.channel]: "chat" } });
    const none = await call("POST", AGENT_ACCESS_ROUTES.read, tokens.none, {});
    expect(none.body).toMatchObject({ mine: {}, mineChannels: {} });
    const owner = await call("POST", AGENT_ACCESS_ROUTES.read, tokens.owner, {});
    expect(owner.body).toMatchObject({
      everyoneChannels: {},
      roles: [{ id: "agency", channels: { [ids.channel]: "chat" } }, { id: "viewers" }],
    });
    for (const who of ["chat", "view", "none"] as const) {
      const agents = await call("GET", TEAM_API_ROUTES.agents.all, tokens[who]);
      expect(agents.status).toBe(200);
      expect(agents.body).toEqual([]);
    }
  });

  it("keeps channel levels when an older client saves agent levels only", async () => {
    const owner = await call("POST", AGENT_ACCESS_ROUTES.read, tokens.owner, {});
    const snapshot = decodeAgentAccessSnapshot(owner.body);
    const older = {
      revision: snapshot.revision,
      everyone: {},
      roles: (snapshot.roles ?? []).map((role) => ({
        id: role.id,
        name: role.name,
        agents: {},
        memberIds: role.memberIds,
      })),
    };
    expect((await call("POST", AGENT_ACCESS_ROUTES.set, tokens.owner, older)).status).toBe(200);
    const after = await call("POST", AGENT_ACCESS_ROUTES.read, tokens.chat, {});
    expect(after.body).toMatchObject({ mineChannels: { [ids.channel]: "chat" } });
  });

  it("lists and reads the channel by channel level, with the agents' messages", async () => {
    const lists = await Promise.all(
      WHO.map(async (who) => {
        const listed = await call("GET", CHANNEL_ROUTES.list, tokens[who]);
        return decodeChannelSummaries(listed.body)
          .map((channel) => channel.id)
          .sort();
      }),
    );
    expect(lists[0]).toEqual([ids.channel, ids.other].sort());
    expect(lists[1]).toEqual([ids.channel]);
    expect(lists[2]).toEqual([ids.channel]);
    expect(lists[3]).toEqual([]);
    expect(await statuses((who) => call("POST", CHANNEL_ROUTES.read, tokens[who], { channelId: ids.channel }))).toEqual(
      { owner: 200, chat: 200, view: 200, none: 404 },
    );
    const read = await call("POST", CHANNEL_ROUTES.read, tokens.chat, { channelId: ids.channel });
    const page = decodeChannelPage(read.body);
    expect(page.messages.map((item) => [item.author.id, item.message.text])).toContainEqual([
      ids.inside,
      "Hello partner.",
    ]);
    expect(page.channel.members).toEqual([{ agentId: ids.inside }]);
    expect((await call("POST", CHANNEL_ROUTES.read, tokens.chat, { channelId: ids.other })).status).toBe(404);
  });

  it("sends with chat, refuses writes with view and hides the channel from none", async () => {
    const send = (who: Who) =>
      call("POST", CHANNEL_ROUTES.command, tokens[who], {
        type: "read",
        operationId: randomUUID(),
        channelId: ids.channel,
        throughSequence: 1,
      });
    expect(await statuses(send)).toEqual({ owner: 200, chat: 200, view: 200, none: 404 });
    const cancel = (who: Who) =>
      call("POST", CHANNEL_ROUTES.command, tokens[who], {
        type: "cancel",
        operationId: randomUUID(),
        channelId: ids.channel,
        taskId: randomUUID(),
        recipientAgentId: null,
      });
    const refused = await statuses(cancel);
    expect(refused.view).toBe(403);
    expect(refused.none).toBe(404);
    expect(refused.chat).not.toBe(403);
    expect(refused.chat).not.toBe(404);
  });

  it("locks channel settings to owners and admins", async () => {
    const save = (who: Who) =>
      call("POST", CHANNEL_ROUTES.command, tokens[who], {
        type: "save",
        operationId: randomUUID(),
        channelId: ids.channel,
        update: true,
        draft: {
          name: "agency",
          title: `Agency ${who}`,
          instructions: "",
          members: [{ agentId: ids.inside }],
          leadAgentId: ids.inside,
        },
      });
    expect(await statuses(save)).toEqual({ owner: 200, chat: 403, view: 403, none: 404 });
    const archive = (who: Who) =>
      call("POST", CHANNEL_ROUTES.command, tokens[who], {
        type: "archive",
        operationId: randomUUID(),
        channelId: ids.channel,
      });
    expect((await archive("chat")).status).toBe(403);
    expect((await archive("none")).status).toBe(404);
    expect(
      await statuses((who) => call("POST", CHANNEL_ROUTES.memories, tokens[who], { channelId: ids.channel })),
    ).toEqual({ owner: 200, chat: 200, view: 200, none: 404 });
    const remember = (who: Who) =>
      call("POST", CHANNEL_ROUTES.memoryCreate, tokens[who], { channelId: ids.channel, text: `note ${who}` });
    const memories = await statuses(remember);
    expect(memories.chat).toBe(403);
    expect(memories.view).toBe(403);
    expect(memories.none).toBe(404);
    expect(memories.owner).toBeLessThan(300);
    const clear = (who: Who) => call("POST", CHANNEL_ROUTES.memoryClear, tokens[who], { channelId: ids.channel });
    expect((await clear("chat")).status).toBe(403);
    const routines = (who: Who) => call("POST", CHANNEL_ROUTES.routines, tokens[who], { channelId: ids.channel });
    expect(await statuses(routines)).toEqual({ owner: 200, chat: 200, view: 200, none: 404 });
    const deleteRoutine = (who: Who) =>
      call("POST", CHANNEL_ROUTES.routineDelete, tokens[who], { channelId: ids.channel, routineId: randomUUID() });
    expect((await deleteRoutine("chat")).status).toBe(403);
    const picture = (who: Who) =>
      call("DELETE", `${CHANNEL_PICTURE_ROUTES.image}?channelId=${encodeURIComponent(ids.channel)}`, tokens[who]);
    expect(await statuses(picture)).toEqual({ owner: 200, chat: 403, view: 403, none: 404 });
    const remove = (who: Who) => call("POST", CHANNEL_ROUTES.delete, tokens[who], { channelId: ids.channel });
    expect((await remove("chat")).status).toBe(403);
  });

  it("shows the channel's files by channel level", async () => {
    expect(
      await statuses((who) => call("POST", STORAGE_CHANNEL_ROUTES.files, tokens[who], { channelId: ids.channel })),
    ).toEqual({ owner: 200, chat: 200, view: 200, none: 404 });
  });

  it("keeps the direct agent routes closed", async () => {
    for (const agentId of [ids.inside, ids.outside]) {
      expect(
        await statuses((who) => call("GET", TEAM_API_ROUTES.agent.conversation(agentId), tokens[who])),
      ).toMatchObject({ chat: 404, view: 404, none: 404 });
      expect((await call("GET", TEAM_API_ROUTES.agent.conversation(agentId), tokens.owner)).status).toBe(200);
    }
  });

  it("scopes attachment downloads to agents and channels the member can reach", async () => {
    const get = (id: string) => (who: Who) => call("GET", TEAM_API_ROUTES.attachment(id), tokens[who]);
    expect(await statuses(get(ids.channelFile))).toEqual({ owner: 200, chat: 200, view: 200, none: 404 });
    expect(await statuses(get(ids.insideFile))).toEqual({ owner: 200, chat: 404, view: 404, none: 404 });
    expect(await statuses(get(ids.outsideFile))).toEqual({ owner: 200, chat: 404, view: 404, none: 404 });
  });

  it("keeps the outbound webhook settings to owners and admins, without the secret", async () => {
    const set = await call("POST", CHANNEL_WEBHOOK_ROUTES.set, tokens.owner, {
      channelId: ids.channel,
      url: "https://hooks.example.com/openbot",
      enabled: true,
      secret: "s3cret-value",
    });
    expect(set.status).toBe(200);
    expect(set.body).toEqual({
      channelId: ids.channel,
      url: "https://hooks.example.com/openbot",
      enabled: true,
      hasSecret: true,
    });
    expect(JSON.stringify(set.body)).not.toContain("s3cret-value");
    expect(
      await statuses((who) => call("POST", CHANNEL_WEBHOOK_ROUTES.read, tokens[who], { channelId: ids.channel })),
    ).toEqual({ owner: 200, chat: 403, view: 403, none: 404 });
    const bad = await call("POST", CHANNEL_WEBHOOK_ROUTES.set, tokens.owner, {
      channelId: ids.channel,
      url: "http://169.254.169.254/latest/meta-data",
      enabled: true,
    });
    expect(bad.status).toBe(400);
    const mapped = await call("POST", CHANNEL_WEBHOOK_ROUTES.set, tokens.owner, {
      channelId: ids.channel,
      url: "https://[::ffff:169.254.169.254]/latest/meta-data",
      enabled: true,
    });
    expect(mapped.status).toBe(400);
  });

  it("keeps hidden agents out of the members' read states", async () => {
    const reads = async (who: Who) => {
      const response = await call("GET", TEAM_API_ROUTES.agents.conversationReads, tokens[who]);
      expect(response.status).toBe(200);
      return Object.keys(isDynamicRecord(response.body) ? response.body : {}).sort();
    };
    expect(await reads("owner")).toEqual([ids.inside, ids.outside].sort());
    for (const who of ["chat", "view", "none"] as const) expect(await reads(who)).toEqual([]);
  });

  it("opens a shared file for a member without agents only when a message of their channel names it", async () => {
    await mkdir(join(host.sharedRoot, "agency"), { recursive: true });
    await writeFile(join(host.sharedRoot, "agency", "cut.txt"), "cut");
    await writeFile(join(host.sharedRoot, "agency", "other.txt"), "other");
    const store = host.agents.channels.store;
    store.update(store.get(ids.channel), {
      messages: [agentMessage(ids.channel, ids.inside, "Traf", "The cut is at ~/OpenBot/Shared/agency/cut.txt.")],
    });
    const get = (path: string) => (who: Who) =>
      call("GET", `${TEAM_API_ROUTES.sharedFiles}?path=${encodeURIComponent(path)}`, tokens[who]);
    expect(await statuses(get("agency/cut.txt"))).toEqual({ owner: 200, chat: 200, view: 200, none: 404 });
    expect(await statuses(get("~/OpenBot/Shared/agency/cut.txt"))).toEqual({
      owner: 200,
      chat: 200,
      view: 200,
      none: 404,
    });
    expect(await statuses(get("agency/other.txt"))).toEqual({ owner: 200, chat: 404, view: 404, none: 404 });
    expect(await statuses(get("agency/../agency/other.txt"))).toMatchObject({ chat: 404, view: 404, none: 404 });
  });
});
