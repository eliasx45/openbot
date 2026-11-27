// Fork (docs/fork/FEATURES.md #134, "Team board"): a teammate's reply with openbot.send_message
// `status` and `next` reaches the lead with "Status: …" / "Next: …" first, a reply without them shows as
// "replied", the fields are refused outside a reply, and openbot.team_board gives the lead its team as the
// board in the app shows it. Runs the real agent service with a fake Codex that calls OpenBot tools from a
// plan (as scripts/agent-message-access-e2e.ts). `bun scripts/fork-team-board-e2e.ts`; writes
// .openbot-build/fork-team-board-e2e/report.json.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AGENT_PROVIDERS } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import type { AgentBrowserHost } from "../src/backend/agent/turn-lifecycle";

const OUT = resolve(import.meta.dirname, "../.openbot-build/fork-team-board-e2e");
const root = await mkdtemp(join(tmpdir(), "openbot-team-board-"));
const userData = join(root, "user-data");
const home = join(root, "home");
const fakeCodex = join(root, "codex");
const fakeLog = join(root, "codex.jsonl");
const planFile = join(root, "plan.json");

process.env.HOME = home;
process.env.CODEX_HOME = join(home, ".codex");
process.env.OPENBOT_CODEX_PATH = fakeCodex;
process.env.OPENBOT_FORK_FOLLOW_THROUGH = "0";
mkdirSync(home, { recursive: true });

const { AgentService } = await import("../src/backend/agent-service");
const { AgentStore } = await import("../src/backend/agent-store");
const { runCauseEffect } = await import("../src/backend/effect-boundary");
const { MailboxStore } = await import("../src/backend/mailbox-store");
const { OpenBotDatabase } = await import("../src/backend/openbot-database");

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

interface ToolLog {
  step: string;
  result: { success: boolean; contentItems: { type: string; text: string }[] } | null;
  error: unknown;
}

const unused = () => Effect.die(new Error("Not used by this check."));
const browser: AgentBrowserHost = {
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

async function waitFor<T>(label: string, read: () => T | null | undefined | false, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((done) => setTimeout(done, 25));
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

const report: {
  calls: { step: string; success: boolean; text: string }[];
  checks: { name: string; passed: boolean }[];
  passed: boolean;
  error?: string;
} = { calls: [], checks: [], passed: false };

function pass(name: string, condition: boolean, detail?: string) {
  report.checks.push({ name, passed: condition });
  assert.ok(condition, detail ? `${name}: ${detail}` : name);
}

async function stepResult(step: string) {
  const entry = await waitFor(`the ${step} tool result`, () => toolLogs().find((item) => item.step === step));
  const text = entry.result?.contentItems.map((item) => item.text).join("\n") ?? JSON.stringify(entry.error);
  const result = { step, success: entry.result?.success === true, text };
  report.calls.push(result);
  return result;
}

await writeFile(fakeCodex, FAKE_CODEX, { mode: 0o755 });
const database = new OpenBotDatabase(userData);
const store = new AgentStore(userData, home, database);
const mailbox = new MailboxStore(userData, store.sharedRoot, store.database);
const agents = new AgentService({
  store,
  mailbox,
  browser,
  preferredProvider: "codex",
  offProviders: AGENT_PROVIDERS.filter((provider) => provider !== "codex"),
  timezone: () => "UTC",
  approvalAutomation: {
    autoApproves: () => true,
    set: () => Effect.succeed({ defaultAutoApprove: true, autoApproveOverrides: {} }),
  },
});

function idle(agentId: string) {
  return waitFor("the agent to finish", () =>
    agents
      .listQueue(agentId)
      .deliveries.every((delivery) => !["queued", "starting", "running"].includes(delivery.status)),
  );
}

async function create(name: string) {
  const agent = await runCauseEffect(
    agents.createAgent({
      name,
      description: `${name} helps with tests.`,
      avatarSeed: name.toLowerCase(),
      avatarHue: null,
      initialMessage: "Hello.",
    }),
  );
  await idle(agent.id);
  return agent;
}

const fromTo = (senderId: string, recipientId: string) =>
  agents
    .listQueue(recipientId)
    .deliveries.filter((delivery) => delivery.sender.kind === "agent" && delivery.sender.agentId === senderId);

try {
  await runCauseEffect(agents.initialize());
  const lead = await create("Vegapunk");
  const apoo = await create("Apoo");
  const arena = await create("Arena");

  writeFileSync(
    planFile,
    JSON.stringify({
      "lead-ask-apoo": {
        tool: "send_message",
        args: { recipientAgentIds: [apoo.id], text: "Render wave 2 STEP:apoo-blocked" },
      },
      "apoo-blocked": {
        tool: "send_message",
        args: {
          recipientAgentIds: [lead.id],
          text: "Cannot read the style pack folder.",
          expectsReply: false,
          status: "blocked",
          next: "grant read access to style-packs",
        },
      },
      "lead-ask-arena": {
        tool: "send_message",
        args: { recipientAgentIds: [arena.id], text: "Check the timing of the cut" },
      },
      "lead-bad-status": {
        tool: "send_message",
        args: { recipientAgentIds: [arena.id], text: "FYI only", expectsReply: false, status: "done" },
      },
      "lead-bad-next": {
        tool: "send_message",
        args: { recipientAgentIds: [arena.id], text: "FYI only", expectsReply: false, next: "x" },
      },
      "lead-board": { tool: "team_board", args: {} },
    }),
  );

  await runCauseEffect(agents.sendMessage({ agentId: lead.id, text: "STEP:lead-ask-apoo" }));
  const asked = await stepResult("lead-ask-apoo");
  pass("The lead's request to Apoo is sent", asked.success, asked.text);
  const blocked = await stepResult("apoo-blocked");
  pass(
    "Apoo's reply with status and next is accepted without replyToMessageId in the answering turn",
    blocked.success,
    blocked.text,
  );
  await idle(apoo.id);
  await idle(lead.id);
  const apooReport = await waitFor("Apoo's report in the lead's queue", () => fromTo(apoo.id, lead.id)[0]);
  pass(
    "The lead gets the status and next lines first",
    apooReport.text.startsWith("Status: blocked\nNext: grant read access to style-packs\n\nCannot read"),
    apooReport.text,
  );

  await runCauseEffect(agents.sendMessage({ agentId: lead.id, text: "STEP:lead-ask-arena" }));
  pass("The lead's request to Arena is sent", (await stepResult("lead-ask-arena")).success);
  await idle(arena.id);
  await idle(lead.id);
  await waitFor("Arena's plain result", () => fromTo(arena.id, lead.id)[0]);

  await runCauseEffect(agents.sendMessage({ agentId: lead.id, text: "STEP:lead-bad-status" }));
  const badStatus = await stepResult("lead-bad-status");
  pass(
    "status outside a reply is refused with a correctable error",
    !badStatus.success && badStatus.text.includes("only for your reply to a request"),
    badStatus.text,
  );
  await idle(lead.id);
  await runCauseEffect(agents.sendMessage({ agentId: lead.id, text: "STEP:lead-bad-next" }));
  const badNext = await stepResult("lead-bad-next");
  pass("next without status is refused", !badNext.success && badNext.text.includes("next needs status"), badNext.text);
  await idle(lead.id);
  pass("Neither refused call sent anything", fromTo(lead.id, arena.id).length === 1);

  await runCauseEffect(agents.sendMessage({ agentId: lead.id, text: "STEP:lead-board" }));
  const boardCall = await stepResult("lead-board");
  await idle(lead.id);
  const tool = JSON.parse(boardCall.text);
  const byName = new Map(tool.teammates.map((row: { name: string }) => [row.name, row]));
  pass("openbot.team_board lists both teammates", boardCall.success && byName.size === 2, boardCall.text);
  pass(
    "Apoo is blocked, with its next step",
    JSON.stringify(byName.get("Apoo")).includes('"state":"blocked"') &&
      JSON.stringify(byName.get("Apoo")).includes('"next":"grant read access to style-packs"'),
    boardCall.text,
  );
  pass(
    "Arena's reply without a status is replied",
    JSON.stringify(byName.get("Arena")).includes('"state":"replied"'),
    boardCall.text,
  );

  const board = agents.forkTeamBoard({ leadId: lead.id });
  const rows = board.leads[0]?.rows ?? [];
  pass(
    "The app's board has the same rows, idle teammates, and the request titles",
    rows.length === 2 &&
      rows.every((row) => row.activity === "idle") &&
      rows.some((row) => row.teammateName === "Apoo" && row.request === "Render wave 2 STEP:apoo-blocked"),
    JSON.stringify(board),
  );
  pass("The teammates lead nobody", agents.forkTeamBoard({ leadId: apoo.id }).leads.length === 0);

  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.exitCode = 1;
} finally {
  await runCauseEffect(agents.stop()).catch(() => {});
  database.close();
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await rm(root, { recursive: true, force: true });
  process.stdout.write(`${report.passed ? "PASS" : "FAIL"} ${join(OUT, "report.json")}\n`);
  if (report.error) process.stdout.write(`${report.error}\n`);
}
