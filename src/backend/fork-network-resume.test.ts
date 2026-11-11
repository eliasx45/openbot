// @vitest-environment node
// Fork (docs/fork/FEATURES.md #69, "Agents ride out a network drop"): a turn that a network error ended
// opens a wait that probes the provider; once it answers, a turn in the agent's own chat continues the
// work and relaunches the background subagents the drop ended. The CLI side (15 retries) is checked by
// `bun scripts/fork-network-drop-e2e.ts`, which drops a real Claude CLI's connection.

import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSummary } from "@openbot/contracts/ipc";
import { classifyFailure } from "@openbot/telemetry";
import { afterEach, describe, expect, it, vi } from "vitest";
import { forkNetworkDrop } from "./agent/turn-lifecycle";
import { AgentWaitStore } from "./agent-waits/agent-wait-store";
import { ForkWaitConditions, forkNetworkProbeUrl } from "./agent-waits/fork-wait-conditions";
import { runCauseEffect } from "./effect-boundary";
import { MailboxStore } from "./mailbox-store";
import { OpenBotDatabase } from "./openbot-database";

const AGENT: AgentSummary = {
  id: "adrian",
  provider: "claude",
  name: "Adrien Lead",
  title: "Lead",
  description: "",
  notifications: true,
  model: "claude-opus-5-5",
  reasoningEffort: "medium",
  threadId: "openbot-thread-adrian",
  workspacePath: "/tmp/openbot-adrian",
  preview: "",
  updatedAt: "2026-11-11T00:00:00.000Z",
  avatarSeed: "adrian",
  avatarHue: null,
  avatarUrl: null,
};

/** The text the CLI ended Adrian's turns with on 11 Nov 2026 (session d7c57a9e, 23:44:36Z). */
const DROP =
  "API Error: Connection dropped (ECONNRESET). A VPN, firewall, or security software can cause this. Check those or switch networks, then try again.";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "openbot-net-resume-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const database = new OpenBotDatabase(root);
  await runCauseEffect(database.initialize());
  database.replaceAgents("seed", [AGENT], "agents.updated");
  const store = new AgentWaitStore({ database });
  const mailbox = new MailboxStore(root, join(root, "shared"), database);
  await runCauseEffect(mailbox.initialize());
  const wakes: { agentId: string; waitId: string; title: string; text: string }[] = [];
  const notes: string[] = [];
  const make = () => {
    const conditions = new ForkWaitConditions({
      store,
      mailbox,
      databasePath: join(root, "openbot.db"),
      hooks: {
        emit: () => {},
        requireKnownAgent: () => {},
        agentName: () => AGENT.name,
        agentBusy: () => false,
        wake: (input) => wakes.push(input),
        notify: (title) => notes.push(title),
        isRunning: () => true,
      },
    });
    cleanups.push(() => conditions.dispose());
    return conditions;
  };
  return { store, wakes, notes, make, root };
}

/** A probe target that answers 503 (the provider is not back) until `up()`, and logs when it was asked. */
async function probe() {
  const state: { up: boolean; hits: number[] } = { up: false, hits: [] };
  const server = createServer((_request, response) => {
    state.hits.push(Date.now());
    response.writeHead(state.up ? 404 : 503).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/`,
    hits: state.hits,
    up: () => {
      state.up = true;
    },
  };
}

describe("network resume", () => {
  it("reads the CLI's dropped-connection error as a network failure", () => {
    expect(classifyFailure(DROP)).toBe("network");
    expect(forkNetworkProbeUrl("claude")).toBe(
      process.env.ANTHROPIC_BASE_URL ? expect.any(String) : "https://api.anthropic.com/",
    );
  });

  it("resumes only a failed turn that a network or timeout error ended", () => {
    expect(forkNetworkDrop("failed", DROP, undefined)).toBe(DROP);
    expect(forkNetworkDrop("failed", undefined, "fetch failed")).toBe("fetch failed");
    expect(forkNetworkDrop("failed", "Request timed out", undefined)).toBe("Request timed out");
    expect(forkNetworkDrop("completed", DROP, undefined)).toBeNull();
    expect(forkNetworkDrop("interrupted", DROP, undefined)).toBeNull();
    expect(forkNetworkDrop("failed", "API Error: 401 authentication_error", undefined)).toBeNull();
    expect(
      forkNetworkDrop(
        "failed",
        "Claude Code can't use your Claude subscription, usually because a payment is past due",
        undefined,
      ),
    ).toBeNull();
    expect(forkNetworkDrop("failed", undefined, undefined)).toBeNull();
  });

  it("waits while the provider is unreachable, then wakes the agent once to continue and relaunch subagents", async () => {
    const { store, wakes, notes, make } = await setup();
    const target = await probe();
    const conditions = make();
    const opened = Date.now() - 60_000;
    const waitId = conditions.openNetworkResume(
      {
        agentId: AGENT.id,
        turnId: "turn-1",
        error: DROP,
        requestMessageId: null,
        requestText: null,
        probeUrl: target.url,
      },
      opened,
    );
    expect(waitId).not.toBeNull();
    expect(store.list(AGENT.id).map((wait) => wait.note)).toEqual([expect.stringContaining("🔌 Network dropped")]);
    // Not back yet: the probe is asked and nothing wakes.
    await vi.waitFor(() => expect(target.hits.length).toBeGreaterThan(0), { timeout: 8_000 });
    expect(wakes).toHaveLength(0);
    target.up();
    await vi.waitFor(() => expect(wakes).toHaveLength(1), { timeout: 15_000, interval: 100 });
    const [wake] = wakes;
    expect(wake?.title).toBe("🔌 Network back: continue");
    expect(wake?.text).toContain("network back");
    expect(wake?.text).toContain("ECONNRESET");
    expect(wake?.text).toContain("SendMessage");
    expect(wake?.text).toContain("the provider started this turn itself");
    expect(store.list(AGENT.id)).toHaveLength(0);
    expect(notes).toEqual(["Adrien Lead: network back, resuming"]);
  }, 30_000);

  it("does not probe before the settle time, and carries the request it continues", async () => {
    const { wakes, make } = await setup();
    const target = await probe();
    target.up();
    const conditions = make();
    // Opened 27 s ago: the 30 s settle ends in 3 s.
    const settledAt = Date.now() + 3_000;
    conditions.openNetworkResume(
      {
        agentId: AGENT.id,
        turnId: "turn-1",
        error: DROP,
        requestMessageId: "delivery-1",
        requestText: "Build the $30k batch",
        probeUrl: target.url,
      },
      settledAt - 30_000,
    );
    await vi.waitFor(() => expect(wakes).toHaveLength(1), { timeout: 10_000, interval: 100 });
    expect(target.hits[0]).toBeGreaterThanOrEqual(settledAt);
    expect(wakes[0]?.text).toContain("Build the $30k batch");
  }, 15_000);

  it("opens one wait at a time, at most 3 an hour, and a completed turn closes it", async () => {
    const { store, make } = await setup();
    const conditions = make();
    const input = {
      agentId: AGENT.id,
      turnId: "t",
      error: DROP,
      requestMessageId: null,
      requestText: null,
      probeUrl: "http://127.0.0.1:9/",
    };
    const now = Date.now();
    expect(conditions.openNetworkResume(input, now)).not.toBeNull();
    expect(conditions.openNetworkResume(input, now)).toBeNull();
    conditions.closeNetworkResumes(AGENT.id);
    expect(store.list(AGENT.id)).toHaveLength(0);
    expect(conditions.openNetworkResume(input, now + 1)).not.toBeNull();
    conditions.closeNetworkResumes(AGENT.id);
    expect(conditions.openNetworkResume(input, now + 2)).not.toBeNull();
    conditions.closeNetworkResumes(AGENT.id);
    expect(conditions.openNetworkResume(input, now + 3)).toBeNull();
    expect(conditions.openNetworkResume(input, now + 61 * 60_000)).not.toBeNull();
  });

  it("survives a restart", async () => {
    const { store, make } = await setup();
    const first = make();
    const waitId = first.openNetworkResume({
      agentId: AGENT.id,
      turnId: "t",
      error: DROP,
      requestMessageId: null,
      requestText: null,
      probeUrl: "http://127.0.0.1:9/",
    });
    first.dispose();
    const second = make();
    expect(waitId && second.isWatched(waitId)).toBe(true);
    second.closeNetworkResumes(AGENT.id);
    expect(store.list(AGENT.id)).toHaveLength(0);
  });
});
