// @vitest-environment node
// Fork (docs/fork/FEATURES.md #136, "Never lose work"): the restart wake of an agent whose turn a quit
// stopped, a teammate's failed turn, and a repeated send. With the real service and a fake `agy`:
// scripts/antigravity-quit-resume-e2e.ts and scripts/fork-never-lose-e2e.ts.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConversationMessage, QueueDelivery } from "@openbot/contracts/ipc";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCauseEffect } from "./effect-boundary";
import {
  FORK_SEND_DEDUPE_MS,
  forkDuplicateSendResult,
  forkListedMessages,
  forkRetriesTurn,
  forkRetryPromptLine,
  forkRetryReason,
  forkSendKey,
} from "./fork-never-lose";
import { ForkRestartResume, type ForkRestartResumeHooks, restartResumeText } from "./fork-restart-resume";
import { MailboxStore } from "./mailbox-store";
import { OpenBotDatabase } from "./openbot-database";

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
    expect(noting.entries()[0]?.steered?.map((message) => message.deliveryId)).toEqual(["d-s1", "d-s2", "d-s3"]);
    const boot = harness([]);
    for (const item of own) boot.statuses.set(item.id, settled(item));
    // Boot recovery queued Apoo's report again (a teammate's result): it runs by itself.
    boot.statuses.set("d-s2", { ...report, status: "queued", turnId: null });
    const resume = new ForkRestartResume({ databasePath: path, hooks: boot.hooks });
    resume.start();
    await until(() => boot.enqueued.length === 1, "the wake");
    resume.dispose();
    const text = boot.enqueued[0]?.text ?? "";
    // The user's first message of the turn is the request it continues; the steered ones are listed.
    expect(text).toContain("The request it continues:\nRun the swarm plan");
    expect(text).toContain("12:22 on 27 Nov (UTC), from the user: and ping Tatiana");
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

describe("#136 one automatic retry of a failed hand-off", () => {
  const request = { id: "d-1", senderAgentId: "vega", expectsReply: true, channel: false, retried: false };
  const base = {
    agentId: "shadow",
    status: "failed",
    cause: "network" as const,
    otherPath: false,
    providerRestart: false,
    deliveries: [request],
  };

  it("retries a teammate's request that failed on a temporary cause", () => {
    for (const cause of ["timeout", "stalled", "network", "provider_unavailable", "empty_answer"] as const)
      expect(forkRetriesTurn({ ...base, cause }), cause).toBe(true);
  });

  it("does not retry a permanent cause, a stop, a second failure, #131's resume or the user's own turn", () => {
    for (const cause of ["authentication", "usage_limit", "rate_limit", "content_blocked", "unknown"] as const)
      expect(forkRetriesTurn({ ...base, cause }), cause).toBe(false);
    expect(forkRetriesTurn({ ...base, cause: undefined })).toBe(false);
    // The user pressed Stop: the turn is interrupted, not failed.
    expect(forkRetriesTurn({ ...base, status: "interrupted" })).toBe(false);
    expect(forkRetriesTurn({ ...base, deliveries: [{ ...request, retried: true }] })).toBe(false);
    expect(forkRetriesTurn({ ...base, providerRestart: true })).toBe(false);
    expect(forkRetriesTurn({ ...base, otherPath: true })).toBe(false);
    expect(forkRetriesTurn({ ...base, deliveries: [{ ...request, senderAgentId: null }] })).toBe(false);
    expect(forkRetriesTurn({ ...base, deliveries: [{ ...request, expectsReply: false }] })).toBe(false);
    expect(forkRetriesTurn({ ...base, deliveries: [{ ...request, channel: true }] })).toBe(false);
  });

  it("words the retry and the resent message", () => {
    expect(forkRetryPromptLine({ kind: "retry", reason: "connection reset by peer" })).toContain(
      "OpenBot retry: your previous attempt at this request failed: connection reset by peer. Continue from what's already done",
    );
    expect(forkRetryPromptLine({ kind: "steered", reason: "x" })).toContain("[OpenBot: 🔁 resent]");
    expect(forkRetryPromptLine(undefined)).toBeNull();
    expect(forkRetryReason(undefined, "timeout")).toBe("the provider failed (timeout)");
  });
});

describe("#136 mailbox: requeue, companions, failure notes, repeated sends", () => {
  async function mailboxOf() {
    const folder = await mkdtemp(join(tmpdir(), "openbot-never-lose-mailbox-"));
    folders.push(folder);
    const database = new OpenBotDatabase(folder);
    await runCauseEffect(database.initialize());
    const mailbox = new MailboxStore(folder, join(folder, "shared"), database);
    await runCauseEffect(mailbox.initialize());
    const send = (from: string, to: string[], text: string, expectsReply?: boolean, idempotencyKey?: string) =>
      runCauseEffect(
        mailbox.enqueue({
          sender: { kind: "agent", agentId: from },
          recipientAgentIds: to,
          text,
          replyToMessageId: null,
          ...(expectsReply === undefined ? {} : { expectsReply }),
          ...(idempotencyKey ? { idempotencyKey } : {}),
        }),
      );
    return { mailbox, database, send };
  }
  const within = FORK_SEND_DEDUPE_MS;

  it("finds an open identical request; not after a reply, a failure, for other recipients or text, or 6 h later", async () => {
    const { mailbox, database, send } = await mailboxOf();
    const first = await send("vega", ["shadow"], "Render  the\nclips");
    const open = mailbox.forkOpenDuplicate({
      senderAgentId: "vega",
      recipientAgentIds: ["shadow"],
      text: "Render the clips",
      withinMs: within,
    });
    expect(open?.messageId).toBe(first.messageId);
    expect(
      mailbox.forkOpenDuplicate({
        senderAgentId: "vega",
        recipientAgentIds: ["shadow", "owl"],
        text: "Render the clips",
        withinMs: within,
      }),
    ).toBeNull();
    expect(
      mailbox.forkOpenDuplicate({
        senderAgentId: "vega",
        recipientAgentIds: ["shadow"],
        text: "Render other clips",
        withinMs: within,
      }),
    ).toBeNull();
    expect(
      mailbox.forkOpenDuplicate({
        senderAgentId: "vega",
        recipientAgentIds: ["shadow"],
        text: "Render the clips",
        withinMs: within,
        now: Date.now() + within + 60_000,
      }),
    ).toBeNull();
    // The teammate's reply closes it.
    await runCauseEffect(
      mailbox.enqueue({
        sender: { kind: "agent", agentId: "shadow" },
        recipientAgentIds: ["vega"],
        text: "Status: done",
        replyToMessageId: first.messageId,
        expectsReply: false,
      }),
    );
    expect(
      mailbox.forkOpenDuplicate({
        senderAgentId: "vega",
        recipientAgentIds: ["shadow"],
        text: "Render the clips",
        withinMs: within,
      }),
    ).toBeNull();
    // A failed delivery is not open either.
    const second = await send("vega", ["owl"], "Mix the sound");
    const deliveryId = second.deliveries[0]?.id ?? "";
    await runCauseEffect(mailbox.markStarting(deliveryId));
    await runCauseEffect(mailbox.markTerminal(deliveryId, "failed", "boom"));
    expect(
      mailbox.forkOpenDuplicate({
        senderAgentId: "vega",
        recipientAgentIds: ["owl"],
        text: "Mix the sound",
        withinMs: within,
      }),
    ).toBeNull();
    // An agent's own key.
    const key = forkSendKey("vega", "brief-7");
    expect(key).toBe("fork-send:vega:brief-7");
    const keyed = await send("vega", ["owl"], "Brief 7", true, key ?? "");
    expect(mailbox.forkSentWithKey(key ?? "")?.messageId).toBe(keyed.messageId);
    expect(() => forkSendKey("vega", "")).toThrow();
    expect(forkSendKey("vega", undefined)).toBeNull();
    expect(forkDuplicateSendResult({ messageId: "m", createdAt: "t", byKey: false }).note).toBe(
      "Not sent again: already sent at t (message m), still open — wait, or pass rework:true to send again.",
    );
    database.close();
  });

  it("queues a failed turn's deliveries again with their marker; the others start with the request", async () => {
    const { mailbox, database, send } = await mailboxOf();
    const request = await send("vega", ["shadow"], "fail-once: build the toolkit");
    const update = await send("vega", ["shadow"], "Use the new load guard", false);
    const requestId = request.deliveries[0]?.id ?? "";
    const updateId = update.deliveries[0]?.id ?? "";
    for (const id of [requestId, updateId]) {
      await runCauseEffect(mailbox.markStarting(id));
      await runCauseEffect(mailbox.markRunning(id, "turn-1"));
    }
    const marker = { turnId: "turn-1", reason: "connection reset by peer", at: new Date().toISOString() };
    await runCauseEffect(mailbox.forkRequeueForRetry(requestId, { ...marker, kind: "retry" }));
    await runCauseEffect(mailbox.forkRequeueForRetry(updateId, { ...marker, kind: "steered" }));
    expect(mailbox.getDelivery(requestId)?.delivery.status).toBe("queued");
    expect(mailbox.getDelivery(requestId)?.forkRetry?.kind).toBe("retry");
    expect(mailbox.forkRetryCompanions(requestId).map(({ delivery }) => delivery.id)).toEqual([updateId]);
    // The public delivery does not carry the marker.
    expect(Object.keys(mailbox.getDelivery(requestId)?.delivery ?? {})).not.toContain("forkRetry");
    database.close();
  });

  it("gives the sender one failure note that lists its other messages, or one note for updates only", async () => {
    const { mailbox, database, send } = await mailboxOf();
    const request = await send("vega", ["shadow"], "fail-always: build the toolkit");
    const requestId = request.deliveries[0]?.id ?? "";
    await runCauseEffect(mailbox.markStarting(requestId));
    await runCauseEffect(mailbox.markRunning(requestId, "turn-1"));
    await runCauseEffect(mailbox.markTerminal(requestId, "failed", "connection reset by peer"));
    const extra = forkListedMessages(
      [{ text: "Use the new load guard", createdAt: "2026-11-27T14:28:00.000Z" }],
      "Your other messages in that turn were not handled either:",
    );
    const noted = await runCauseEffect(
      mailbox.answerFailedRequest(
        requestId,
        () => false,
        () => true,
        false,
        true,
        extra,
      ),
    );
    expect(noted).toBe("vega");
    const updates = [
      await send("owl", ["shadow"], "Toolkit moved", false),
      await send("owl", ["shadow"], "Guardrail: max 2 renders", false),
    ].map((receipt) => receipt.deliveries[0]?.id ?? "");
    for (const id of updates) {
      await runCauseEffect(mailbox.markStarting(id));
      await runCauseEffect(mailbox.markRunning(id, "turn-1"));
      await runCauseEffect(mailbox.markTerminal(id, "failed", "connection reset by peer"));
    }
    expect(await runCauseEffect(mailbox.forkNoteUnhandled(updates, "connection reset by peer", () => true))).toBe(
      "owl",
    );
    // Again: the same note is not queued twice.
    await runCauseEffect(mailbox.forkNoteUnhandled(updates, "connection reset by peer", () => true));
    const notes = database.connection
      .prepare("SELECT text FROM projection_mailbox_messages WHERE sender_agent_id = 'shadow' ORDER BY created_at")
      .all()
      .map((row) => String(row.text));
    expect(notes).toHaveLength(2);
    expect(notes[0]).toContain(
      "Your other messages in that turn were not handled either:\n- 14:28 UTC: Use the new load guard",
    );
    expect(notes[1]).toContain("2 messages you sent into this teammate's running turn did not reach it");
    expect(notes[1]).toContain("- ");
    expect(notes[1]).toContain("Guardrail: max 2 renders");
    database.close();
  });
});
