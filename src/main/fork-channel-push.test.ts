// @vitest-environment node
// Fork (docs/fork/FEATURES.md #107): a member who sees an agent but not its channel gets no phone
// notice or Live Activity item about that channel's work.

import type { AgentEvent, AgentRuntimeSnapshot, AgentSummary } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { type NotificationRelayRequest, PushNotificationService } from "./push-notifications";

const AGENT: AgentSummary = {
  id: "traf",
  provider: "codex",
  name: "Traf",
  title: "",
  description: "",
  notifications: true,
  model: "gpt-6-luna",
  reasoningEffort: "medium",
  threadId: "thread-traf",
  workspacePath: "/tmp/openbot-traf",
  preview: "",
  updatedAt: "2026-11-25T10:00:00.000Z",
  avatarSeed: "traf",
  avatarHue: null,
  avatarUrl: null,
};

const EMPTY_SNAPSHOT: AgentRuntimeSnapshot = {
  agents: [],
  activeTurns: [],
  work: [],
  latestMessages: [],
  attentionComplete: true,
  pendingPrompts: [],
  pendingApprovals: [],
  pendingBrowserTakeovers: [],
  failedTurns: [],
};

type PushOptions = ConstructorParameters<typeof PushNotificationService>[0];

function prompt(threadId: string, requestId: number): AgentEvent {
  return {
    type: "prompt",
    requestId,
    agentId: AGENT.id,
    threadId,
    turnId: `turn-${requestId}`,
    questions: [{ id: "q", header: "Q", question: "Which cut?", isSecret: false, options: null }],
  };
}

function setup(closed: ReadonlySet<string>) {
  let listener: ((event: AgentEvent) => void) | null = null;
  const sent: NotificationRelayRequest[] = [];
  const agents: PushOptions["agents"] = {
    on: (_name, next) => {
      listener = next;
    },
    off: () => {},
    listAgents: () => [AGENT],
    readConversationPageFor: () => Effect.die(new Error("No answer is read in this test.")),
    getRuntimeSnapshot: () => EMPTY_SNAPSHOT,
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
          memberId: "member-mixed",
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
    atHostComputer: () => false,
    liveActivityShows: () => false,
    randomBytes: (size) => new Uint8Array(size),
    channelForThread: (threadId) =>
      threadId.startsWith("channel-") ? { id: threadId.slice("channel-".length), name: threadId } : null,
    channelClosed: (_memberId, channelId) => closed.has(channelId),
  });
  service.start();
  return { sent, emit: (event: AgentEvent) => listener?.(event) };
}

describe("fork #107 channel notices on the phone", () => {
  it("sends no notice about a channel the member cannot see, and still sends the agent's own notices", async () => {
    const { sent, emit } = setup(new Set(["private"]));
    emit(prompt("channel-private", 1));
    emit(prompt("thread-traf", 2));
    emit(prompt("channel-private", 3));
    emit(prompt("thread-traf", 4));
    // The notices go out in order, so the second open one proves that both closed ones were skipped.
    await vi.waitFor(() => expect(sent.length).toBeGreaterThanOrEqual(2));
    expect(sent).toHaveLength(2);
  });

  it("sends the notice of a channel the member sees", async () => {
    const { sent, emit } = setup(new Set());
    emit(prompt("channel-agency", 1));
    await vi.waitFor(() => expect(sent).toHaveLength(1));
  });
});
