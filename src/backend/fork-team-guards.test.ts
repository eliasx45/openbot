// @vitest-environment node
// Fork (docs/fork/FEATURES.md #135, "Team watchdogs and guards"): the hop count, the open-request caps
// and the mutual-wait refusal of agent-to-agent messages, the new send_message fields, and the check
// of a "Status: done" reply (pass, one bounce to the teammate, then "check failed" for the lead).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DynamicRecord } from "@openbot/contracts/runtime-values";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  chainBase,
  ForkTeamGuards,
  type ForkTeamGuardsHooks,
  openRequests,
  parseRequestFields,
  type SendGuardInput,
  saysDone,
  sendRefusal,
  TeamMetaStore,
  type TeamOpenRequest,
  type TeamRequestMeta,
  type TeamRequestRecord,
  type TeamTurnDelivery,
} from "./fork-team-guards";

const NAMES = new Map([
  ["lead", "Vegapunk"],
  ["chopper", "Chopper"],
]);
const LIMITS = { hops: 8, perSender: 16, perTree: 64 };
const NOW = Date.parse("2026-11-27T14:00:00.000Z");
const iso = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();

function meta(sender: string, hops: number, root: string, extra: Partial<TeamRequestMeta> = {}): TeamRequestMeta {
  return { sender, hops, root, createdAt: iso(0), ...extra };
}

const agentDelivery = (
  messageId: string,
  agentId: string,
  replyToMessageId: string | null = null,
  expectsReply = true,
): TeamTurnDelivery => ({ messageId, sender: { kind: "agent", agentId }, replyToMessageId, expectsReply });

function edge(id: string, sender: string, recipient: string, root = sender): TeamOpenRequest {
  return { id, sender, recipient, root, createdAt: iso(0), text: `request ${id}` };
}

function guard(input: Partial<SendGuardInput>): string | null {
  return sendRefusal({
    senderAgentId: "b",
    recipientAgentIds: ["c"],
    expectsReply: true,
    replyTo: null,
    base: { hops: 0, root: "b" },
    open: [],
    turnMessageIds: new Set(),
    name: (agentId) => agentId.toUpperCase(),
    limits: LIMITS,
    ...input,
  });
}

describe("chainBase", () => {
  const metas = new Map<string, TeamRequestMeta>();
  const lookup = (id: string) => metas.get(id);
  const sender = (id: string) => metas.get(id)?.sender ?? null;
  beforeEach(() => metas.clear());

  it("starts a chain at the user, a routine or OpenBot's own wake", () => {
    expect(chainBase("lead", [], lookup, sender)).toEqual({ hops: 0, root: "lead" });
    const user: TeamTurnDelivery = {
      messageId: "u",
      sender: { kind: "user" },
      replyToMessageId: null,
      expectsReply: true,
    };
    const routine: TeamTurnDelivery = {
      messageId: "r",
      sender: { kind: "routine" },
      replyToMessageId: null,
      expectsReply: true,
    };
    expect(chainBase("lead", [user, routine], lookup, sender)).toEqual({ hops: 0, root: "lead" });
  });

  it("carries the hops of a request the turn handles, and its lead", () => {
    metas.set("m1", meta("lead", 1, "lead"));
    expect(chainBase("a", [agentDelivery("m1", "lead")], lookup, sender)).toEqual({ hops: 1, root: "lead" });
    metas.set("m2", meta("a", 2, "lead"));
    expect(chainBase("b", [agentDelivery("m2", "a")], lookup, sender)).toEqual({ hops: 2, root: "lead" });
  });

  it("gives back the hops of the agent's own request when a teammate's reply ends the exchange", () => {
    metas.set("m1", meta("lead", 1, "lead"));
    // The teammate's reply (no meta of its own, like OpenBot's automatic result) to the lead's request.
    expect(chainBase("lead", [agentDelivery("reply", "a", "m1", false)], lookup, sender)).toEqual({
      hops: 0,
      root: "lead",
    });
  });

  it("counts a reply that asks back, so question ping-pong grows", () => {
    metas.set("m1", meta("lead", 1, "lead"));
    metas.set("ask", meta("a", 2, "lead"));
    expect(chainBase("lead", [agentDelivery("ask", "a", "m1", true)], lookup, sender)).toEqual({
      hops: 2,
      root: "lead",
    });
  });

  it("takes the longest chain of the turn's deliveries", () => {
    metas.set("m1", meta("x", 3, "x"));
    metas.set("m2", meta("y", 5, "y"));
    expect(chainBase("b", [agentDelivery("m1", "x"), agentDelivery("m2", "y")], lookup, sender)).toEqual({
      hops: 5,
      root: "y",
    });
  });

  it("treats a message from before the feature as one hop of its sender's chain", () => {
    expect(chainBase("b", [agentDelivery("old", "a")], lookup, sender)).toEqual({ hops: 1, root: "a" });
  });
});

describe("sendRefusal", () => {
  it("lets hop 8 through and refuses hop 9 with what to do instead", () => {
    expect(guard({ base: { hops: 7, root: "lead" } })).toBeNull();
    const refusal = guard({ base: { hops: 8, root: "lead" } });
    expect(refusal).toContain("hop 9");
    expect(refusal).toContain("replyToMessageId");
    expect(guard({ base: { hops: 8, root: "lead" }, expectsReply: false })).toContain("hop 9");
  });

  it("never refuses a reply that ends an exchange", () => {
    expect(guard({ base: { hops: 40, root: "lead" }, replyTo: "m1", expectsReply: false })).toBeNull();
  });

  it("caps an agent's open requests at 16, counting each recipient", () => {
    const open = Array.from({ length: 15 }, (_, index) => edge(`m${index}`, "b", `t${index}`));
    expect(guard({ open })).toBeNull();
    const refusal = guard({ open, recipientAgentIds: ["c", "d"] });
    expect(refusal).toContain("15 open requests");
    expect(refusal).toContain("expectsReply false");
    expect(guard({ open, recipientAgentIds: ["c", "d"], expectsReply: false })).toBeNull();
  });

  it("caps a lead's tree at 64 open requests", () => {
    const open = Array.from({ length: 64 }, (_, index) => edge(`m${index}`, `s${index % 8}`, `t${index}`, "lead"));
    expect(guard({ open, base: { hops: 1, root: "lead" } })).toContain("64 open requests");
    expect(guard({ open, base: { hops: 1, root: "other" } })).toBeNull();
  });

  it("refuses asking back an agent that waits for the sender, and says to reply instead", () => {
    const open = [edge("m1", "a", "b", "lead")];
    const refusal = guard({ open, recipientAgentIds: ["a"], base: { hops: 1, root: "lead" } });
    expect(refusal).toContain("waits for your answer to its request m1");
    expect(refusal).toContain('replyToMessageId "m1"');
    expect(refusal).toContain("Status: blocked");
  });

  it("finds a wait through a longer chain", () => {
    const open = [edge("m1", "a", "c", "lead"), edge("m2", "c", "b", "lead")];
    expect(guard({ open, recipientAgentIds: ["a"], base: { hops: 2, root: "lead" } })).toContain("A → C, C → B");
  });

  it("allows a reply that asks back about the request it answers, and requests of another chain", () => {
    const open = [edge("m1", "a", "b", "lead")];
    expect(guard({ open, recipientAgentIds: ["a"], replyTo: "m1", base: { hops: 1, root: "lead" } })).toBeNull();
    expect(guard({ open, recipientAgentIds: ["a"], base: { hops: 0, root: "b" } })).toBeNull();
    // Unless the turn handles that request: then it is this chain.
    expect(
      guard({ open, recipientAgentIds: ["a"], base: { hops: 0, root: "b" }, turnMessageIds: new Set(["m1"]) }),
    ).toContain("waits for your answer");
  });
});

describe("openRequests", () => {
  const record = (id: string, deliveries: TeamRequestRecord["deliveries"], extra: Partial<TeamRequestRecord> = {}) => ({
    id,
    senderAgentId: "lead",
    text: "x",
    createdAt: iso(0),
    channel: false,
    deliveries,
    ...extra,
  });
  const delivery = (
    recipientAgentId: string,
    extra: Partial<TeamRequestRecord["deliveries"][number]> = {},
  ): TeamRequestRecord["deliveries"][number] => ({
    id: `d-${recipientAgentId}`,
    recipientAgentId,
    status: "running",
    turnId: null,
    createdAt: iso(0),
    steeredAt: null,
    repliedAt: null,
    ...extra,
  });

  it("keeps deliveries with no reply that are not over, in the window, outside channels", () => {
    const records = [
      record("m1", [delivery("a"), delivery("b", { repliedAt: iso(1) }), delivery("c", { status: "failed" })]),
      record("m2", [delivery("d")], { channel: true }),
      record("m3", [delivery("e", { status: "completed" })], { createdAt: iso(-25 * 60) }),
      record("m4", [delivery("f", { status: "completed" })]),
    ];
    const open = openRequests(records, () => undefined, NOW, 24 * 60 * 60_000);
    expect(open.map((request) => `${request.id}:${request.recipient}`)).toEqual(["m1:a", "m4:f"]);
  });
});

describe("parseRequestFields and saysDone", () => {
  it("checks dueMinutes, doneWhen and check", () => {
    expect(parseRequestFields({})).toEqual({});
    expect(
      parseRequestFields({ dueMinutes: 30, doneWhen: " out.mp4 renders ", check: { kind: "file", path: "out.mp4" } }),
    ).toEqual({ dueMinutes: 30, doneWhen: "out.mp4 renders", check: { kind: "file", path: "out.mp4" } });
    expect(parseRequestFields({ dueMinutes: 0 })).toContain("dueMinutes");
    expect(parseRequestFields({ dueMinutes: 1.5 })).toContain("dueMinutes");
    expect(parseRequestFields({ check: { kind: "script" } })).toContain("check.kind");
    expect(parseRequestFields({ check: { kind: "command", command: " " } })).toContain("check.command");
  });

  it("reads Status: done the ways agents write it", () => {
    expect(saysDone("Status: done\nResult: x")).toBe(true);
    expect(saysDone("**Status:** done")).toBe(true);
    expect(saysDone("- status: DONE. All good")).toBe(true);
    expect(saysDone("Status: partial")).toBe(false);
    expect(saysDone("I am done")).toBe(false);
  });
});

describe("ForkTeamGuards", () => {
  let dir: string;
  let enqueued: Array<{ agentId: string; text: string; idempotencyKey: string }>;
  let records: TeamRequestRecord[];
  const savedEnv = { ...process.env };

  const hooks = (): ForkTeamGuardsHooks => ({
    name: (agentId) => NAMES.get(agentId) ?? agentId,
    requests: () => records,
    messageSender: () => null,
    workspace: () => dir,
    enqueue: async (input) => {
      enqueued.push(input);
      return "queued";
    },
    timezone: () => "UTC",
    log: () => {},
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "team-guards-"));
    enqueued = [];
    records = [];
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    process.env = { ...savedEnv };
  });

  function sendRequest(guards: ForkTeamGuards, args: DynamicRecord, id = "req-1") {
    const plan = guards.planSend({
      senderAgentId: "lead",
      recipientAgentIds: ["chopper"],
      expectsReply: true,
      replyTo: null,
      turnDeliveries: [],
      args,
      now: NOW,
    });
    if ("refusal" in plan) throw new Error(plan.refusal);
    guards.recordSend(id, plan);
    return plan;
  }

  const reply = (guards: ForkTeamGuards, text: string, via: "tool" | "auto") =>
    guards.gateReply({ teammateId: "chopper", requestId: "req-1", recipientAgentIds: ["lead"], text, via });

  it("keeps a request's fields and hops over a restart (a new instance on the same file)", () => {
    const database = join(dir, "openbot.sqlite");
    const first = new ForkTeamGuards({ databasePath: database, hooks: hooks() });
    sendRequest(first, { dueMinutes: 30, doneWhen: "the clip renders" });
    const second = new ForkTeamGuards({ databasePath: database, hooks: hooks() });
    expect(second.meta("req-1")).toMatchObject({ sender: "lead", hops: 1, root: "lead", dueMinutes: 30 });
  });

  it("refuses the fields on a message that expects no reply, and refusals can be turned off", () => {
    const guards = new ForkTeamGuards({ databasePath: null, hooks: hooks() });
    const plan = guards.planSend({
      senderAgentId: "lead",
      recipientAgentIds: ["chopper"],
      expectsReply: false,
      replyTo: null,
      turnDeliveries: [],
      args: { dueMinutes: 5 },
    });
    expect(plan).toHaveProperty("refusal");
    guards.recordSend("m-deep", { meta: { sender: "x", hops: 8, root: "x", createdAt: iso(0) } });
    const deep = {
      senderAgentId: "lead",
      recipientAgentIds: ["chopper"],
      expectsReply: true,
      replyTo: null,
      turnDeliveries: [agentDelivery("m-deep", "x")],
      args: {},
    };
    expect(guards.planSend(deep)).toHaveProperty("refusal");
    process.env.OPENBOT_FORK_TEAM_GUARDS = "0";
    expect(guards.planSend(deep)).toHaveProperty("meta.hops", 9);
  });

  it("passes a done reply whose file check passes, with a note for the lead", async () => {
    writeFileSync(join(dir, "out.mp4"), "frames");
    const guards = new ForkTeamGuards({ databasePath: null, hooks: hooks() });
    sendRequest(guards, { doneWhen: "out.mp4 renders", check: { kind: "file", path: "out.mp4" } });
    const gate = await reply(guards, "Status: done\nResult: rendered", "tool");
    expect(gate.kind).toBe("send");
    expect(gate.kind === "send" && gate.text).toContain("[OpenBot: ✓ check passed]");
    expect(guards.promptLines({ messageId: "r", replyToMessageId: "req-1", recipientAgentId: "lead" })).toEqual([
      "Your done-when for this request: out.mp4 renders",
      "OpenBot's check passed: file out.mp4 exists.",
    ]);
  });

  it("leaves replies that are not done, and requests without a check, alone", async () => {
    const guards = new ForkTeamGuards({ databasePath: null, hooks: hooks() });
    sendRequest(guards, { check: { kind: "file", path: "missing.mp4" } });
    expect(await reply(guards, "Status: blocked\nUnblock: need the model", "tool")).toEqual({
      kind: "send",
      text: "Status: blocked\nUnblock: need the model",
    });
    expect(
      await guards.gateReply({
        teammateId: "chopper",
        requestId: "other",
        recipientAgentIds: ["lead"],
        text: "Status: done",
        via: "tool",
      }),
    ).toEqual({ kind: "send", text: "Status: done" });
  });

  it("sends a failed done reply back once (a tool error), then marks it failed for the lead", async () => {
    const guards = new ForkTeamGuards({ databasePath: null, hooks: hooks() });
    sendRequest(guards, { doneWhen: "out.mp4 renders", check: { kind: "file", path: "out.mp4" } });
    const first = await reply(guards, "Status: done\nResult: rendered", "tool");
    expect(first.kind).toBe("refuse");
    expect(first.kind === "refuse" && first.message).toContain("your result failed its check");
    expect(first.kind === "refuse" && first.message).toContain("does not exist");
    const second = await reply(guards, "Status: done\nResult: rendered", "auto");
    expect(second.kind).toBe("send");
    expect(second.kind === "send" && second.text).toContain("Status: done (check failed)");
    expect(second.kind === "send" && second.text).toContain("[OpenBot: ✗ check failed]");
    expect(enqueued).toEqual([]);
    expect(guards.promptLines({ messageId: "r", replyToMessageId: "req-1", recipientAgentId: "lead" })[1]).toContain(
      "Do not treat this result as done",
    );
  });

  it("holds OpenBot's automatic result when its check fails the first time, and messages the teammate once", async () => {
    const guards = new ForkTeamGuards({ databasePath: null, hooks: hooks() });
    sendRequest(guards, { check: { kind: "command", command: "echo frames missing >&2; exit 3" } });
    expect(await reply(guards, "Status: done", "auto")).toEqual({ kind: "held" });
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]?.agentId).toBe("chopper");
    expect(enqueued[0]?.idempotencyKey).toBe("fork-team-check:req-1");
    expect(enqueued[0]?.text).toContain("[OpenBot: 🐕 team check]");
    expect(enqueued[0]?.text).toContain("exit 3: frames missing");
    expect(enqueued[0]?.text).toContain('replyToMessageId "req-1"');
    const again = await reply(guards, "Status: done", "auto");
    expect(again.kind).toBe("send");
    expect(enqueued).toHaveLength(1);
  });

  it("shows the teammate the done condition, the check and the due time", () => {
    const guards = new ForkTeamGuards({ databasePath: null, hooks: hooks() });
    sendRequest(guards, {
      dueMinutes: 45,
      doneWhen: "the clip renders",
      check: { kind: "command", command: "test -s out.mp4" },
    });
    const lines = guards.promptLines({ messageId: "req-1", replyToMessageId: null, recipientAgentId: "chopper" });
    expect(lines[0]).toBe("Done when (set by Vegapunk): the clip renders");
    expect(lines[1]).toContain("command `test -s out.mp4` exits 0");
    expect(lines[2]).toContain("reply within 45 minutes, by 14:45");
    expect(guards.promptLines({ messageId: "req-1", replyToMessageId: null, recipientAgentId: "lead" })).toEqual([]);
  });

  it("refuses a 17th open request with the list of what is open", () => {
    records = [
      {
        id: "older",
        senderAgentId: "lead",
        text: "x",
        createdAt: new Date().toISOString(),
        channel: false,
        deliveries: Array.from({ length: 16 }, (_, index): TeamRequestRecord["deliveries"][number] => ({
          id: `d${index}`,
          recipientAgentId: index < 2 ? "chopper" : `t${index}`,
          status: "running",
          turnId: null,
          createdAt: new Date().toISOString(),
          steeredAt: null,
          repliedAt: null,
        })),
      },
    ];
    const guards = new ForkTeamGuards({ databasePath: null, hooks: hooks() });
    const plan = guards.planSend({
      senderAgentId: "lead",
      recipientAgentIds: ["usopp"],
      expectsReply: true,
      replyTo: null,
      turnDeliveries: [],
      args: {},
    });
    expect("refusal" in plan && plan.refusal).toContain(
      "16 open requests that wait for a reply (Chopper ×2, t2, t3, t4, t5, t6, t7, t8, …)",
    );
  });
});

describe("TeamMetaStore", () => {
  it("drops a damaged file and starts empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "team-store-"));
    writeFileSync(join(dir, "fork-team-watchdog.json"), "{not json");
    const store = new TeamMetaStore(join(dir, "openbot.sqlite"));
    expect(store.get("x")).toBeUndefined();
    const at = new Date().toISOString();
    store.flag(["a:b:quiet"], at);
    expect(new TeamMetaStore(join(dir, "openbot.sqlite")).flagged("a:b:quiet")).toBe(at);
    rmSync(dir, { recursive: true, force: true });
  });
});
