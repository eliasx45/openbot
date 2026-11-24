import { appendFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { installFakeAgent, readJsonl, startThread, stopClients } from "../../scripts/provider-fakes/host";
import type { AgentClient } from "./agent-client";
import { CodexAppServerClient } from "./app-server-client";
import { runCauseEffect } from "./effect-boundary";
import { type AppServerNotification, getRecord, getString } from "./protocol";
import { NO_PROVIDER_CREDENTIALS, requireProviderDriver } from "./provider-drivers";

interface FakeAgent {
  client: AgentClient;
  thread: string;
  reads: string[];
  send(update: SessionUpdate): Promise<void>;
  start(text: string): Promise<{ id: string; status: Promise<string | null> }>;
  steer(turnId: string, deliveryId: string, text: string): Promise<string | null>;
  end(): Promise<void>;
}

interface CodexNotificationParams {
  turnId?: string;
  turn?: { id: string; status: string };
  item?: { type: string; id: string; clientId?: string | null; content?: { type: string; text: string }[] };
}

const roots: string[] = [];
const clients: AgentClient[] = [];

afterEach(async () => {
  await stopClients(clients.splice(0));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function waitFor(check: () => Promise<boolean> | boolean, what: string): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((settle) => setTimeout(settle, 10));
  }
}

async function openFakeAgent(provider: "antigravity" | "opencode"): Promise<FakeAgent> {
  const root = await mkdtemp(join(tmpdir(), "openbot-acp-steer-read-"));
  roots.push(root);
  process.env.GEMINI_HOME = join(root, "gemini");
  const control = join(root, "control.jsonl");
  const log = join(root, "agent.jsonl");
  const executable = join(root, "bin", provider);
  await mkdir(join(root, "bin"), { recursive: true });
  await appendFile(control, "");
  await installFakeAgent(executable, "steer-read", {
    FAKE_CONTROL: control,
    FAKE_LOG: log,
    FAKE_MODE: provider === "opencode" ? "steering" : "prompt",
  });
  const client = requireProviderDriver(provider).createClient(
    { executable, version: provider === "opencode" ? "2.3.0" : "1.5.16", source: "managed" },
    10_000,
    NO_PROVIDER_CREDENTIALS,
  );
  clients.push(client);
  const reads: string[] = [];
  const marks = new Set<number>();
  client.on("notification", (notification: AppServerNotification) => {
    if (notification.method === "openbot/steer-read")
      reads.push(getString(notification.params, "clientUserMessageId") ?? "");
    if (notification.method === "thread/tokenUsage/updated") {
      const used = getRecord(getRecord(notification.params, "tokenUsage"), "last")?.totalTokens;
      if (typeof used === "number") marks.add(used);
    }
  });
  client.start();
  const thread = await startThread(client, { cwd: root });
  let mark = 1_000;
  const command = async (body: { update?: SessionUpdate; end?: true }) => {
    mark += 1;
    const expected = mark;
    await appendFile(control, `${JSON.stringify({ ...body, mark: expected })}\n`);
    return expected;
  };
  const prompts = async () =>
    (await readJsonl<{ event: string; text?: string }>(log)).filter((entry) => entry.event === "prompt").length;
  return {
    client,
    thread,
    reads,
    send: async (update) => {
      const expected = await command({ update });
      await waitFor(() => marks.has(expected), `the client to take ${update.sessionUpdate}`);
    },
    start: async (text) => {
      const before = await prompts();
      let finish: (status: string | null) => void = () => undefined;
      const status = new Promise<string | null>((settle) => {
        finish = settle;
      });
      client.on("notification", (notification: AppServerNotification) => {
        if (notification.method === "turn/completed" && getString(notification.params, "threadId") === thread)
          finish(getString(getRecord(notification.params, "turn"), "status"));
      });
      const response = await runCauseEffect(
        client.request(
          "turn/start",
          { threadId: thread, input: [{ type: "text", text, text_elements: [] }] },
          (value) => value,
        ),
      );
      const id = getString(getRecord(response, "turn"), "id") ?? "";
      await waitFor(async () => (await prompts()) > before, "the prompt");
      return { id, status };
    },
    steer: (turnId, deliveryId, text) =>
      runCauseEffect(
        client.request(
          "turn/steer",
          {
            threadId: thread,
            expectedTurnId: turnId,
            clientUserMessageId: deliveryId,
            input: [{ type: "text", text, text_elements: [] }],
          },
          (value) => getString(value, "turnId"),
        ),
      ),
    end: async () => {
      await command({ end: true });
    },
  };
}

const thought = (text: string): SessionUpdate => ({
  sessionUpdate: "agent_thought_chunk",
  content: { type: "text", text },
});
const answer = (text: string): SessionUpdate => ({
  sessionUpdate: "agent_message_chunk",
  content: { type: "text", text },
});
const tool = (id: string): SessionUpdate => ({
  sessionUpdate: "tool_call",
  toolCallId: id,
  title: "sleep 30",
  kind: "execute",
  status: "in_progress",
});
const toolProgress = (id: string): SessionUpdate => ({
  sessionUpdate: "tool_call_update",
  toolCallId: id,
  status: "in_progress",
  content: [{ type: "content", content: { type: "text", text: "still building" } }],
});
const toolDone = (id: string): SessionUpdate => ({
  sessionUpdate: "tool_call_update",
  toolCallId: id,
  status: "completed",
});
const echo = (text: string): SessionUpdate => ({
  sessionUpdate: "user_message_chunk",
  content: { type: "text", text },
});

describe("read receipt of a message steered into a running turn", () => {
  it("Antigravity (steer by prompt): read at the model's first output after the step, not when the CLI takes it", async () => {
    const agent = await openFakeAgent("antigravity");
    const turn = await agent.start("work");
    await agent.send(thought("I will build it."));
    await agent.send(tool("tool-1"));

    expect(await agent.steer(turn.id, "delivery-1", "use the other branch")).toBe(turn.id);
    expect(agent.reads).toEqual([]);
    await agent.send(toolProgress("tool-1"));
    expect(agent.reads).toEqual([]);
    await agent.send(toolDone("tool-1"));
    expect(agent.reads).toEqual([]);
    await agent.send(echo("use the other branch"));
    expect(agent.reads).toEqual([]);
    await agent.send(thought("Switching to the other branch."));
    expect(agent.reads).toEqual(["delivery-1"]);

    expect(await agent.steer(turn.id, "delivery-2", "also run the tests")).toBe(turn.id);
    await agent.send(thought(" The branch is checked out."));
    await agent.send(tool("tool-2"));
    expect(agent.reads).toEqual(["delivery-1"]);
    await agent.send(toolDone("tool-2"));
    expect(agent.reads).toEqual(["delivery-1"]);
    await agent.send(answer("Done on the other branch, and the tests pass."));
    expect(agent.reads).toEqual(["delivery-1", "delivery-2"]);

    await agent.end();
    expect(await turn.status).toBe("completed");
    expect(agent.reads).toEqual(["delivery-1", "delivery-2"]);
  });

  it("OpenCode (steering extension): read at the model's first output after the step it was injected into", async () => {
    const agent = await openFakeAgent("opencode");
    const turn = await agent.start("work");
    await agent.send(thought("Planning the build."));

    expect(await agent.steer(turn.id, "delivery-3", "use the other branch")).toBe(turn.id);
    await agent.send(thought(" Still planning."));
    await agent.send(tool("tool-1"));
    expect(agent.reads).toEqual([]);
    await agent.send(toolProgress("tool-1"));
    await agent.send(toolDone("tool-1"));
    expect(agent.reads).toEqual([]);
    await agent.send(answer("Using the other branch."));
    expect(agent.reads).toEqual(["delivery-3"]);

    await agent.end();
    expect(await turn.status).toBe("completed");
    expect(agent.reads).toEqual(["delivery-3"]);
  });

  it("Codex: read when the app-server takes the steer into the model's input, matched by its client id", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-codex-steer-read-"));
    roots.push(root);
    const control = join(root, "control.jsonl");
    const executable = join(root, "bin", "codex");
    await appendFile(control, "");
    await installFakeAgent(executable, "codex-steer-read", { FAKE_CONTROL: control });
    const client = new CodexAppServerClient(executable, 10_000, { CODEX_HOME: join(root, "codex") });
    clients.push(client);
    const reads: string[] = [];
    const seen: string[] = [];
    client.on("notification", (notification: AppServerNotification) => {
      if (notification.method === "openbot/steer-read")
        reads.push(getString(notification.params, "clientUserMessageId") ?? "");
      else seen.push(`${notification.method}:${getString(getRecord(notification.params, "item"), "id") ?? ""}`);
    });
    client.start();
    const notify = async (method: string, params: CodexNotificationParams) => {
      const key = `${method}:${getString(getRecord(params, "item"), "id") ?? ""}`;
      const before = seen.filter((entry) => entry === key).length;
      await appendFile(control, `${JSON.stringify({ method, params: { threadId: "thread-1", ...params } })}\n`);
      await waitFor(() => seen.filter((entry) => entry === key).length > before, key);
    };
    const userMessage = (id: string, clientId: string | null) => ({
      turnId: "turn-1",
      item: { type: "userMessage", id, clientId, content: [{ type: "text", text: "use the other branch" }] },
    });
    const steer = (turnId: string, deliveryId: string) =>
      runCauseEffect(
        client.request(
          "turn/steer",
          {
            threadId: "thread-1",
            expectedTurnId: turnId,
            clientUserMessageId: deliveryId,
            input: [{ type: "text", text: "use the other branch" }],
          },
          (value) => getString(value, "turnId"),
        ),
      );

    await notify("turn/started", { turn: { id: "turn-1", status: "inProgress" } });
    await notify("item/started", userMessage("start-input", "delivery-start"));
    expect(await steer("turn-1", "delivery-5")).toBe("turn-1");
    await notify("item/started", { turnId: "turn-1", item: { type: "commandExecution", id: "cmd-1" } });
    await notify("item/started", userMessage("no-client-id", null));
    expect(reads).toEqual([]);
    await notify("item/started", userMessage("steer-input", "delivery-5"));
    expect(reads).toEqual(["delivery-5"]);
    await notify("item/completed", userMessage("steer-input", "delivery-5"));
    expect(reads).toEqual(["delivery-5"]);

    await expect(steer("ended-turn", "delivery-6")).rejects.toThrow();
    await notify("item/started", userMessage("refused-input", "delivery-6"));
    expect(await steer("turn-1", "delivery-7")).toBe("turn-1");
    await notify("turn/completed", { turn: { id: "turn-1", status: "interrupted" } });
    await notify("item/started", userMessage("late-input", "delivery-7"));
    expect(reads).toEqual(["delivery-5"]);
  });

  it("a steer that the CLI refuses gets no receipt", async () => {
    const agent = await openFakeAgent("antigravity");
    const turn = await agent.start("work");
    await agent.send(tool("tool-1"));
    await expect(agent.steer(turn.id, "delivery-4", "refuse this")).rejects.toThrow();
    await agent.send(toolDone("tool-1"));
    await agent.send(echo("refuse this"));
    await agent.send(answer("Built."));
    await agent.end();
    expect(await turn.status).toBe("completed");
    expect(agent.reads).toEqual([]);
  });
});
