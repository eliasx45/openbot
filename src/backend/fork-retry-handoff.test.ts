// Fork (docs/fork/FEATURES.md #106): a message hand-off that failed only because the provider was briefly
// down waits in the queue and starts once the provider is back. 25 Nov 2026: a watched WhatsApp line
// ("👁️ Ichiro Akiyama: Waiting on tapa …") was queued while the Claude CLI was being replaced; when
// OpenBot quit, the hold ended, the message started, the provider stopped under it ("Claude Agent SDK is
// not running.") and the delivery was marked failed for good. It never reached the orchestrator's chat.
// These tests run the real drain scheduler, mailbox, messaging threads, chat runtime and mailbox sync on
// a real database; only the provider, the provider threads and a few gates are stubs.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSummary } from "@openbot/contracts/ipc";
import { sourceText } from "@openbot/i18n/source";
import { Effect, Scope } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConversationRuntime } from "./agent/conversation-runtime";
import { DrainScheduler, type DrainSchedulerOptions } from "./agent/drain-scheduler";
import { FORK_HANDOFF_RETRY, ForkHandoffRetry, forkProviderDownAtStart } from "./agent/fork-handoff-retry";
import { MailboxSync } from "./agent/mailbox-sync";
import type { AgentClient } from "./agent-client";
import { ProviderStoppedError } from "./agent-client";
import { AgentStore } from "./agent-store";
import { runCauseEffect } from "./effect-boundary";
import { MailboxStore } from "./mailbox-store";
import { type MessagingActivity, MessagingThreads } from "./messaging/messaging-threads";
import { watchedTurnText } from "./messaging/whatsapp/whatsapp-watch-text";
import { OpenBotDatabase } from "./openbot-database";
import { ProviderSignInError } from "./provider-client-effects";

const AGENT_ID = "agent-desk";

/** A fake with only the members that the code under test calls. */
function fake<T>(value: unknown): T {
  // biome-ignore lint/nursery/noUnsafeTypeAssertion: the fake has only the members the code under test calls.
  return value as T;
}
const THREAD_ID = "openbot-thread-agent-desk";
const OWNER = "48600100200";
const SELF_CHAT = `${OWNER}@s.whatsapp.net`;
const ICHIRO = "819012345678";
const NOT_RUNNING = "Claude Agent SDK is not running.";

describe("which start failures wait for the provider", () => {
  it("waits for a provider that is briefly down", () => {
    expect(forkProviderDownAtStart(new Error(NOT_RUNNING), false)).toBe(true);
    expect(forkProviderDownAtStart(new Error("ACP client is not running."), false)).toBe(true);
    expect(forkProviderDownAtStart(new Error("Codex App Server is not running."), false)).toBe(true);
    expect(forkProviderDownAtStart(new Error("Codex App Server stopped."), false)).toBe(true);
    expect(forkProviderDownAtStart(new ProviderStoppedError("Codex", "gone"), false)).toBe(true);
    expect(
      forkProviderDownAtStart(new Error(sourceText("error.provider.cliNotReady", { provider: "Claude" })), false),
    ).toBe(true);
    expect(forkProviderDownAtStart(new Error(sourceText("error.provider.closing")), false)).toBe(true);
  });

  it("does not wait for real errors: sign-in, auth, limits, bad requests", () => {
    // The sign-in is really missing: the provider's "not ready" is not a short outage.
    expect(
      forkProviderDownAtStart(new Error(sourceText("error.provider.cliNotReady", { provider: "Claude" })), true),
    ).toBe(false);
    expect(forkProviderDownAtStart(new Error(NOT_RUNNING), true)).toBe(false);
    expect(forkProviderDownAtStart(new ProviderSignInError({ message: "Connect Claude to continue." }), false)).toBe(
      false,
    );
    expect(forkProviderDownAtStart(new Error("401 Unauthorized"), false)).toBe(false);
    expect(forkProviderDownAtStart(new Error("You've hit your usage limit. Resets 5pm."), false)).toBe(false);
    expect(forkProviderDownAtStart(new Error("Invalid request: unknown model."), false)).toBe(false);
    expect(forkProviderDownAtStart(new Error("Claude ended the turn with no answer."), false)).toBe(false);
    expect(forkProviderDownAtStart(new Error("Connection error."), false)).toBe(false);
    // A crash is not a short outage.
    expect(forkProviderDownAtStart(new Error("Codex App Server exited with code 1."), false)).toBe(false);
  });

  it("gives up after the retry cap or the give-up time", () => {
    let now = 0;
    const retry = new ForkHandoffRetry(() => now);
    for (let attempt = 1; attempt <= FORK_HANDOFF_RETRY.maxAttempts; attempt += 1)
      expect(retry.allow("capped")).toBe(true);
    expect(retry.allow("capped")).toBe(false);
    // The count starts again only for a new failure series.
    expect(retry.attempts("capped")).toBe(0);

    expect(retry.allow("timed")).toBe(true);
    now = FORK_HANDOFF_RETRY.giveUpMs - 1;
    expect(retry.allow("timed")).toBe(true);
    now = FORK_HANDOFF_RETRY.giveUpMs;
    expect(retry.allow("timed")).toBe(false);

    expect(retry.allow("started")).toBe(true);
    retry.forget("started");
    expect(retry.attempts("started")).toBe(0);
  });
});

/** The real store with one agent whose chat exists. Nothing is written to disk besides the database. */
class OneAgentStore extends AgentStore {
  readonly #agent: AgentSummary;

  constructor(root: string, database: OpenBotDatabase, agent: AgentSummary) {
    super(root, root, database);
    this.#agent = agent;
    this.getOrCreate = fake<AgentStore["getOrCreate"]>(() => Effect.succeed(this.#agent));
  }

  override list(): AgentSummary[] {
    return [this.#agent];
  }

  override get(id: string): AgentSummary | undefined {
    return id === this.#agent.id ? this.#agent : undefined;
  }

  override ensureThreadIdNow(): string {
    return THREAD_ID;
  }

  override ownsThread(threadId: string): boolean {
    return threadId === THREAD_ID;
  }
}

function agentSummary(): AgentSummary {
  return {
    id: AGENT_ID,
    provider: "claude",
    name: "WhatsApp Orchestrator",
    title: "Desk",
    description: "",
    notifications: true,
    model: "claude-sonnet-5-5",
    reasoningEffort: "medium",
    threadId: THREAD_ID,
    workspacePath: "/tmp/openbot-fork-106",
    preview: "",
    updatedAt: "2026-11-25T09:00:00.000Z",
    avatarSeed: "desk",
    avatarHue: null,
    avatarUrl: null,
  };
}

/** What the fake provider does on the next `turn/start` (or the provider start, for "client-down"). */
type Outcome = "ok" | "not-running" | "cli-not-ready" | "auth" | "bad-request" | "quit";

interface Harness {
  root: string;
  database: OpenBotDatabase;
  mailbox: MailboxStore;
  messaging: MessagingThreads;
  conversation: ConversationRuntime;
  scheduler: DrainScheduler;
  /** Provider state, changed by the tests. */
  provider: { replacing: boolean; ready: boolean; signInRequired: boolean; clientDown: Outcome | null };
  stopping: { value: boolean };
  outcomes: Outcome[];
  turnStarts: string[];
  activities: MessagingActivity[];
  settle(): Promise<void>;
}

const roots: string[] = [];
const databases: OpenBotDatabase[] = [];
const schedulers: DrainScheduler[] = [];
const savedLimits = { ...FORK_HANDOFF_RETRY };

beforeEach(() => {
  Object.assign(FORK_HANDOFF_RETRY, savedLimits);
});

afterEach(async () => {
  for (const scheduler of schedulers.splice(0)) scheduler.dispose();
  await new Promise((resolve) => setTimeout(resolve, 20));
  for (const database of databases.splice(0)) database.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function failure(outcome: Outcome): { cause: Error } {
  switch (outcome) {
    case "not-running":
    case "quit":
      return { cause: new Error(NOT_RUNNING) };
    case "cli-not-ready":
      return { cause: new Error(sourceText("error.provider.cliNotReady", { provider: "Claude" })) };
    case "auth":
      return { cause: new Error("401 Unauthorized") };
    default:
      return { cause: new Error("Invalid request: the prompt is malformed.") };
  }
}

async function setUp(existing?: { root: string; database: OpenBotDatabase }): Promise<Harness> {
  const root = existing?.root ?? (await mkdtemp(join(tmpdir(), "openbot-fork-106-")));
  if (!existing) roots.push(root);
  const database = existing?.database ?? new OpenBotDatabase(root);
  if (!existing) {
    databases.push(database);
    await runCauseEffect(database.initialize());
  }
  const agent = agentSummary();
  if (!existing) {
    database.replaceAgents("seed-fork-106", [agent], "agents.imported");
    const now = new Date().toISOString();
    database.connection
      .prepare("INSERT OR IGNORE INTO projection_threads VALUES (?, ?, ?, NULL, ?, ?, 0)")
      .run(THREAD_ID, AGENT_ID, "Desk", now, now);
  }
  const mailbox = new MailboxStore(root, join(root, "shared"), database);
  await runCauseEffect(mailbox.initialize());
  const store = new OneAgentStore(root, database, agent);
  const conversation = new ConversationRuntime(
    store,
    () => {},
    () => [agent],
  );
  const messaging = new MessagingThreads(database, mailbox, {
    schedule: () => {},
    queueChanged: () => {},
    busy: () => false,
    interrupt: () => Effect.void,
    forgetThread: () => Effect.void,
    ownChat: (threadId) => threadId === THREAD_ID,
    contextSession: () => null,
    progressUpdates: () => null,
    placement: {
      mainThread: () => THREAD_ID,
      isMainThread: (threadId) => threadId === THREAD_ID,
      isSideThread: () => false,
      sideThread: () => null,
      keepThread: () => {},
    },
  });
  const activities: MessagingActivity[] = [];
  messaging.onActivity((activity) => activities.push(activity));
  const scope = Effect.runSync(Scope.make());
  const mailboxSync = new MailboxSync({
    database,
    mailbox,
    conversation,
    routines: fake<DrainSchedulerOptions["routines"]>({ reconcileDelivery: () => false, stateChanged: () => {} }),
    scope: () => scope,
    hooks: { emit: () => {}, emitError: () => {}, queueHold: () => null, threadRequestsChanged: () => {} },
  });
  const provider: Harness["provider"] = { replacing: false, ready: true, signInRequired: false, clientDown: null };
  const stopping = { value: false };
  const outcomes: Outcome[] = [];
  const turnStarts: string[] = [];
  const client = fake<AgentClient>({ provider: "claude" });
  let turns = 0;
  const providers = {
    isReady: () => provider.ready,
    isReplacingCli: () => provider.replacing,
    agentClientCurrent: () => true,
    agentClientRunning: () => true,
    signInRequiredForAgent: () => provider.signInRequired,
    signInRequired: () => provider.signInRequired,
    ensureAgentClient: () => (provider.clientDown ? Effect.fail(failure(provider.clientDown)) : Effect.succeed(client)),
    status: () => ({ providers: [] }),
    accountModels: () => [],
    listModels: () => [],
    refreshProvider: () => Effect.void,
  };
  const threads = {
    applyPendingRuntimeRefresh: () => Effect.void,
    holdRuntimeRefresh: () => () => {},
    ensureThread: (_agent: unknown, _client: unknown, threadId?: string) => Effect.succeed(threadId ?? THREAD_ID),
    consumePendingHandoff: () => undefined,
    deletePendingHandoff: () => Effect.void,
    closeRoutineThread: () => Effect.void,
    requestWithArchivedThreadRecovery: (_agent: unknown, _client: unknown, method: string) => {
      const outcome = outcomes.shift() ?? "ok";
      if (method !== "turn/start") return Effect.fail({ cause: new Error(`unexpected ${method}`) });
      if (outcome === "quit") {
        // OpenBot quits while the turn starts: the provider stops under it.
        stopping.value = true;
        return Effect.fail(failure("not-running"));
      }
      if (outcome !== "ok") return Effect.fail(failure(outcome));
      turns += 1;
      const turnId = `turn-${turns}`;
      turnStarts.push(turnId);
      return Effect.succeed({ turn: { id: turnId } });
    },
  };
  const scheduler = new DrainScheduler({
    store,
    mailbox,
    mailboxSync,
    conversation,
    providers: fake<DrainSchedulerOptions["providers"]>(providers),
    duplication: fake<DrainSchedulerOptions["duplication"]>({ mayDrain: () => true }),
    profileSave: fake<DrainSchedulerOptions["profileSave"]>({ mayDrain: () => true }),
    compaction: fake<DrainSchedulerOptions["compaction"]>({
      heldThreads: () => [],
      expectInput: () => {},
      reserve: () => false,
    }),
    routines: fake<DrainSchedulerOptions["routines"]>({ mayDrain: () => true }),
    threads: fake<DrainSchedulerOptions["threads"]>(threads),
    memory: fake<DrainSchedulerOptions["memory"]>({
      turnLimit: () => 8,
      mayDrain: () => true,
      held: () => {},
      reserveTurn: () => () => {},
    }),
    usageLimits: fake<DrainSchedulerOptions["usageLimits"]>({
      mayDrain: () => true,
      mayTry: () => true,
      tryStarted: () => {},
      reached: () => Effect.void,
      failed: () => {},
    }),
    planContinuation: fake<DrainSchedulerOptions["planContinuation"]>({ claim: () => null, cancel: () => {} }),
    tasks: {
      threadId: () => null,
      openTaskIds: () => [],
      limit: () => 4,
      oneTurnAtATime: () => false,
      isRoutineThread: () => false,
      taskReport: () => null,
    },
    hooks: {
      emitError: () => {},
      isStopping: () => stopping.value,
      isDeleting: () => false,
      servesModel: () => true,
      redactMcp: (text) => text,
      tagReferences: () =>
        fake<ReturnType<DrainSchedulerOptions["hooks"]["tagReferences"]>>({ agents: [], threads: [] }),
      liveVoiceRelayed: () => null,
      requeueChannelDelivery: () => Effect.succeed(false),
      mayContinueOnBackup: () => false,
      mayFailOver: () => false,
      followUsageLimit: () => false,
      followPendingRuntime: () => false,
      turnEnded: () => false,
      staleTurnSettlement: () => null,
      orphanedDeliveryRecovery: () => null,
      turnRestarting: () => {},
      deliveriesStarting: () => {},
      startRequestedNewChat: () => Effect.void,
      dropRequestedNewChat: () => {},
      signInWait: () => {},
    },
    messaging,
  });
  schedulers.push(scheduler);
  const settle = async () => {
    for (let round = 0; round < 6; round += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      await Effect.runPromise(Effect.all(scheduler.pendingTasks(), { discard: true }).pipe(Effect.ignore));
    }
  };
  return {
    root,
    database,
    mailbox,
    messaging,
    conversation,
    scheduler,
    provider,
    stopping,
    outcomes,
    turnStarts,
    activities,
    settle,
  };
}

/** A watched WhatsApp line for the orchestrator, as `whatsapp-transport.ts` hands it over (fork #68/#76). */
async function receiveWatchedLine(harness: Harness, id: string): Promise<string> {
  const connection = harness.messaging.store.ensureConnection("whatsapp", OWNER, "Elias");
  const result = await runCauseEffect(
    harness.messaging.receive({
      connectionId: connection.connectionId,
      agentId: AGENT_ID,
      platformChannelId: SELF_CHAT,
      threadKey: "dm",
      isDirect: true,
      title: "Message yourself",
      text: watchedTurnText("Ichiro Akiyama", [
        { author: "Ichiro Akiyama", text: "Waiting on tapa for this, free account", sentAt: new Date().toISOString() },
      ]),
      sourcePaths: [],
      origin: { authorId: ICHIRO, authorName: "Ichiro Akiyama", platformMessageId: `watch:${id}` },
      idempotencyKey: `messaging:${connection.connectionId}:${id}`,
      placement: { kind: "main" },
    }),
  );
  if (result.status !== "queued") throw new Error(`not queued: ${result.status}`);
  return result.deliveryId;
}

function status(harness: Harness, deliveryId: string) {
  return harness.mailbox.getDelivery(deliveryId)?.delivery.status;
}

function threadLine(harness: Harness, deliveryId: string) {
  return harness.conversation.ensureSnapshot(AGENT_ID, THREAD_ID).messages.find((message) => message.id === deliveryId);
}

function storedLine(harness: Harness, deliveryId: string) {
  return harness.database
    .readConversationPage(AGENT_ID, THREAD_ID, { type: "latest" }, 100)
    .messages.find((message) => message.id === deliveryId);
}

function failedFinishes(harness: Harness) {
  return harness.activities.filter((activity) => activity.type === "finished" && activity.status === "failed");
}

describe("a hand-off whose provider was briefly down (real drain scheduler)", () => {
  it("stays queued while the CLI is replaced and runs once when the provider is back", async () => {
    const harness = await setUp();
    harness.provider.replacing = true;
    const deliveryId = await receiveWatchedLine(harness, "W1");
    harness.scheduler.scheduleDrain(AGENT_ID);
    await harness.settle();
    expect(status(harness, deliveryId)).toBe("queued");
    expect(harness.turnStarts).toEqual([]);

    harness.provider.replacing = false;
    harness.scheduler.scheduleDrain(AGENT_ID); // what onProviderResumed does
    await harness.settle();
    expect(status(harness, deliveryId)).toBe("running");
    expect(harness.turnStarts).toEqual(["turn-1"]);
    expect(failedFinishes(harness)).toEqual([]);
  });

  it("puts a start that the stopped SDK refused back in the queue, then runs it once", async () => {
    const harness = await setUp();
    harness.outcomes.push("not-running");
    const deliveryId = await receiveWatchedLine(harness, "W1");
    harness.scheduler.scheduleDrain(AGENT_ID);
    await harness.settle();
    // Before #106: "failed", "Claude Agent SDK is not running.", and a failure note to WhatsApp.
    expect(status(harness, deliveryId)).toBe("queued");
    expect(harness.mailbox.getDelivery(deliveryId)?.delivery.error ?? null).toBeNull();
    expect(failedFinishes(harness)).toEqual([]);
    expect(threadLine(harness, deliveryId)?.delivery?.status).toBe("queued");
    // The lane holds: rescheduling inside the scheduler does not loop.
    expect(harness.turnStarts).toEqual([]);

    harness.scheduler.scheduleDrain(AGENT_ID); // the provider is back
    await harness.settle();
    expect(status(harness, deliveryId)).toBe("running");
    expect(harness.turnStarts).toEqual(["turn-1"]);
    expect(threadLine(harness, deliveryId)?.delivery?.status).toBe("running");
    expect(threadLine(harness, deliveryId)?.status).not.toBe("failed");
    harness.scheduler.scheduleDrain(AGENT_ID);
    await harness.settle();
    expect(harness.turnStarts).toEqual(["turn-1"]);
  });

  it("waits when the provider could not start (CLI not ready) and runs once it starts", async () => {
    const harness = await setUp();
    harness.provider.clientDown = "cli-not-ready";
    const deliveryId = await receiveWatchedLine(harness, "W1");
    harness.scheduler.scheduleDrain(AGENT_ID);
    await harness.settle();
    expect(status(harness, deliveryId)).toBe("queued");
    harness.provider.clientDown = null;
    harness.scheduler.scheduleDrain(AGENT_ID);
    await harness.settle();
    expect(status(harness, deliveryId)).toBe("running");
    expect(harness.turnStarts).toEqual(["turn-1"]);
  });

  it("gives up after the cap: the line shows failed in the orchestrator's chat and the owner is told", async () => {
    FORK_HANDOFF_RETRY.maxAttempts = 2;
    const harness = await setUp();
    // The provider never starts, so the line never reached the chat before it failed.
    harness.provider.clientDown = "not-running";
    const deliveryId = await receiveWatchedLine(harness, "W1");
    for (let attempt = 0; attempt < 3; attempt += 1) {
      harness.scheduler.scheduleDrain(AGENT_ID);
      await harness.settle();
    }
    expect(status(harness, deliveryId)).toBe("failed");
    expect(harness.mailbox.getDelivery(deliveryId)?.delivery.error).toBe(NOT_RUNNING);
    const line = threadLine(harness, deliveryId);
    expect(line?.status).toBe("failed");
    expect(line?.delivery?.status).toBe("failed");
    expect(line?.text).toContain("👁️ Ichiro Akiyama: Waiting on tapa");
    // Saved, so it is there after a restart and in the renderer's pages.
    expect(storedLine(harness, deliveryId)?.status).toBe("failed");
    // The owner's "Message yourself" chat gets the failure (the link's target is the self chat, never
    // the watched contact; the watch guard in whatsapp-session refuses that chat anyway).
    const finished = failedFinishes(harness);
    expect(finished).toHaveLength(1);
    expect(finished[0]?.link.platformChannelId).toBe(SELF_CHAT);
    expect(harness.turnStarts).toEqual([]);
  });

  it("marks a line that failed after it reached the chat as failed, not 'starting'", async () => {
    FORK_HANDOFF_RETRY.maxAttempts = 1;
    const harness = await setUp();
    harness.outcomes.push("not-running", "not-running");
    const deliveryId = await receiveWatchedLine(harness, "W1");
    harness.scheduler.scheduleDrain(AGENT_ID);
    await harness.settle();
    expect(status(harness, deliveryId)).toBe("queued");
    harness.scheduler.scheduleDrain(AGENT_ID);
    await harness.settle();
    expect(status(harness, deliveryId)).toBe("failed");
    expect(threadLine(harness, deliveryId)?.status).toBe("failed");
    expect(storedLine(harness, deliveryId)?.delivery?.status).toBe("failed");
  });

  it("still fails at once for real errors (auth, bad request, sign-in missing)", async () => {
    for (const outcome of ["auth", "bad-request"] as const) {
      const harness = await setUp();
      harness.outcomes.push(outcome);
      const deliveryId = await receiveWatchedLine(harness, "W1");
      harness.scheduler.scheduleDrain(AGENT_ID);
      await harness.settle();
      expect(status(harness, deliveryId)).toBe("failed");
      expect(failedFinishes(harness)).toHaveLength(1);
      expect(harness.turnStarts).toEqual([]);
    }
    const harness = await setUp();
    harness.provider.signInRequired = true;
    harness.provider.clientDown = "cli-not-ready";
    const deliveryId = await receiveWatchedLine(harness, "W1");
    harness.scheduler.scheduleDrain(AGENT_ID);
    await harness.settle();
    expect(status(harness, deliveryId)).toBe("failed");
  });

  it("keeps a line that OpenBot's quit interrupted, and runs it after a restart", async () => {
    const first = await setUp();
    // The CLI update ended at quit, the line started, and the provider stopped under it.
    first.outcomes.push("quit");
    const deliveryId = await receiveWatchedLine(first, "W1");
    first.scheduler.scheduleDrain(AGENT_ID);
    await first.settle();
    expect(first.stopping.value).toBe(true);
    expect(status(first, deliveryId)).toBe("queued");
    expect(failedFinishes(first)).toEqual([]);
    expect(first.turnStarts).toEqual([]);
    first.scheduler.dispose();

    // The next start: a new mailbox, messaging threads and scheduler on the same database.
    const second = await setUp({ root: first.root, database: first.database });
    expect(status(second, deliveryId)).toBe("queued");
    second.scheduler.scheduleDrain(AGENT_ID);
    await second.settle();
    expect(status(second, deliveryId)).toBe("running");
    expect(second.turnStarts).toEqual(["turn-1"]);
  });
});
