// @vitest-environment node

import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { channelThreads } from "@openbot/contracts/fork-channel-threads";
import type { AgentSummary, ChannelMessage } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChannelImages } from "./channel-images";
import { ChannelService } from "./channel-service";
import type { ChannelAssignment } from "./channel-store";
import { runCauseEffect } from "./effect-boundary";
import { MailboxStore } from "./mailbox-store";
import { OpenBotDatabase } from "./openbot-database";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const PERSON = { id: "member-me", name: "Elias" };

function agent(id: string, name: string): AgentSummary {
  return {
    id,
    provider: "codex",
    name,
    title: "",
    description: "",
    notifications: false,
    model: "gpt-5.5",
    reasoningEffort: "medium",
    threadId: null,
    workspacePath: "/workspace",
    preview: "",
    updatedAt: null,
    avatarSeed: id,
    avatarHue: null,
    avatarUrl: null,
  };
}

const ANA = agent("ana", "Ana");
const BEN = agent("ben", "Ben");

const active = (assignment: ChannelAssignment) =>
  assignment.state === "queued" || assignment.state === "starting" || assignment.state === "running";

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "openbot-channel-threads-"));
  roots.push(root);
  const database = new OpenBotDatabase(root);
  await runCauseEffect(database.initialize());
  database.replaceAgents("seed", [ANA, BEN], "agents.updated");
  const mailbox = new MailboxStore(root, join(root, "shared"), database);
  await runCauseEffect(mailbox.initialize());
  const service = new ChannelService(database, mailbox, new ChannelImages(join(root, "images")), {
    agents: () => [ANA, BEN],
    generate: () => Effect.die(new Error("No routing model in this test.")),
    schedule: () => {},
    interrupt: () => Effect.void,
    busy: () => false,
    changed: () => {},
    error: (error) => {
      throw error;
    },
  });
  const channelId = randomUUID();
  await runCauseEffect(
    service.command(
      {
        type: "save",
        operationId: randomUUID(),
        channelId,
        draft: {
          name: "Launch",
          title: "",
          instructions: "",
          members: [{ agentId: ANA.id }, { agentId: BEN.id }],
          leadAgentId: ANA.id,
        },
      },
      PERSON,
    ),
  );
  const messages = () => service.store.messages(channelId);
  const send = async (text: string, recipientAgentId: string, replyToMessageId: string | null) => {
    await runCauseEffect(
      service.command(
        {
          type: "send",
          operationId: randomUUID(),
          channelId,
          text,
          recipientAgentId,
          replyToMessageId,
          attachmentDraftIds: [],
        },
        PERSON,
      ),
    );
    const sent = messages().findLast((entry) => entry.author.kind === "member" && entry.message.text === text);
    if (!sent) throw new Error(`The message "${text}" is missing.`);
    return sent;
  };
  const turn = async (agentId: string, turnId: string) => {
    const assignment = await vi.waitFor(() => {
      const found = service.store
        .assignments(channelId)
        .find((item) => item.agentId === agentId && active(item) && item.turnId === null);
      if (!found) throw new Error(`No turn for ${agentId}.`);
      return found;
    });
    const task = service.store.task(channelId, assignment.taskId);
    service.store.update(service.store.get(channelId), {
      assignments: [{ ...assignment, turnId, state: "running" }],
      tasks: task ? [{ ...task, state: "running" }] : [],
    });
    return assignment;
  };
  const answer = (agentId: string, turnId: string, text: string): ChannelMessage => {
    const { threadId } = service.store.context(channelId, agentId);
    const id = `${turnId}-answer`;
    service.event({
      type: "conversation",
      snapshot: {
        agentId,
        threadId,
        activeTurnId: turnId,
        revision: 1,
        messages: [
          {
            id,
            author: "assistant",
            text,
            createdAt: new Date().toISOString(),
            status: "completed",
            turnId,
            itemType: "final_answer",
          },
        ],
      },
    });
    const found = messages().find((entry) => entry.message.text === text && entry.author.id === agentId);
    if (!found) throw new Error(`The answer "${text}" is missing.`);
    return found;
  };
  const finish = (assignment: ChannelAssignment, turnId: string) => {
    const task = service.store.task(channelId, assignment.taskId);
    service.store.update(service.store.get(channelId), {
      assignments: [{ ...assignment, turnId, state: "completed" }],
      tasks: task ? [{ ...task, state: "completed" }] : [],
    });
  };
  const tool = (agentId: string, turnId: string, name: string, args: unknown) =>
    runCauseEffect(service.tool(channelId, agentId, turnId, randomUUID(), name, args));
  const threads = () => channelThreads(messages(), service.store.tasks(channelId));
  return { service, channelId, messages, send, turn, answer, finish, tool, threads };
}

describe("a reply sent from the thread panel", () => {
  it("gets its bot answers, handoff and result inside the same thread", async () => {
    const { send, turn, answer, finish, tool, threads, messages } = await setup();

    const root = await send("Plan the launch.", ANA.id, null);
    const first = await turn(ANA.id, "turn-1");
    const plan = answer(ANA.id, "turn-1", "Plan A: ship on Friday.");
    finish(first, "turn-1");

    const reply = await send("@[Ben](agent:ben) what do you think?", BEN.id, root.id);
    expect(reply.message.replyToMessageId).toBe(root.id);
    const second = await turn(BEN.id, "turn-2");
    const opinion = answer(BEN.id, "turn-2", "Friday works if the dates hold.");
    await tool(BEN.id, "turn-2", "channel_assign", {
      recipientAgentId: ANA.id,
      task: "Check the launch dates.",
      expectedResult: "The checked dates.",
      sourceMessageIds: [reply.id],
    });
    const handoff = messages().find((entry) => entry.author.id === BEN.id && entry.message.text.startsWith("Ana:"));
    expect(handoff).toBeDefined();
    const check = await turn(ANA.id, "turn-3");
    const dates = answer(ANA.id, "turn-3", "The dates hold.");
    await tool(ANA.id, "turn-3", "channel_result", { text: "Checked: Friday is free." });
    const result = messages().find((entry) => entry.message.text === "Checked: Friday is free.");
    expect(result).toBeDefined();
    finish(check, "turn-3");
    finish(second, "turn-2");

    const other = await send("Book the venue.", ANA.id, null);
    await turn(ANA.id, "turn-4");
    const booking = answer(ANA.id, "turn-4", "The venue is booked.");

    expect(plan.message.replyToMessageId).toBeUndefined();
    expect(opinion.message.replyToMessageId).toBeUndefined();
    const feed = threads();
    expect(feed.roots.map((entry) => entry.id)).toEqual([root.id, other.id]);
    for (const entry of [plan, reply, opinion, handoff, dates, result])
      expect(feed.rootOf.get(entry?.id ?? "")).toBe(root.id);
    expect(feed.rootOf.get(booking.id)).toBe(other.id);
    expect(feed.summaries.get(other.id)?.replies).toBe(1);
    const summary = feed.summaries.get(root.id);
    expect(summary?.replies).toBeGreaterThanOrEqual(3);
    expect(summary?.repliers.map((author) => author.id)).toContain(BEN.id);
  });
});
