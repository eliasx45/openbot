// @vitest-environment node
// Fork (docs/fork/FEATURES.md #131): after OpenBot ends a hung provider, the agent's chat resumes by
// itself (a wait that wakes it once it is idle, with the jobs that still run), and a teammate whose
// request that turn held gets a "⏳ continues by itself" note instead of a failure.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSummary } from "@openbot/contracts/ipc";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentWaitStore } from "./agent-waits/agent-wait-store";
import { ForkWaitConditions, type ProviderRestartInput } from "./agent-waits/fork-wait-conditions";
import { runCauseEffect } from "./effect-boundary";
import { MailboxStore } from "./mailbox-store";
import { OpenBotDatabase } from "./openbot-database";

const agent = (id: string, name: string): AgentSummary => ({
  id,
  provider: "antigravity",
  name,
  title: "",
  description: "",
  notifications: true,
  model: "gemini-3-pro",
  reasoningEffort: "medium",
  threadId: `openbot-thread-${id}`,
  workspacePath: `/tmp/openbot-${id}`,
  preview: "",
  updatedAt: "2026-11-27T00:00:00.000Z",
  avatarSeed: id,
  avatarHue: null,
  avatarUrl: null,
});
const CHOPPER = agent("chopper", "Chopper");
const VEGA = agent("vega", "Vegapunk");

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "openbot-restart-resume-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const database = new OpenBotDatabase(root);
  await runCauseEffect(database.initialize());
  database.replaceAgents("seed", [CHOPPER, VEGA], "agents.updated");
  const store = new AgentWaitStore({ database });
  const mailbox = new MailboxStore(root, join(root, "shared"), database);
  await runCauseEffect(mailbox.initialize());
  const wakes: { agentId: string; waitId: string; title: string; text: string }[] = [];
  const state = { busy: true, asked: 0 };
  const conditions = new ForkWaitConditions({
    store,
    mailbox,
    databasePath: join(root, "openbot.db"),
    hooks: {
      emit: () => {},
      requireKnownAgent: () => {},
      agentName: (id) => (id === CHOPPER.id ? CHOPPER.name : VEGA.name),
      agentBusy: () => {
        state.asked += 1;
        return state.busy;
      },
      wake: (input) => wakes.push(input),
      notify: () => {},
      isRunning: () => true,
    },
  });
  cleanups.push(() => conditions.dispose());
  return { store, mailbox, conditions, wakes, state };
}

const input = (overrides: Partial<ProviderRestartInput> = {}): ProviderRestartInput => ({
  agentId: CHOPPER.id,
  turnId: "turn-1",
  requestMessageId: "delivery-1",
  requestText: "Run the ablation and report the table.",
  error: "Gemini did not answer in time, so OpenBot ended its process.",
  restart: {
    provider: "Antigravity",
    outcome: "failed",
    silentMinutes: 10,
    running: [{ pid: 4242, command: "python ablation.py --seeds 5" }],
    ended: [{ pid: 4243, command: "tail -f ablation.log" }],
    teammateRequests: [{ messageId: "message-7", requesterName: "Vegapunk" }],
  },
  ...overrides,
});

describe("provider restart resume (fork #131)", () => {
  it("wakes the agent in its own chat once it is idle, naming the jobs that still run", async () => {
    const { store, conditions, wakes, state } = await setup();
    const waitId = conditions.openProviderRestartResume(input());
    expect(waitId).not.toBeNull();
    expect(store.list(CHOPPER.id).map((wait) => wait.note)).toEqual([
      "🔄 Provider restarted by OpenBot · resumes by itself",
    ]);
    // A completed turn of the agent does not close it: the agent must still be told.
    conditions.closeNetworkResumes(CHOPPER.id);
    expect(store.list(CHOPPER.id)).toHaveLength(1);
    // Checked while the agent works, and no wake yet.
    await vi.waitFor(() => expect(state.asked).toBeGreaterThanOrEqual(2), { timeout: 8_000, interval: 100 });
    expect(wakes).toHaveLength(0);
    state.busy = false;
    await vi.waitFor(() => expect(wakes).toHaveLength(1), { timeout: 8_000, interval: 100 });
    const [wake] = wakes;
    expect(wake?.waitId).toBe(waitId);
    expect(wake?.title).toBe("🔄 Provider restarted: continue");
    expect(wake?.text).toContain("[OpenBot: 🔄 provider restarted]");
    expect(wake?.text).toContain("showed no progress for 10 min");
    expect(wake?.text).toContain("Do not start them again");
    expect(wake?.text).toContain("pid 4242: python ablation.py --seeds 5");
    expect(wake?.text).toContain("pid 4243: tail -f ablation.log");
    expect(wake?.text).toContain("Run the ablation and report the table.");
    expect(wake?.text).toContain("Do not restart jobs that are still alive.");
    expect(wake?.text).toContain("Vegapunk asked for this (message message-7)");
    expect(store.list(CHOPPER.id)).toHaveLength(0);
  }, 20_000);

  it("keeps an answered turn's answer and shares the network resume's limit of 3 an hour", async () => {
    const { conditions, wakes, state } = await setup();
    state.busy = false;
    const now = Date.now();
    const completed = input({ restart: { ...input().restart, outcome: "completed", running: [], ended: [] } });
    // One open restart wait per agent: a second hang joins it.
    const first = conditions.openProviderRestartResume(completed, now);
    expect(conditions.openProviderRestartResume(completed, now)).toBe(first);
    await vi.waitFor(() => expect(wakes).toHaveLength(1), { timeout: 8_000, interval: 100 });
    expect(wakes[0]?.text).toContain("Your answer of that turn was kept.");
    expect(wakes[0]?.text).not.toContain("Do not start them again");
    expect(
      conditions.openNetworkResume(
        {
          agentId: CHOPPER.id,
          turnId: "t",
          error: "fetch failed",
          requestMessageId: null,
          requestText: null,
          probeUrl: "http://127.0.0.1:9/",
        },
        now + 1,
      ),
    ).not.toBeNull();
    conditions.closeNetworkResumes(CHOPPER.id);
    expect(conditions.openProviderRestartResume(input(), now + 2)).not.toBeNull();
    await vi.waitFor(() => expect(wakes).toHaveLength(2), { timeout: 8_000, interval: 100 });
    expect(conditions.openProviderRestartResume(input(), now + 3)).toBeNull();
    expect(conditions.openProviderRestartResume(input(), now + 61 * 60_000)).not.toBeNull();
  }, 30_000);

  it("gives the requester one ⏳ note, not a reply, and still allows the failure note later", async () => {
    const { mailbox } = await setup();
    const receipt = await runCauseEffect(
      mailbox.enqueue({
        sender: { kind: "agent", agentId: VEGA.id },
        recipientAgentIds: [CHOPPER.id],
        text: "Run the ablation and report the table.",
        replyToMessageId: null,
        expectsReply: true,
      }),
    );
    const deliveryId = receipt.deliveries[0]?.id ?? "";
    const exists = (id: string) => id === CHOPPER.id || id === VEGA.id;
    expect(await runCauseEffect(mailbox.noteProviderRestart(deliveryId, CHOPPER.name, exists))).toBe(VEGA.id);
    await runCauseEffect(mailbox.noteProviderRestart(deliveryId, CHOPPER.name, exists));
    const toVega = () => mailbox.listQueue(VEGA.id).deliveries.map((delivery) => delivery.text);
    expect(toVega()).toHaveLength(1);
    expect(toVega()[0]).toContain(
      "⏳ Chopper's provider was restarted by OpenBot; it continues by itself — don't resend or restart it.",
    );
    expect(mailbox.hasReplyFrom(CHOPPER.id, receipt.messageId)).toBe(false);
    // The resume failed: the failure note still goes out.
    await runCauseEffect(mailbox.markStarting(deliveryId));
    await runCauseEffect(mailbox.markRunning(deliveryId, "turn-1"));
    await runCauseEffect(mailbox.markTerminal(deliveryId, "failed", "Gemini did not answer in time."));
    expect(await runCauseEffect(mailbox.answerFailedRequest(deliveryId, () => false, exists, false, true))).toBe(
      VEGA.id,
    );
    expect(toVega().some((text) => text.startsWith("Status: blocked"))).toBe(true);
  });
});
