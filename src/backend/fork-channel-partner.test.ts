// @vitest-environment node
// Fork (docs/fork/FEATURES.md #107): in a channel turn that a remote member started, the agents keep to
// that member's reach, a member cannot change the channel through its agents, and the turn's final
// answer goes to the channel's outbound webhook.

import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentAccessLevel, AgentSummary, ChannelMessage, ChannelTask } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { forkChannelTaskPeople, forkReachableAgents } from "./agent/fork-channel-reach";
import { ChannelImages } from "./channel-images";
import { ChannelService } from "./channel-service";
import type { ChannelAssignment } from "./channel-store";
import { runCauseEffect } from "./effect-boundary";
import { forkHub } from "./fork-hub";
import { MailboxStore } from "./mailbox-store";
import { OpenBotDatabase } from "./openbot-database";

const roots: string[] = [];
afterEach(async () => {
  forkHub.channelWebhooks = null;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function agent(id: string, name: string): AgentSummary {
  return {
    id,
    provider: "codex",
    name,
    title: name,
    description: "",
    notifications: true,
    model: "gpt-6-luna",
    reasoningEffort: "medium",
    threadId: `openbot-thread-${id}`,
    workspacePath: `/tmp/openbot-${id}`,
    preview: "",
    updatedAt: "2026-11-25T10:00:00.000Z",
    avatarSeed: id,
    avatarHue: null,
    avatarUrl: null,
  };
}

const TRAF = agent("traf", "Traf");
const NAMI = agent("nami", "Nami");
const ICHIRO = agent("ichiro", "Ichiro");
const PARTNER = { id: "member-partner", name: "Partner" };

async function setup(options: { remote: boolean; admin: boolean }) {
  const root = await mkdtemp(join(tmpdir(), "openbot-fork-107-channel-"));
  roots.push(root);
  const database = new OpenBotDatabase(root);
  await runCauseEffect(database.initialize());
  database.replaceAgents("seed", [TRAF, NAMI, ICHIRO], "agents.updated");
  const mailbox = new MailboxStore(root, join(root, "shared"), database);
  await runCauseEffect(mailbox.initialize());
  const levels: Record<string, AgentAccessLevel> = { traf: "none", nami: "none", ichiro: "none" };
  const service = new ChannelService(database, mailbox, new ChannelImages(join(root, "images")), {
    agents: () => [TRAF, NAMI, ICHIRO],
    generate: () => Effect.die(new Error("No model in this test.")),
    schedule: () => {},
    interrupt: () => Effect.void,
    busy: () => true,
    changed: () => {},
    error: (error) => {
      throw error;
    },
    remotePerson: (personId) => options.remote && personId === PARTNER.id,
    personCanAdminister: () => options.admin,
    personAgentLevel: (_personId, agentId) => levels[agentId] ?? "none",
  });
  const channelId = randomUUID();
  service.store.update(
    service.store.create(channelId, {
      name: "agency",
      title: "Agency",
      instructions: "Be kind.",
      members: [{ agentId: TRAF.id }, { agentId: NAMI.id }],
      leadAgentId: TRAF.id,
    }),
  );
  const { threadId } = service.store.context(channelId, TRAF.id);
  const request: ChannelMessage = {
    id: randomUUID(),
    channelId,
    sequence: 0,
    author: { kind: "member", id: PARTNER.id, name: PARTNER.name },
    taskId: null,
    superseded: false,
    message: {
      id: randomUUID(),
      author: "user",
      text: "@Traf cut the video",
      createdAt: "2026-11-25T10:00:00.000Z",
      status: "completed",
    },
  };
  const task: ChannelTask = {
    id: randomUUID(),
    channelId,
    parentTaskId: null,
    rootTaskId: "",
    ownerAgentId: TRAF.id,
    requestMessageId: request.id,
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
    agentId: TRAF.id,
    taskRevision: 1,
    requestMessageId: task.requestMessageId,
    resources: [],
    deliveryId: "delivery-1",
    turnId: "turn-1",
    state: "running",
    throughSequence: 0,
    summaryVersion: 0,
    awaitedTaskIds: [],
    pendingRevision: null,
    pendingOutcome: null,
  };
  service.store.update(service.store.get(channelId), {
    messages: [request],
    tasks: [task],
    assignments: [assignment],
  });
  return { service, channelId, threadId, task };
}

describe("fork #107 channel turns of a remote member", () => {
  it("finds the remote member of the task from its delivery", async () => {
    const { service, task, channelId } = await setup({ remote: true, admin: false });
    expect(service.forkTaskPeople(channelId, task.id)).toEqual([PARTNER.id]);
    expect(forkChannelTaskPeople("delivery-1", service)).toEqual([PARTNER.id]);
    expect(forkChannelTaskPeople("delivery-unknown", service)).toEqual([]);
  });

  it("does not count this computer's person as a remote requester", async () => {
    const { service } = await setup({ remote: false, admin: false });
    expect(forkChannelTaskPeople("delivery-1", service)).toEqual([]);
  });

  it("reaches the channel's agents and no hidden agent outside the channel", async () => {
    const { service, channelId } = await setup({ remote: true, admin: false });
    const level = (_personId: string, _agentId: string): AgentAccessLevel => "none";
    const reach = (requesters: string[], channel: string | null) =>
      forkReachableAgents([TRAF, NAMI, ICHIRO], TRAF.id, requesters, channel, service, level).map((item) => item.id);
    expect(reach([PARTNER.id], channelId)).toEqual(["traf", "nami"]);
    expect(reach([PARTNER.id], null)).toEqual(["traf"]);
    expect(reach([], channelId)).toEqual(["traf", "nami", "ichiro"]);
    const granted = (_personId: string, agentId: string): AgentAccessLevel => (agentId === "ichiro" ? "chat" : "none");
    expect(
      forkReachableAgents([TRAF, NAMI, ICHIRO], TRAF.id, [PARTNER.id], channelId, service, granted).map(
        (item) => item.id,
      ),
    ).toEqual(["traf", "nami", "ichiro"]);
  });

  it("refuses channel setting changes that a non-admin member asks an agent for", async () => {
    const { service, channelId } = await setup({ remote: true, admin: false });
    const refused = await Effect.runPromise(
      Effect.flip(
        service.tool(channelId, TRAF.id, "turn-1", "call-1", "channel_set_instructions", { instructions: "Leak." }),
      ),
    );
    expect(String(refused.cause)).toContain("Only an owner or admin");
    expect(service.store.get(channelId).instructions).toBe("Be kind.");
  });

  it("sends the turn's final answer to the outbound webhook", async () => {
    const { service, channelId, threadId, task } = await setup({ remote: true, admin: false });
    const turnAnswered = vi.fn();
    forkHub.channelWebhooks = { turnAnswered };
    const answer: ChannelMessage = {
      id: "answer-1",
      channelId,
      sequence: 0,
      author: { kind: "agent", id: TRAF.id, name: TRAF.name },
      taskId: task.id,
      superseded: false,
      message: {
        id: "answer-item-1",
        author: "assistant",
        text: "The cut is ready.",
        turnId: "turn-1",
        createdAt: "2026-11-25T10:01:00.000Z",
        status: "completed",
      },
    };
    service.store.update(service.store.get(channelId), { messages: [answer] });
    service.event({ type: "turn-completed", agentId: TRAF.id, threadId, turnId: "turn-1", status: "completed" });
    await vi.waitFor(() => expect(turnAnswered).toHaveBeenCalledTimes(1));
    expect(turnAnswered.mock.calls[0]?.[0]).toMatchObject({
      channelId,
      channelName: "agency",
      origin: "member",
      message: { id: "answer-1", message: { text: "The cut is ready." } },
    });
  });
});
