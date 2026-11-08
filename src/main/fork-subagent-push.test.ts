// @vitest-environment node

import type { AgentEvent, AgentSummary } from "@openbot/contracts/ipc";
import { translateFor } from "@openbot/i18n";
import { notificationForAgentEvent } from "@openbot/team-client/agent-notifications";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENDED_SUBAGENTS_GROUP_MS, type NotificationRelayRequest, PushNotificationService } from "./push-notifications";

/**
 * Fork (docs/fork/FEATURES.md, "Background work stays open and reaches the phone"): subagents that
 * end after their turn reach the phone, grouped, only while the owner is away from the Mac.
 */

afterEach(() => {
  vi.useRealTimers();
});

const THREAD = "thread-lead";
const AGENT: AgentSummary = {
  id: "lead",
  provider: "claude",
  name: "Tapa Lead",
  title: "Lead",
  description: "",
  notifications: true,
  model: "claude-opus-5-5",
  reasoningEffort: "medium",
  threadId: THREAD,
  workspacePath: "/tmp/openbot-lead",
  preview: "",
  updatedAt: "2026-11-08T10:00:00.000Z",
  avatarSeed: "lead",
  avatarHue: null,
  avatarUrl: null,
};

type PushOptions = ConstructorParameters<typeof PushNotificationService>[0];

function ended(id: string, title: string, status: "completed" | "failed" | "stopped" = "completed"): AgentEvent {
  return {
    type: "subagents-ended",
    agentId: AGENT.id,
    threadId: THREAD,
    turnId: "turn-1",
    subagents: [{ id, title, status }],
    running: false,
  };
}

function setup(state: { idleSeconds: number }) {
  let listener: ((event: AgentEvent) => void) | null = null;
  const sent: NotificationRelayRequest[] = [];
  const agents: PushOptions["agents"] = {
    on: (_name, next) => {
      listener = next;
    },
    off: () => {},
    listAgents: () => [AGENT],
    readConversationPageFor: () => Effect.die(new Error("No answer is read in this test.")),
    getRuntimeSnapshot: () => ({
      agents: [],
      activeTurns: [],
      work: [],
      latestMessages: [],
      attentionComplete: true,
      pendingPrompts: [],
      pendingApprovals: [],
      pendingBrowserTakeovers: [],
      failedTurns: [],
    }),
    listConversationReads: () => ({}),
    readTask: () => {
      throw new Error("No task in this test.");
    },
  };
  const service = new PushNotificationService({
    agents,
    store: {
      list: () => [
        {
          sessionId: "phone",
          memberId: "owner",
          protocol: 1,
          capabilities: [],
          platform: "android" as const,
          value: {
            serverId: "server",
            token: "t".repeat(40),
            secret: "A".repeat(43),
            locale: "en",
            away: true,
            level: "all" as const,
            mutedUntil: null,
            preview: true,
            sound: "default" as const,
          },
        },
      ],
      replace: () => Effect.void,
    },
    send: (request) =>
      Effect.sync(() => {
        sent.push(request);
        return "sent" as const;
      }),
    hiddenAgentIds: () => new Set(),
    memberActive: () => true,
    lastUseElsewhere: () => null,
    // As on the Mac: input in the last 30 s means the owner is there.
    atHostComputer: () => state.idleSeconds < 30,
    hostIdleSeconds: () => state.idleSeconds,
    liveActivityShows: () => false,
    randomBytes: (size) => new Uint8Array(size),
  });
  service.start();
  return {
    sent,
    emit: (event: AgentEvent) => listener?.(event),
  };
}

describe("ended background subagents on the phone", () => {
  it("sends the ends of one agent within the group time as one notification", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const { sent, emit } = setup({ idleSeconds: 600 });
    emit(ended("a", "Find B-roll"));
    emit(ended("b", "Key the greenscreen", "failed"));
    // A stop is not news.
    emit(ended("c", "Old work", "stopped"));
    expect(sent).toHaveLength(0);
    vi.advanceTimersByTime(ENDED_SUBAGENTS_GROUP_MS);
    vi.useRealTimers();
    await vi.waitFor(() => expect(sent).toHaveLength(1));
  });

  it("waits while the owner is at the Mac and sends after two minutes idle", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const state = { idleSeconds: 5 };
    const { sent, emit } = setup(state);
    emit(ended("a", "Find B-roll"));
    await vi.advanceTimersByTimeAsync(ENDED_SUBAGENTS_GROUP_MS);
    // Still at the Mac: the poll finds input.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sent).toHaveLength(0);
    state.idleSeconds = 130;
    await vi.advanceTimersByTimeAsync(15_000);
    vi.useRealTimers();
    await vi.waitFor(() => expect(sent).toHaveLength(1));
  });

  it("names the subagent, or counts them, in the agent's words", () => {
    const translate = translateFor("en");
    const agents = [AGENT];
    const preview = { reply: null, redact: (text: string) => text };
    expect(notificationForAgentEvent(ended("a", "Find B-roll"), agents, translate, "all", preview)).toMatchObject({
      title: "Tapa Lead",
      body: "A subagent finished: Find B-roll",
    });
    const group: AgentEvent = {
      type: "subagents-ended",
      agentId: AGENT.id,
      threadId: THREAD,
      turnId: "turn-1",
      subagents: [
        { id: "a", title: "One", status: "completed" },
        { id: "b", title: "Two", status: "completed" },
        { id: "c", title: "Three", status: "failed" },
      ],
      running: false,
    };
    expect(notificationForAgentEvent(group, agents, translate, "all", preview)?.body).toBe(
      "2 subagents finished. 1 subagent stopped with an error.",
    );
    // "needs-me" keeps only what waits for the person.
    expect(notificationForAgentEvent(group, agents, translate, "needs-me", preview)).toBeNull();
  });
});
