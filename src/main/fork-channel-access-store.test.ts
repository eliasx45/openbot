// @vitest-environment node
// Fork (docs/fork/FEATURES.md #107): default-closed levels, channel levels in the roles file, and the
// prompts of a channel's threads that a channel member sees while the agent itself stays hidden.

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  type AgentAccessState,
  AgentAccessStore,
  agentAccessLevel,
  agentAccessSnapshot,
  channelAccessLevel,
} from "./agent-access-store";
import { hiddenAgentView } from "./team-api/provider-visibility";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const MEMBER = { id: "member-1", role: "member" } as const;
const ADMIN = { id: "admin-1", role: "admin" } as const;
const EMPTY = { revision: 0, everyone: {}, roles: [] };

describe("fork #107 default-closed roles with channel levels", () => {
  it("closes an unlisted agent and channel to members and keeps them open to owners and admins", () => {
    expect(agentAccessLevel(EMPTY, MEMBER, "new-agent")).toBe("none");
    expect(channelAccessLevel(EMPTY, MEMBER, "new-channel")).toBe("none");
    expect(agentAccessLevel(EMPTY, ADMIN, "new-agent")).toBe("manage");
    expect(channelAccessLevel(EMPTY, ADMIN, "new-channel")).toBe("chat");
    expect(channelAccessLevel("closed", MEMBER, "new-channel")).toBe("none");
    expect(agentAccessLevel({ ...EMPTY, everyone: { open: "chat" } }, MEMBER, "open")).toBe("chat");
  });

  it("gives a member the highest of Everyone and its roles", () => {
    const state: AgentAccessState = {
      revision: 1,
      everyone: {},
      everyoneChannels: { agency: "view" },
      roles: [
        { id: "a", name: "A", agents: {}, memberIds: [MEMBER.id], channels: { agency: "chat" } },
        { id: "b", name: "B", agents: {}, memberIds: ["other"], channels: { private: "chat" } },
      ],
    };
    expect(channelAccessLevel(state, MEMBER, "agency")).toBe("chat");
    expect(channelAccessLevel(state, MEMBER, "private")).toBe("none");
    expect(channelAccessLevel(state, { id: "x", role: "member" }, "agency")).toBe("view");
  });

  it("reads a roles file of an older build, which has no channel levels", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-fork-107-roles-"));
    roots.push(root);
    const path = join(root, "openbot-agent-access-v1.json");
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        servers: {
          server: {
            revision: 4,
            everyone: { traf: "manage" },
            roles: [{ id: "ops", name: "Ops", agents: { nami: "chat" }, memberIds: [MEMBER.id] }],
          },
        },
      }),
    );
    const store = new AgentAccessStore(path);
    await Effect.runPromise(store.load());
    const state = store.get("server");
    expect(state.revision).toBe(4);
    expect(agentAccessLevel(state, MEMBER, "traf")).toBe("manage");
    expect(agentAccessLevel(state, MEMBER, "nami")).toBe("chat");
    expect(agentAccessLevel(state, MEMBER, "ichiro")).toBe("none");
    expect(channelAccessLevel(state, MEMBER, "agency")).toBe("none");
    expect(channelAccessLevel(state, ADMIN, "agency")).toBe("chat");
  });

  it("stores channel levels, keeps them when a change leaves them out and drops deleted channels", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-fork-107-roles-"));
    roots.push(root);
    const path = join(root, "openbot-agent-access-v1.json");
    const store = new AgentAccessStore(path);
    await Effect.runPromise(store.load());
    const agents = new Set(["traf"]);
    const channels = new Set(["agency", "gone"]);
    await Effect.runPromise(
      store.set(
        "server",
        {
          revision: 0,
          everyone: {},
          everyoneChannels: { gone: "view" },
          roles: [{ id: "agency", name: "Agency", agents: {}, memberIds: [MEMBER.id], channels: { agency: "chat" } }],
        },
        agents,
        agents,
        null,
        channels,
      ),
    );
    await Effect.runPromise(
      store.set(
        "server",
        {
          revision: 1,
          everyone: { traf: "none" },
          roles: [{ id: "agency", name: "Agency", agents: {}, memberIds: [] }],
        },
        agents,
        agents,
        null,
        new Set(["agency"]),
      ),
    );
    const reloaded = new AgentAccessStore(path);
    await Effect.runPromise(reloaded.load());
    const state = reloaded.get("server");
    expect(state.roles[0]?.channels).toEqual({ agency: "chat" });
    expect(state.everyoneChannels).toEqual({});
    expect(JSON.parse(await readFile(path, "utf8")).version).toBe(1);
    expect(agentAccessSnapshot(state, MEMBER, ["traf"], ["agency"])).toEqual({
      revision: 2,
      mine: {},
      mineChannels: {},
    });
    expect(agentAccessSnapshot(state, ADMIN, ["traf"], ["agency"])).toMatchObject({
      everyoneChannels: {},
      roles: [{ id: "agency", channels: { agency: "chat" } }],
    });
  });

  it("lets the prompts and approvals of a visible channel's thread through, and nothing else of a hidden agent", () => {
    const exposed = (threadId: string) => threadId === "channel-thread";
    const hidden = new Set(["traf"]);
    const prompt = {
      type: "prompt",
      requestId: 1,
      agentId: "traf",
      threadId: "channel-thread",
      turnId: "t",
      questions: [],
    };
    expect(hiddenAgentView(prompt, hidden, 8, exposed)).toEqual(prompt);
    expect(hiddenAgentView({ ...prompt, threadId: "direct-thread" }, hidden, 8, exposed)).toBeNull();
    const snapshot = {
      pendingPrompts: [prompt, { ...prompt, requestId: 2, threadId: "direct-thread" }],
      pendingApprovals: [{ requestId: 3, agentId: "traf", threadId: "channel-thread", turnId: "t" }],
      latestMessages: [{ agentId: "traf", id: "m", text: "private", createdAt: "now" }],
    };
    expect(hiddenAgentView(snapshot, hidden, 8, exposed)).toEqual({
      pendingPrompts: [prompt],
      pendingApprovals: [{ requestId: 3, agentId: "traf", threadId: "channel-thread", turnId: "t" }],
      latestMessages: [],
    });
    expect(
      hiddenAgentView(
        { type: "conversation", snapshot: { agentId: "traf", threadId: "channel-thread" } },
        hidden,
        8,
        exposed,
      ),
    ).toBeNull();
  });

  it("drops the questions and approvals of a closed channel's thread, also of an agent the member sees", () => {
    const closed = (threadId: string) => threadId === "closed-channel-thread";
    const prompt = {
      type: "prompt",
      requestId: 1,
      agentId: "traf",
      threadId: "closed-channel-thread",
      turnId: "t",
      questions: [],
    };
    const direct = { ...prompt, requestId: 2, threadId: "direct-thread" };
    expect(hiddenAgentView(prompt, new Set(), 8, undefined, closed)).toBeNull();
    expect(hiddenAgentView(direct, new Set(), 8, undefined, closed)).toEqual(direct);
    const approval = { requestId: 3, agentId: "traf", threadId: "closed-channel-thread", turnId: "t" };
    const active = { agentId: "traf", threadId: "closed-channel-thread", turnId: "t" };
    expect(
      hiddenAgentView(
        { pendingPrompts: [prompt, direct], pendingApprovals: [approval], activeTurns: [active] },
        new Set(),
        8,
        undefined,
        closed,
      ),
    ).toEqual({ pendingPrompts: [direct], pendingApprovals: [], activeTurns: [active] });
    expect(hiddenAgentView({ type: "approval", approval }, new Set(), 8, undefined, closed)).toBeNull();
  });
});
