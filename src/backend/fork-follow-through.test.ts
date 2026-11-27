// @vitest-environment node
// Fork (docs/fork/FEATURES.md #130, "Team follow-through"): which teammate reports still wait for the
// lead's decision, and the one wake each of them gets. The flow in the real agent service is checked
// end to end by scripts/fork-follow-through-e2e.ts.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FORK_FOLLOW_THROUGH_ROUTINE_ID,
  type FollowThroughReceived,
  type FollowThroughTraffic,
  ForkFollowThrough,
  type ForkFollowThroughHooks,
  followThroughKey,
  followThroughText,
  pendingReports,
} from "./fork-follow-through";

const MIN = 60_000;
const T0 = Date.parse("2026-11-27T14:00:00.000Z");
const at = (minutes: number) => new Date(T0 + minutes * MIN).toISOString();
const DELAY = 3 * MIN;

let ids = 0;
function report(teammate: string, minutes: number, extra: Partial<FollowThroughReceived> = {}): FollowThroughReceived {
  ids += 1;
  return {
    id: `report-${ids}`,
    sender: { kind: "agent", agentId: teammate },
    text: `Status: done (${teammate} ${ids})`,
    createdAt: at(minutes),
    replyToMessageId: "request-1",
    replyToSenderAgentId: "lead",
    deliveryId: `delivery-${ids}`,
    status: "completed",
    ownChat: true,
    ...extra,
  };
}

const traffic = (received: FollowThroughReceived[], sent: FollowThroughTraffic["sent"] = []): FollowThroughTraffic => ({
  received,
  sent,
});

const pending = (input: FollowThroughTraffic, minutes: number) =>
  pendingReports("lead", input, { now: T0 + minutes * MIN, delayMs: DELAY }).map((item) => item.messageId);

describe("pendingReports", () => {
  it("takes a teammate's reply to the lead's request once it is old enough", () => {
    const done = report("distiller", 0);
    expect(pending(traffic([done]), 2)).toEqual([]);
    expect(pending(traffic([done]), 3)).toEqual([done.id]);
  });

  it("drops a report the lead acted on: any later message to that teammate", () => {
    const done = report("distiller", 0);
    const before = { id: "m0", recipientAgentIds: ["distiller"], createdAt: at(-1) };
    const toOther = { id: "m1", recipientAgentIds: ["kizaru"], createdAt: at(1) };
    expect(pending(traffic([done], [before, toOther]), 5)).toEqual([done.id]);
    const next = { id: "m2", recipientAgentIds: ["kizaru", "distiller"], createdAt: at(1) };
    expect(pending(traffic([done], [next]), 5)).toEqual([]);
  });

  it("keeps only the teammate's newest report", () => {
    const first = report("distiller", 0);
    const second = report("distiller", 4);
    expect(pending(traffic([first, second]), 5)).toEqual([]);
    expect(pending(traffic([first, second]), 7)).toEqual([second.id]);
  });

  it("ignores reports older than two hours", () => {
    const done = report("distiller", 0);
    expect(pending(traffic([done]), 119)).toEqual([done.id]);
    expect(pending(traffic([done]), 121)).toEqual([]);
  });

  it("ignores what is not a teammate's reply to the lead in its own chat", () => {
    const cases = [
      report("distiller", 0, { replyToMessageId: null, replyToSenderAgentId: null }),
      report("distiller", 0, { replyToSenderAgentId: "kizaru" }),
      report("distiller", 0, { ownChat: false }),
      report("distiller", 0, { status: "running" }),
      report("distiller", 0, { status: "failed" }),
      report("lead", 0),
      { ...report("distiller", 0), sender: { kind: "user" as const } },
    ];
    for (const item of cases) expect(pending(traffic([item]), 10)).toEqual([]);
    const channel = report("distiller", 0);
    expect(
      pendingReports("lead", traffic([channel]), {
        now: T0 + 10 * MIN,
        delayMs: DELAY,
        executionDelivery: (id) => id === channel.deliveryId,
      }),
    ).toEqual([]);
  });

  it("drops a report a wake named, by its time or its key", () => {
    const done = report("distiller", 0);
    const wake: FollowThroughReceived = {
      ...report("x", 0),
      sender: { kind: "routine", routineId: FORK_FOLLOW_THROUGH_ROUTINE_ID },
      createdAt: at(3),
    };
    expect(pending(traffic([done, wake]), 20)).toEqual([]);
    // A wake before the report was pending did not name it.
    expect(pending(traffic([done, { ...wake, createdAt: at(2) }]), 20)).toEqual([done.id]);
    expect(
      pendingReports("lead", traffic([done]), {
        now: T0 + 20 * MIN,
        delayMs: DELAY,
        keyUsed: (key) => key === followThroughKey(done.id),
      }),
    ).toEqual([]);
  });
});

describe("followThroughText", () => {
  it("names each teammate with its local time and the start of its report", () => {
    const text = followThroughText({
      reports: [
        {
          messageId: "a",
          teammateId: "distiller",
          teammateName: "Distiller",
          text: `Status: done\n\n${"x".repeat(400)}`,
          createdAt: "2026-11-27T14:27:45.000Z",
        },
      ],
      timezone: "Europe/Berlin",
    });
    expect(text.startsWith("[OpenBot: 👥 team follow-through] These teammates reported back to you")).toBe(true);
    expect(text).toContain('- Distiller, 15:27 on 27 Nov (Europe/Berlin): "Status: done xxx');
    expect(text).toContain('…"');
    expect(text).toContain("send its next step now with openbot.send_message (expectsReply true)");
    expect(text).toContain("If nothing needs doing, call openbot.routine_no_update and write nothing.");
    expect(text.length).toBeLessThan(900);
  });
});

describe("ForkFollowThrough", () => {
  let clock = T0;
  let received: FollowThroughReceived[] = [];
  let sent: Array<{ id: string; recipientAgentIds: string[]; createdAt: string }> = [];
  let keys: Set<string>;
  let busy = false;
  let queued = 0;
  let ready = true;
  let hidden = new Set<string>();
  let wakes: Array<{ agentId: string; text: string; idempotencyKey: string }> = [];

  const hooks: ForkFollowThroughHooks = {
    agentIds: () => ["lead", "distiller", "kizaru"],
    agent: (agentId) => (hidden.has(agentId) ? null : { name: agentId[0]?.toUpperCase() + agentId.slice(1) }),
    traffic: (agentId) => (agentId === "lead" ? { received, sent } : { received: [], sent: [] }),
    executionDelivery: () => false,
    keyUsed: (key) => keys.has(key),
    laneBusy: () => busy,
    laneQueued: () => queued,
    providerReady: () => ready,
    enqueue: async ({ agentId, text, idempotencyKey }) => {
      wakes.push({ agentId, text, idempotencyKey });
      keys.add(idempotencyKey);
      received.push({
        ...report("x", 0),
        sender: { kind: "routine", routineId: FORK_FOLLOW_THROUGH_ROUTINE_ID },
        createdAt: new Date(clock).toISOString(),
        replyToMessageId: null,
        replyToSenderAgentId: null,
      });
      return `wake-${wakes.length}`;
    },
    timezone: () => "UTC",
    isRunning: () => true,
    log: () => {},
  };
  const sweep = (minutes: number) => {
    clock = T0 + minutes * MIN;
    return new ForkFollowThrough({ hooks }).sweep(clock);
  };

  beforeEach(() => {
    clock = T0;
    received = [];
    sent = [];
    keys = new Set();
    busy = false;
    queued = 0;
    ready = true;
    hidden = new Set();
    wakes = [];
  });
  afterEach(() => {
    delete process.env.OPENBOT_FORK_FOLLOW_THROUGH;
    delete process.env.OPENBOT_FORK_FOLLOW_THROUGH_GAP_MS;
  });

  it("wakes the lead once per report, also from a new instance (a restart)", async () => {
    process.env.OPENBOT_FORK_FOLLOW_THROUGH_GAP_MS = "0";
    const done = report("distiller", 0);
    received.push(done);
    expect(await sweep(1)).toEqual([]);
    const instance = new ForkFollowThrough({ hooks });
    clock = T0 + 4 * MIN;
    expect(await instance.sweep(clock)).toEqual(["lead"]);
    expect(await instance.sweep(T0 + 5 * MIN)).toEqual([]);
    expect(await sweep(30)).toEqual([]);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]?.idempotencyKey).toBe(followThroughKey(done.id));
    expect(wakes[0]?.text).toContain("- Distiller, 14:00 on 27 Nov (UTC)");
    // Its key alone also holds, as after a restart that dropped the wake's delivery from the window.
    received = [done];
    expect(await sweep(31)).toEqual([]);
  });

  it("groups the pending reports of the lead in one wake, keyed by the oldest", async () => {
    const first = report("kizaru", 0);
    const second = report("distiller", 1);
    received.push(second, first);
    expect(await sweep(5)).toEqual(["lead"]);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]?.idempotencyKey).toBe(followThroughKey(first.id));
    const text = wakes[0]?.text ?? "";
    expect(text.indexOf("- Kizaru")).toBeGreaterThan(0);
    expect(text.indexOf("- Distiller")).toBeGreaterThan(text.indexOf("- Kizaru"));
  });

  it("waits until the lead's own chat is idle and its provider is ready", async () => {
    received.push(report("distiller", 0));
    busy = true;
    expect(await sweep(4)).toEqual([]);
    busy = false;
    queued = 1;
    expect(await sweep(5)).toEqual([]);
    queued = 0;
    ready = false;
    expect(await sweep(6)).toEqual([]);
    ready = true;
    expect(await sweep(7)).toEqual(["lead"]);
  });

  it("wakes an agent at most once per 10 minutes", async () => {
    received.push(report("distiller", 0));
    expect(await sweep(3)).toEqual(["lead"]);
    received.push(report("kizaru", 2));
    expect(await sweep(6)).toEqual([]);
    expect(await sweep(12)).toEqual([]);
    expect(await sweep(13)).toEqual(["lead"]);
    expect(wakes).toHaveLength(2);
    expect(wakes[1]?.text).toContain("- Kizaru");
    expect(wakes[1]?.text).not.toContain("- Distiller");
  });

  it("does nothing when off, for a hidden lead, or for a teammate that is gone", async () => {
    received.push(report("distiller", 0));
    process.env.OPENBOT_FORK_FOLLOW_THROUGH = "0";
    expect(await sweep(5)).toEqual([]);
    delete process.env.OPENBOT_FORK_FOLLOW_THROUGH;
    hidden = new Set(["lead"]);
    expect(await sweep(6)).toEqual([]);
    hidden = new Set(["distiller"]);
    expect(await sweep(7)).toEqual([]);
    hidden = new Set();
    expect(await sweep(8)).toEqual(["lead"]);
  });

  it("gives no wake when the lead already messaged the teammate", async () => {
    received.push(report("distiller", 0));
    sent.push({ id: "next", recipientAgentIds: ["distiller"], createdAt: at(1) });
    expect(await sweep(10)).toEqual([]);
    expect(wakes).toEqual([]);
  });
});
