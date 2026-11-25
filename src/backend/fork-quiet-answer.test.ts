// Fork (docs/fork/FEATURES.md #111): a Gemini (Antigravity) reply ends while the prompt stays open.
import { appendFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { installFakeAgent, readJsonl, startThread, stopClients } from "../../scripts/provider-fakes/host";
import { AcpAgentClient } from "./acp-client";
import { ANTIGRAVITY_ACP_FLAVOR } from "./acp-flavor-antigravity";
import type { AgentClient } from "./agent-client";
import { runCauseEffect } from "./effect-boundary";
import { type AppServerNotification, getRecord, getString } from "./protocol";

const QUIET_MS = 400;

interface Item {
  method: string;
  id: string;
  phase: string | null;
  text: string | null;
}

interface FakeAgent {
  items: Item[];
  send(update: SessionUpdate): Promise<void>;
  start(text: string): Promise<{ id: string; status: Promise<string | null>; done(): boolean }>;
  steer(turnId: string, text: string): Promise<string | null>;
  end(): Promise<void>;
}

const roots: string[] = [];
const clients: AgentClient[] = [];

afterEach(async () => {
  await stopClients(clients.splice(0));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const sleep = (ms: number) => new Promise((settle) => setTimeout(settle, ms));

async function waitFor(check: () => Promise<boolean> | boolean, what: string): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await sleep(10);
  }
}

/** A real `AcpAgentClient` with Antigravity's flavor over a fake `agy acp` whose prompt stays open. */
async function openAntigravity(): Promise<FakeAgent> {
  const root = await mkdtemp(join(tmpdir(), "openbot-acp-quiet-answer-"));
  roots.push(root);
  const control = join(root, "control.jsonl");
  const log = join(root, "agent.jsonl");
  const executable = join(root, "bin", "antigravity");
  await mkdir(join(root, "bin"), { recursive: true });
  await appendFile(control, "");
  await installFakeAgent(executable, "steer-read", { FAKE_CONTROL: control, FAKE_LOG: log, FAKE_MODE: "prompt" });
  const client = new AcpAgentClient({ executable, version: "1.5.17", source: "managed" }, 10_000, {
    provider: "antigravity",
    flavor: ANTIGRAVITY_ACP_FLAVOR,
    argv: ["acp"],
    env: {},
    signInMessage: "Sign in to the fake agent.",
    answerQuietMs: QUIET_MS,
  });
  clients.push(client);
  const items: Item[] = [];
  const marks = new Set<number>();
  client.on("notification", (notification: AppServerNotification) => {
    const item = getRecord(notification.params, "item");
    if (
      (notification.method === "item/started" || notification.method === "item/completed") &&
      getString(item, "type") === "agentMessage"
    )
      items.push({
        method: notification.method,
        id: getString(item, "id") ?? "",
        phase: getString(item, "phase"),
        text: getString(item, "text"),
      });
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
    (await readJsonl<{ event: string }>(log)).filter((entry) => entry.event === "prompt").length;
  return {
    items,
    send: async (update) => {
      const expected = await command({ update });
      await waitFor(() => marks.has(expected), `the client to take ${update.sessionUpdate}`);
    },
    start: async (text) => {
      const before = await prompts();
      let finished = false;
      let finish: (status: string | null) => void = () => undefined;
      const status = new Promise<string | null>((settle) => {
        finish = settle;
      });
      client.on("notification", (notification: AppServerNotification) => {
        if (notification.method === "turn/completed" && getString(notification.params, "threadId") === thread) {
          finished = true;
          finish(getString(getRecord(notification.params, "turn"), "status"));
        }
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
      return { id, status, done: () => finished };
    },
    steer: async (turnId, text) => {
      const before = await prompts();
      const steered = await runCauseEffect(
        client.request(
          "turn/steer",
          {
            threadId: thread,
            expectedTurnId: turnId,
            clientUserMessageId: `delivery-${before}`,
            input: [{ type: "text", text, text_elements: [] }],
          },
          (value) => getString(value, "turnId"),
        ),
      );
      await waitFor(async () => (await prompts()) > before, "the steer prompt");
      return steered;
    },
    end: async () => {
      await command({ end: true });
    },
  };
}

const answer = (text: string): SessionUpdate => ({
  sessionUpdate: "agent_message_chunk",
  content: { type: "text", text },
});
const thought = (text: string): SessionUpdate => ({
  sessionUpdate: "agent_thought_chunk",
  content: { type: "text", text },
});
const tool = (id: string, status: "in_progress" | "completed"): SessionUpdate => ({
  sessionUpdate: status === "in_progress" ? "tool_call" : "tool_call_update",
  toolCallId: id,
  title: "invoke_subagent",
  kind: "other",
  status,
});

const completed = (agent: FakeAgent) => agent.items.filter((item) => item.method === "item/completed");

describe("a Gemini reply that ends while Antigravity keeps the prompt open (fork #111)", () => {
  it("completes the reply once it goes quiet, while the turn still runs, and keeps the turn's last answer", async () => {
    const agent = await openAntigravity();
    const turn = await agent.start("launch the analysts");
    await agent.send(tool("subagent-1", "in_progress"));
    await agent.send(tool("subagent-1", "completed"));
    await agent.send(answer("Two analysts run now. "));
    await agent.send(answer("I report when they finish."));
    // Antigravity keeps the prompt open while the subagents run: nothing more comes for minutes.
    await waitFor(() => completed(agent).some((item) => item.text?.includes("I report")), "the quiet reply");
    expect(turn.done()).toBe(false);
    const reply = completed(agent).find((item) => item.text?.includes("I report"));
    expect(reply).toMatchObject({ phase: "commentary", text: "Two analysts run now. I report when they finish." });

    // A steer while the subagents run gets its own reply, in its own item.
    expect(await agent.steer(turn.id, "do you think parallel styles work?")).toBe(turn.id);
    await agent.send({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "do you think" } });
    await agent.send(answer("Yes, three styles side by side."));
    await waitFor(() => completed(agent).some((item) => item.text?.includes("three styles")), "the steer reply");
    const second = completed(agent).find((item) => item.text?.includes("three styles"));
    expect(second?.id).not.toBe(reply?.id);
    expect(second?.phase).toBe("commentary");
    expect(turn.done()).toBe(false);

    // The subagents finish; the model writes the last answer and the prompt ends.
    await agent.send(thought("The analysts are done."));
    await agent.send(answer("Both reports are in."));
    await agent.end();
    expect(await turn.status).toBe("completed");
    const last = completed(agent).at(-1);
    expect(last).toMatchObject({ phase: "final_answer", text: "Both reports are in." });
    // Each text was completed once: none was split or sent twice.
    const texts = completed(agent)
      .filter((item) => !item.id.includes(":thought"))
      .map((item) => item.text);
    expect(texts).toEqual([
      "Two analysts run now. I report when they finish.",
      "Yes, three styles side by side.",
      "Both reports are in.",
    ]);
  });

  it("a reply that went quiet and is the turn's last output becomes the turn's answer", async () => {
    const agent = await openAntigravity();
    const turn = await agent.start("say hi");
    await agent.send(answer("Hi, all done."));
    await waitFor(() => completed(agent).some((item) => item.text === "Hi, all done."), "the quiet reply");
    const quiet = completed(agent).find((item) => item.text === "Hi, all done.");
    expect(quiet?.phase).toBe("commentary");
    await agent.end();
    expect(await turn.status).toBe("completed");
    const last = completed(agent).at(-1);
    expect(last).toMatchObject({ id: quiet?.id, phase: "final_answer", text: "Hi, all done." });
  });

  it("does not split a reply whose chunks come closer than the quiet time", async () => {
    const agent = await openAntigravity();
    const turn = await agent.start("write");
    await agent.send(answer("Part one,"));
    await sleep(QUIET_MS / 3);
    await agent.send(answer(" part two,"));
    await sleep(QUIET_MS / 3);
    await agent.send(answer(" part three."));
    await waitFor(() => completed(agent).length > 0, "the quiet reply");
    expect(completed(agent).map((item) => item.text)).toEqual(["Part one, part two, part three."]);
    await agent.end();
    expect(await turn.status).toBe("completed");
  });

  it("keeps a Gemini failure answer open, so the prompt's end still reports the failure", async () => {
    const agent = await openAntigravity();
    const turn = await agent.start("work");
    await agent.send(answer("Verify your account to continue."));
    await sleep(QUIET_MS * 3);
    expect(completed(agent)).toEqual([]);
    await agent.end();
    expect(await turn.status).toBe("failed");
  });
});
