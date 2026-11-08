// @vitest-environment node

import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSummary, ChannelTask } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChannelImages } from "./channel-images";
import { ChannelService } from "./channel-service";
import type { ChannelAssignment } from "./channel-store";
import { runCauseEffect } from "./effect-boundary";
import { MailboxStore } from "./mailbox-store";
import { OpenBotDatabase } from "./openbot-database";

/**
 * Fork (docs/fork/FEATURES.md, "Background work stays open and reaches the phone"): a channel task
 * whose turn ended while its background subagents work stays open, the provider's report turn is the
 * task's, and a stopped task does not reopen.
 */

const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const LEAD: AgentSummary = {
  id: "lead",
  provider: "claude",
  name: "Tapa Lead",
  title: "Lead",
  description: "",
  notifications: true,
  model: "claude-opus-5-5",
  reasoningEffort: "medium",
  threadId: "openbot-thread-lead",
  workspacePath: "/tmp/openbot-lead",
  preview: "",
  updatedAt: "2026-11-08T10:00:00.000Z",
  avatarSeed: "lead",
  avatarHue: null,
  avatarUrl: null,
};

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "openbot-subagent-wait-"));
  roots.push(root);
  const database = new OpenBotDatabase(root);
  await runCauseEffect(database.initialize());
  database.replaceAgents("seed", [LEAD], "agents.updated");
  const mailbox = new MailboxStore(root, join(root, "shared"), database);
  await runCauseEffect(mailbox.initialize());
  const running = new Set<string>();
  const service = new ChannelService(database, mailbox, new ChannelImages(join(root, "images")), {
    agents: () => [LEAD],
    generate: () => Effect.die(new Error("No model in this test.")),
    schedule: () => {},
    interrupt: () => Effect.void,
    busy: () => true,
    changed: () => {},
    error: (error) => {
      throw error;
    },
    subagentsRunning: (_agentId, turnId) => running.has(turnId),
  });
  const channelId = randomUUID();
  const channel = service.store.create(channelId, {
    name: "editors",
    title: "Editors",
    instructions: "",
    members: [{ agentId: LEAD.id }],
    leadAgentId: LEAD.id,
  });
  service.store.update(channel);
  const { threadId } = service.store.context(channelId, LEAD.id);
  const task: ChannelTask = {
    id: randomUUID(),
    channelId,
    parentTaskId: null,
    rootTaskId: "",
    ownerAgentId: LEAD.id,
    requestMessageId: randomUUID(),
    instruction: "Cut the video.",
    attachmentDraftIds: [],
    expectedResult: "",
    sourceMessageIds: [],
    dependencies: [],
    resources: [],
    state: "running",
    revision: 1,
    assignmentCount: 1,
    error: null,
  };
  task.rootTaskId = task.id;
  const assignment: ChannelAssignment = {
    id: randomUUID(),
    channelId,
    taskId: task.id,
    agentId: LEAD.id,
    taskRevision: 1,
    requestMessageId: task.requestMessageId,
    resources: [],
    deliveryId: null,
    turnId: "turn-1",
    state: "running",
    throughSequence: 0,
    summaryVersion: 0,
    awaitedTaskIds: [],
    pendingRevision: null,
    pendingOutcome: null,
  };
  service.store.update(service.store.get(channelId), { tasks: [task], assignments: [assignment] });
  const taskNow = () => service.store.task(channelId, task.id);
  const end = (turnId: string) =>
    service.event({ type: "turn-completed", agentId: LEAD.id, threadId, turnId, status: "completed" });
  const subagentsEnded = (turnId: string) =>
    service.event({
      type: "subagents-ended",
      agentId: LEAD.id,
      threadId,
      turnId,
      subagents: [{ id: "toolu_1", title: "Find B-roll", status: "completed" }],
      running: false,
    });
  const unprompted = (turnId: string) =>
    service.event({ type: "turn-started", agentId: LEAD.id, threadId, turnId, origin: "unknown" });
  return { service, channelId, threadId, running, taskNow, end, subagentsEnded, unprompted };
}

describe("a channel task with background subagents", () => {
  it("completes as before when no subagent works on", async () => {
    const { taskNow, end } = await setup();
    end("turn-1");
    await vi.waitFor(() => expect(taskNow()?.state).toBe("completed"));
    expect(taskNow()?.waitingFor).toBeUndefined();
  });

  it("waits for its subagents, takes the report turn, and completes at its end", async () => {
    const { service, channelId, running, taskNow, end, subagentsEnded, unprompted } = await setup();
    running.add("turn-1");
    end("turn-1");
    await vi.waitFor(() => expect(taskNow()?.state).toBe("waiting"));
    expect(taskNow()?.waitingFor).toBe("subagents");

    running.delete("turn-1");
    expect(subagentsEnded("turn-1")).toBe(false);
    unprompted("turn-2");
    expect(taskNow()?.state).toBe("running");
    const report = service.store.assignments(channelId).find((item) => item.turnId === "turn-2");
    expect(report?.taskId).toBe(taskNow()?.id);
    expect(report?.state).toBe("running");

    end("turn-2");
    await vi.waitFor(() => expect(taskNow()?.state).toBe("completed"));
    expect(taskNow()?.waitingFor).toBeUndefined();
    // A later turn of the provider is no task's: nothing waits any more.
    unprompted("turn-3");
    expect(service.store.assignments(channelId).some((item) => item.turnId === "turn-3")).toBe(false);
  });

  it("waits again when the report turn ends while other subagents still work", async () => {
    const { running, taskNow, end, subagentsEnded, unprompted } = await setup();
    running.add("turn-1");
    end("turn-1");
    await vi.waitFor(() => expect(taskNow()?.state).toBe("waiting"));
    // One of two ended; Claude reports it in a turn of its own.
    subagentsEnded("turn-1");
    unprompted("turn-2");
    expect(taskNow()?.state).toBe("running");
    end("turn-2");
    await vi.waitFor(() => expect(taskNow()?.state).toBe("waiting"));
    expect(taskNow()?.waitingFor).toBe("subagents");
  });

  it("does not reopen a task that was stopped while it waited", async () => {
    const { service, channelId, running, taskNow, end, subagentsEnded, unprompted } = await setup();
    running.add("turn-1");
    end("turn-1");
    await vi.waitFor(() => expect(taskNow()?.state).toBe("waiting"));
    const waiting = taskNow();
    if (!waiting) throw new Error("No task.");
    service.store.update(service.store.get(channelId), { tasks: [{ ...waiting, state: "cancelled" }] });
    running.delete("turn-1");
    subagentsEnded("turn-1");
    unprompted("turn-2");
    expect(taskNow()?.state).toBe("cancelled");
    expect(service.store.assignments(channelId).some((item) => item.turnId === "turn-2")).toBe(false);
  });

  it("closes the task when no report turn comes after the last subagent ended", async () => {
    const { running, taskNow, end, subagentsEnded } = await setup();
    running.add("turn-1");
    end("turn-1");
    await vi.waitFor(() => expect(taskNow()?.state).toBe("waiting"));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    running.delete("turn-1");
    subagentsEnded("turn-1");
    vi.advanceTimersByTime(3 * 60_000);
    vi.useRealTimers();
    await vi.waitFor(() => expect(taskNow()?.state).toBe("completed"));
  });
});
