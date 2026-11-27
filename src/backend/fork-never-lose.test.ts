// @vitest-environment node
// Fork (docs/fork/FEATURES.md #136, "Never lose work"): the restart wake of an agent whose turn a quit
// stopped. The flow with the real service and the fake `agy` is scripts/antigravity-quit-resume-e2e.ts.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConversationMessage, QueueDelivery } from "@openbot/contracts/ipc";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ForkRestartResume, type ForkRestartResumeHooks, restartResumeText } from "./fork-restart-resume";

const folders: string[] = [];
beforeEach(() => {
  process.env.OPENBOT_FORK_RESTART_RESUME_GRACE_MS = "0";
  process.env.OPENBOT_FORK_RESTART_RESUME_STAGGER_MS = "0";
});
afterEach(async () => {
  delete process.env.OPENBOT_FORK_RESTART_RESUME_GRACE_MS;
  delete process.env.OPENBOT_FORK_RESTART_RESUME_STAGGER_MS;
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});

const agentId = "agent-vegapunk";
const threadId = "openbot-thread-agent-vegapunk";

function delivery(
  id: string,
  sender: QueueDelivery["sender"],
  turnId: string | null,
  text: string,
  createdAt: string,
  status: QueueDelivery["status"] = "running",
): QueueDelivery {
  return {
    id,
    messageId: `message-${id}`,
    recipientAgentId: agentId,
    sender,
    text,
    attachments: [],
    replyToMessageId: null,
    status,
    position: null,
    turnId,
    error: null,
    createdAt,
  };
}

function answer(text: string, createdAt: string): ConversationMessage {
  return { id: `answer-${createdAt}`, turnId: "turn-1", author: "assistant", text, createdAt, status: "streaming" };
}

interface Harness {
  hooks: ForkRestartResumeHooks;
  enqueued: Array<{ title: string; text: string }>;
  statuses: Map<string, QueueDelivery>;
}

function harness(own: QueueDelivery[], overrides: Partial<ForkRestartResumeHooks> = {}): Harness {
  const enqueued: Harness["enqueued"] = [];
  const statuses = new Map<string, QueueDelivery>();
  const hooks: ForkRestartResumeHooks = {
    agent: (id) => (id === agentId ? { threadId, provider: "antigravity" } : null),
    providerReady: () => true,
    session: () => ({ externalSessionId: "agy-1" }),
    subagentIds: async () => new Map(),
    subagentOutcomes: async () => new Map(),
    executionDelivery: () => false,
    laneBusy: () => false,
    laneQueued: () => 0,
    laneQueuedFromUser: () => 0,
    laneBusyWithUser: () => false,
    agentName: (id) => (id === "agent-apoo" ? "Apoo" : null),
    continuationQueued: () => false,
    delivery: (id) => statuses.get(id) ?? null,
    deliveryOfTurn: () => null,
    unresolvedOwnDeliveries: () => own,
    goalWorking: () => false,
    openWait: () => "wait-1",
    waitOpen: () => true,
    closeWait: () => {},
    enqueue: async ({ title, text }) => {
      enqueued.push({ title, text });
      return "wake-delivery";
    },
    line: () => {},
    timezone: () => "UTC",
    isRunning: () => true,
    log: () => {},
    ...overrides,
  };
  return { hooks, enqueued, statuses };
}

async function databasePath(): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), "openbot-never-lose-"));
  folders.push(folder);
  return join(folder, "openbot.db");
}

async function until(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await new Promise((done) => setTimeout(done, 20));
  }
}

const settled = (item: QueueDelivery): QueueDelivery => ({ ...item, status: "interrupted" });

describe("#136 restart wake of a lead's long turn", () => {
  const request = delivery("d-request", { kind: "user" }, "turn-1", "Run the swarm plan", "2026-11-27T11:03:00.000Z");
  const early = delivery(
    "d-early",
    { kind: "agent", agentId: "agent-apoo" },
    "turn-1",
    "Apoo: sound pass done",
    "2026-11-27T11:10:00.000Z",
  );
  const report = delivery(
    "d-s2",
    { kind: "agent", agentId: "agent-apoo" },
    "turn-1",
    "Apoo: signature upgrade ready",
    "2026-11-27T12:21:00.000Z",
  );
  const late = [
    delivery("d-s1", { kind: "user" }, "turn-1", "also check the load guard", "2026-11-27T12:20:00.000Z"),
    report,
    delivery("d-s3", { kind: "user" }, "turn-1", "and ping Tatiana", "2026-11-27T12:22:00.000Z"),
  ];
  const own = [request, early, ...late];
  const messages = [answer("Plan step 3 done.", "2026-11-27T12:00:00.000Z")];

  it("names the messages that came after the last answer, and leaves out one that runs again", async () => {
    const path = await databasePath();
    const quit = harness(own);
    const noting = new ForkRestartResume({ databasePath: path, hooks: quit.hooks });
    noting.capture({ agentId, threadId, ownChat: true, turnId: "turn-1", messages, quitting: true });
    noting.dispose();
    expect(noting.entries()[0]?.steered?.map((message) => message.deliveryId)).toEqual(["d-s1", "d-s2"]);
    const boot = harness([]);
    for (const item of own) boot.statuses.set(item.id, settled(item));
    // Boot recovery queued Apoo's report again (a teammate's result): it runs by itself.
    boot.statuses.set("d-s2", { ...report, status: "queued", turnId: null });
    const resume = new ForkRestartResume({ databasePath: path, hooks: boot.hooks });
    resume.start();
    await until(() => boot.enqueued.length === 1, "the wake");
    resume.dispose();
    const text = boot.enqueued[0]?.text ?? "";
    // The newest message of the user is the request it continues, as before #136.
    expect(text).toContain("The request it continues:\nand ping Tatiana");
    expect(text).toContain("These messages came into that turn after your last answer");
    expect(text).toContain("12:20 on 27 Nov (UTC), from the user: also check the load guard");
    expect(text).not.toContain("signature upgrade");
    expect(text).not.toContain("sound pass done");
    // A Gemini lead's stopped turn is called a turn, not stopped subagents.
    expect(text).toContain("Your last turn was interrupted at");
    expect(text).not.toContain("Your subagents were stopped");
  });

  it("a teammate's report or a routine run in the queue does not take the wake's place; the user's does", async () => {
    const path = await databasePath();
    const quit = harness(own, { laneQueued: () => 1, laneQueuedFromUser: () => 0 });
    const noting = new ForkRestartResume({ databasePath: path, hooks: quit.hooks });
    noting.capture({ agentId, threadId, ownChat: true, turnId: "turn-1", messages, quitting: true });
    expect(noting.entries()[0]?.state).toBe("pending");
    noting.dispose();
    const boot = harness([], { laneQueued: () => 2, laneBusy: () => true, laneQueuedFromUser: () => 0 });
    for (const item of own) boot.statuses.set(item.id, settled(item));
    const resume = new ForkRestartResume({ databasePath: path, hooks: boot.hooks });
    resume.start();
    // A teammate report's turn started first: not the user's, so the wake still comes.
    resume.turnStarted(agentId, threadId, false);
    await until(() => boot.enqueued.length === 1, "the wake behind the teammate's report");
    resume.dispose();

    const userPath = await databasePath();
    const user = harness(own, { laneQueued: () => 1, laneQueuedFromUser: () => 1 });
    const taken = new ForkRestartResume({ databasePath: userPath, hooks: user.hooks });
    taken.capture({ agentId, threadId, ownChat: true, turnId: "turn-1", messages, quitting: true });
    expect(taken.entries()[0]?.reason).toBe("a queued message runs instead");
  });

  it("a user's turn that starts before the wake still takes its place", async () => {
    const path = await databasePath();
    const quit = harness(own);
    const noting = new ForkRestartResume({ databasePath: path, hooks: quit.hooks });
    noting.capture({ agentId, threadId, ownChat: true, turnId: "turn-1", messages, quitting: true });
    noting.dispose();
    process.env.OPENBOT_FORK_RESTART_RESUME_GRACE_MS = "300";
    const boot = harness([]);
    for (const item of own) boot.statuses.set(item.id, settled(item));
    const resume = new ForkRestartResume({ databasePath: path, hooks: boot.hooks });
    resume.start();
    resume.turnStarted(agentId, threadId, true);
    await until(() => resume.entries()[0]?.state === "skipped", "the skip");
    resume.dispose();
    expect(resume.entries()[0]?.reason).toBe("another turn started since the restart");
    expect(boot.enqueued).toHaveLength(0);
  });

  it("a Gemini chat whose session is gone continues in a new one; a Claude chat does not", async () => {
    const path = await databasePath();
    const quit = harness(own);
    const noting = new ForkRestartResume({ databasePath: path, hooks: quit.hooks });
    noting.capture({ agentId, threadId, ownChat: true, turnId: "turn-1", messages, quitting: true });
    noting.dispose();
    const boot = harness([], { session: () => null });
    for (const item of own) boot.statuses.set(item.id, settled(item));
    const resume = new ForkRestartResume({ databasePath: path, hooks: boot.hooks });
    resume.start();
    await until(() => boot.enqueued.length === 1, "the wake in a new session");
    resume.dispose();
    expect(boot.enqueued[0]?.text).toContain("OpenBot could not reopen your earlier provider session");
    expect(resume.entries()[0]?.state).toBe("queued");

    const claudePath = await databasePath();
    const claudeQuit = harness(own, { agent: () => ({ threadId, provider: "claude" }) });
    const claudeNoting = new ForkRestartResume({ databasePath: claudePath, hooks: claudeQuit.hooks });
    claudeNoting.capture({ agentId, threadId, ownChat: true, turnId: "turn-1", messages });
    claudeNoting.dispose();
    const claudeBoot = harness([], { agent: () => ({ threadId, provider: "claude" }), session: () => null });
    for (const item of own) claudeBoot.statuses.set(item.id, settled(item));
    const claude = new ForkRestartResume({ databasePath: claudePath, hooks: claudeBoot.hooks });
    claude.start();
    await until(() => claude.entries()[0]?.state === "skipped", "the Claude skip");
    claude.dispose();
    expect(claude.entries()[0]?.reason).toBe("provider session gone");
  });
});

describe("#136 tries of a resume that restarts stop again", () => {
  const wakeOf = (attempt: number, turnId: string) =>
    delivery(
      `wake-${attempt}`,
      {
        kind: "routine",
        routineId: "fork-restart-resume",
        runId: `restart-resume:${attempt}:turn:turn-0`,
        routineName: "Resume",
        scheduledFor: "",
      },
      turnId,
      "[OpenBot: 🔄 restart] …",
      "2026-11-27T12:30:00.000Z",
    );

  it("quits give six tries; crashes give two", async () => {
    const path = await databasePath();
    // The first quit stops the lead's turn.
    const first = new ForkRestartResume({
      databasePath: path,
      hooks: harness([delivery("d-1", { kind: "user" }, "turn-0", "go", "2026-11-27T12:00:00.000Z")]).hooks,
    });
    first.capture({ agentId, threadId, ownChat: true, turnId: "turn-0", messages: [], quitting: true });
    first.dispose();
    expect(first.entries()[0]?.cleanStops).toBe(true);
    // Each later quit stops the wake's own turn (user messages keep it open).
    let attempts: number[] = [];
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      const run = new ForkRestartResume({
        databasePath: path,
        hooks: harness([wakeOf(attempt, `turn-${attempt}`)], { isRunning: () => false }).hooks,
      });
      run.start();
      run.capture({ agentId, threadId, ownChat: true, turnId: `turn-${attempt}`, messages: [], quitting: true });
      attempts = [...attempts, run.entries()[0]?.attempt ?? 0];
      run.dispose();
      const state = run.entries()[0]?.state;
      if (attempt < 6) expect(state, `try ${attempt + 1}`).toBe("pending");
      else expect(run.entries()[0]?.reason).toBe("retry limit: the resume was interrupted again");
    }
    expect(attempts).toEqual([2, 3, 4, 5, 6, 7]);

    // A crash (no clean stop, noted at boot): the old limit of two.
    const crashPath = await databasePath();
    const crashed = new ForkRestartResume({ databasePath: crashPath, hooks: harness([wakeOf(2, "turn-9")]).hooks });
    crashed.capture({ agentId, threadId, ownChat: true, turnId: "turn-9", messages: [] });
    expect(crashed.entries()[0]?.attempt).toBe(3);
    expect(crashed.entries()[0]?.reason).toBe("retry limit: the resume was interrupted again");
  });

  it("the wake text says which try it is, and only the last one says last", () => {
    const base = {
      kind: "turn" as const,
      interruptedAt: "2026-11-27T12:00:00.000Z",
      timezone: "UTC",
      subagents: [],
      requestText: "go",
    };
    expect(restartResumeText({ ...base, attempt: 3, lastTry: false })).toContain("this is automatic try 3");
    expect(restartResumeText({ ...base, attempt: 3, lastTry: false })).not.toContain("last automatic try");
    expect(restartResumeText({ ...base, attempt: 6, lastTry: true })).toContain("last automatic try");
    expect(restartResumeText({ ...base, attempt: 2, provider: "antigravity", lastTry: false })).toContain(
      "this is automatic try 2",
    );
  });
});
