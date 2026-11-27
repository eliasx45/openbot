// @vitest-environment node
// Fork (docs/fork/FEATURES.md #135, "Team watchdogs and guards"): which teammates working on a lead's
// request look stuck (quiet, looping, overdue), and the one wake per request and pattern that the lead
// gets, over sweeps and a restart.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TeamMetaStore, type TeamRequestMeta, type TeamRequestRecord } from "./fork-team-guards";
import {
  ForkTeamWatchdog,
  type ForkTeamWatchdogHooks,
  loopEvidence,
  TurnToolLog,
  type WatchTeammate,
  type WatchToolStep,
  watchdogWakeKey,
  watchFlags,
} from "./fork-team-watchdog";

const MIN = 60_000;
const T0 = Date.parse("2026-11-27T14:00:00.000Z");
const at = (minutes: number) => T0 + minutes * MIN;
const iso = (minutes: number) => new Date(at(minutes)).toISOString();
const THRESHOLDS = { quietMs: 20 * MIN, repeats: 4, failures: 3 };

type Delivery = TeamRequestRecord["deliveries"][number];

function request(extra: Partial<TeamRequestRecord> = {}, delivery: Partial<Delivery> = {}): TeamRequestRecord {
  return {
    id: "req-1",
    senderAgentId: "vegapunk",
    text: "Render the 30 s promo at 4K and send me the path.",
    createdAt: iso(0),
    channel: false,
    deliveries: [
      {
        id: "delivery-1",
        recipientAgentId: "chopper",
        status: "running",
        turnId: "turn-1",
        createdAt: iso(0),
        steeredAt: null,
        repliedAt: null,
        ...delivery,
      },
    ],
    ...extra,
  };
}

function step(index: number, minutes: number, extra: Partial<WatchToolStep> = {}): WatchToolStep {
  return {
    itemId: `item-${index}`,
    name: "shell",
    signature: `shell {"command":"ls ${index}"}`,
    startedAt: at(minutes),
    endedAt: at(minutes),
    failed: false,
    ...extra,
  };
}

const teammate = (extra: Partial<WatchTeammate> = {}): WatchTeammate => ({
  turnStartedAt: at(0),
  lastEventAt: null,
  declaredWait: null,
  backgroundHold: false,
  steps: [],
  ...extra,
});

function flags(input: { record?: TeamRequestRecord; meta?: TeamRequestMeta; mate?: WatchTeammate; minutes: number }) {
  const record = input.record ?? request();
  const delivery = record.deliveries[0];
  if (!delivery) throw new Error("no delivery");
  return watchFlags({
    request: record,
    delivery,
    meta: input.meta,
    teammate: input.mate ?? teammate(),
    now: at(input.minutes),
    thresholds: THRESHOLDS,
    timezone: "UTC",
  });
}

const patterns = (found: ReturnType<typeof flags>) => found.map((flag) => flag.pattern);

describe("quiet", () => {
  it("flags a running turn with no new step or output for 20 minutes", () => {
    const mate = teammate({ steps: [step(1, 2, { name: "render.py", endedAt: null })] });
    expect(patterns(flags({ mate, minutes: 21 }))).toEqual([]);
    const found = flags({ mate, minutes: 22 });
    expect(patterns(found)).toEqual(["quiet"]);
    expect(found[0]?.evidence).toContain("nothing new came from it for 20 min");
    expect(found[0]?.evidence).toContain("last step: `render.py` at 14:02");
    expect(found[0]?.evidence).toContain("still running");
  });

  it("counts any output of the teammate as activity", () => {
    expect(patterns(flags({ mate: teammate({ lastEventAt: at(15) }), minutes: 30 }))).toEqual([]);
    expect(patterns(flags({ mate: teammate({ lastEventAt: at(15) }), minutes: 35 }))).toEqual(["quiet"]);
  });

  it("does not flag a declared wait or a background hold after an answer", () => {
    expect(patterns(flags({ mate: teammate({ declaredWait: "the render's out.mp4" }), minutes: 60 }))).toEqual([]);
    expect(patterns(flags({ mate: teammate({ backgroundHold: true }), minutes: 60 }))).toEqual([]);
  });

  it("does not flag a turn that does not run, a queued request or a replied one", () => {
    expect(patterns(flags({ mate: teammate({ turnStartedAt: null }), minutes: 60 }))).toEqual([]);
    expect(patterns(flags({ record: request({}, { status: "queued", turnId: null }), minutes: 60 }))).toEqual([]);
    expect(patterns(flags({ record: request({}, { repliedAt: iso(50) }), minutes: 60 }))).toEqual([]);
  });

  it("counts from when a request was steered into a turn that ran before", () => {
    const record = request({}, { steeredAt: iso(30) });
    expect(patterns(flags({ record, mate: teammate({ turnStartedAt: at(-60) }), minutes: 45 }))).toEqual([]);
    expect(patterns(flags({ record, mate: teammate({ turnStartedAt: at(-60) }), minutes: 50 }))).toEqual(["quiet"]);
  });
});

describe("looping", () => {
  it("flags four identical calls in a row, not three, and not four with another between", () => {
    const same = (index: number, minutes: number) => step(index, minutes, { signature: 'shell {"command":"ls"}' });
    const three = [same(1, 1), same(2, 2), same(3, 3)];
    expect(patterns(flags({ mate: teammate({ steps: three }), minutes: 4 }))).toEqual([]);
    const four = [...three, same(4, 4)];
    const found = flags({ mate: teammate({ steps: four }), minutes: 5 });
    expect(patterns(found)).toEqual(["looping"]);
    expect(found[0]?.evidence).toContain('last 4 tool calls were the same call, `shell {"command":"ls"}`');
    const broken = [same(1, 1), same(2, 2), step(9, 3), same(3, 3), same(4, 4)];
    expect(patterns(flags({ mate: teammate({ steps: broken }), minutes: 5 }))).toEqual([]);
  });

  it("flags three failed calls in a row", () => {
    const failing = [1, 2, 3].map((index) => step(index, index, { failed: true, name: "openbot.generate_video" }));
    const found = flags({ mate: teammate({ steps: failing }), minutes: 4 });
    expect(patterns(found)).toEqual(["looping"]);
    expect(found[0]?.evidence).toContain("last 3 tool calls failed, the last `openbot.generate_video`");
  });

  it("ignores calls from before the request reached the turn", () => {
    const same = (index: number, minutes: number) => step(index, minutes, { signature: "same" });
    const record = request({}, { steeredAt: iso(10) });
    const steps = [same(1, 1), same(2, 2), same(3, 3), same(4, 11)];
    expect(patterns(flags({ record, mate: teammate({ turnStartedAt: at(0), steps }), minutes: 12 }))).toEqual([]);
  });

  it("finds the loop in a turn's items as they arrive", () => {
    const log = new TurnToolLog();
    for (const index of [1, 2, 3, 4]) {
      const item = { type: "toolCall", id: `call-${index}`, name: "Read", arguments: { file_path: "/a.txt" } };
      log.observe("turn-1", { ...item, status: "in_progress" }, false, false, at(index));
      log.observe("turn-1", { ...item, status: "completed" }, true, false, at(index));
    }
    expect(loopEvidence(log.steps("turn-1"), 0, THRESHOLDS)).toMatchObject({
      kind: "same-call",
      count: 4,
      name: "Read",
    });
    log.observe(
      "turn-1",
      { type: "toolCall", id: "call-5", name: "Read", arguments: { file_path: "/b.txt" } },
      true,
      false,
    );
    expect(loopEvidence(log.steps("turn-1"), 0, THRESHOLDS)).toBeNull();
  });
});

describe("overdue", () => {
  const meta: TeamRequestMeta = { sender: "vegapunk", hops: 1, root: "vegapunk", createdAt: iso(0), dueMinutes: 30 };

  it("flags a request whose due time passed without a reply, whatever the teammate does", () => {
    const busy = teammate({ lastEventAt: at(29) });
    expect(patterns(flags({ meta, mate: busy, minutes: 29 }))).toEqual([]);
    const found = flags({ meta, mate: busy, minutes: 31 });
    expect(patterns(found)).toEqual(["overdue"]);
    expect(found[0]?.evidence).toContain("you gave it 30 min (due 14:30");
    const queued = flags({ meta, record: request({}, { status: "queued", turnId: null }), minutes: 31 });
    expect(queued[0]?.evidence).toContain("it has not started on it yet");
    const ended = flags({
      meta,
      record: request({}, { status: "completed" }),
      mate: teammate({ turnStartedAt: null }),
      minutes: 31,
    });
    expect(ended[0]?.evidence).toContain("its turn ended without a reply");
  });

  it("is not flagged without dueMinutes or after the reply", () => {
    expect(patterns(flags({ mate: teammate({ lastEventAt: at(100) }), minutes: 100 }))).toEqual([]);
    expect(patterns(flags({ meta, record: request({}, { repliedAt: iso(40) }), minutes: 60 }))).toEqual([]);
  });
});

describe("ForkTeamWatchdog", () => {
  let dir: string;
  let records: TeamRequestRecord[];
  let enqueued: Array<{ agentId: string; runId: string; text: string; idempotencyKey: string }>;
  let busy: Set<string>;
  let ready: boolean;
  let mate: WatchTeammate;
  let store: TeamMetaStore;
  const savedEnv = { ...process.env };

  const hooks = (): ForkTeamWatchdogHooks => ({
    agent: (agentId) => (agentId === "gone" ? null : { name: agentId[0]?.toUpperCase() + agentId.slice(1) }),
    requests: () => records,
    store,
    executionDelivery: () => false,
    turnStartedAt: () => mate.turnStartedAt,
    lastEventAt: () => mate.lastEventAt,
    declaredWait: () => mate.declaredWait,
    backgroundHold: () => mate.backgroundHold,
    keyUsed: (key) => enqueued.some((wake) => wake.idempotencyKey === key),
    laneBusy: (agentId) => busy.has(agentId),
    laneQueued: () => 0,
    providerReady: () => ready,
    enqueue: async (input) => {
      enqueued.push(input);
      return "queued";
    },
    timezone: () => "UTC",
    isRunning: () => true,
    log: () => {},
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "team-watchdog-"));
    store = new TeamMetaStore(join(dir, "openbot.sqlite"));
    process.env.OPENBOT_FORK_TEAM_OPEN_WINDOW_MS = String(365 * 24 * 60 * MIN);
    records = [request()];
    enqueued = [];
    busy = new Set();
    ready = true;
    mate = teammate();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    process.env = { ...savedEnv };
  });

  it("wakes the lead once per request and pattern, over sweeps and a restart", async () => {
    const watchdog = new ForkTeamWatchdog({ hooks: hooks() });
    expect(await watchdog.sweep(at(10))).toEqual([]);
    expect(await watchdog.sweep(at(25))).toEqual(["vegapunk"]);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]?.agentId).toBe("vegapunk");
    expect(enqueued[0]?.idempotencyKey).toBe(watchdogWakeKey("req-1:chopper:quiet"));
    expect(enqueued[0]?.text).toContain("[OpenBot: 🐕 team watchdog]");
    expect(enqueued[0]?.text).toContain("- Chopper (chopper), your request req-1 of 14:00");
    expect(enqueued[0]?.text).toContain("openbot.routine_no_update");
    expect(enqueued[0]?.text).toContain("openbot.interrupt_agent");
    expect(await watchdog.sweep(at(40))).toEqual([]);
    // A restart: a new watchdog on the same file, and the mailbox keeps the wake's key.
    store = new TeamMetaStore(join(dir, "openbot.sqlite"));
    expect(await new ForkTeamWatchdog({ hooks: hooks() }).sweep(at(90))).toEqual([]);
    expect(enqueued).toHaveLength(1);
  });

  it("wakes again for another pattern of the same request, after the gap", async () => {
    const watchdog = new ForkTeamWatchdog({ hooks: hooks() });
    expect(await watchdog.sweep(at(25))).toEqual(["vegapunk"]);
    // The teammate's turn calls the same tool four times (minutes 26 to 29); the gap is 5 minutes.
    for (const index of [1, 2, 3, 4]) {
      const item = { type: "commandExecution", id: `cmd-${index}`, command: "ls /renders" };
      watchdog.tools.observe("turn-1", { ...item, status: "completed" }, true, false, at(25 + index));
    }
    expect(await watchdog.sweep(at(29.5))).toEqual([]);
    expect(await watchdog.sweep(at(30))).toEqual(["vegapunk"]);
    expect(enqueued[1]?.text).toContain("looping");
    expect(enqueued[1]?.text).not.toContain("quiet:");
  });

  it("groups the flags of several teammates in one wake", async () => {
    records = [
      request(),
      request(
        { id: "req-2", text: "Train the LoRA" },
        { id: "delivery-2", recipientAgentId: "nami", turnId: "turn-2" },
      ),
    ];
    await new ForkTeamWatchdog({ hooks: hooks() }).sweep(at(25));
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]?.text).toContain("Chopper (chopper)");
    expect(enqueued[0]?.text).toContain("Nami (nami)");
    expect(store.flagged("req-2:nami:quiet")).toBeDefined();
  });

  it("waits while the lead is busy or its provider is not ready", async () => {
    const watchdog = new ForkTeamWatchdog({ hooks: hooks() });
    busy.add("vegapunk");
    expect(await watchdog.sweep(at(25))).toEqual([]);
    busy.clear();
    ready = false;
    expect(await watchdog.sweep(at(26))).toEqual([]);
    ready = true;
    expect(await watchdog.sweep(at(27))).toEqual(["vegapunk"]);
  });

  it("is off with OPENBOT_FORK_TEAM_WATCHDOG=0, and skips gone agents and channels", async () => {
    process.env.OPENBOT_FORK_TEAM_WATCHDOG = "0";
    expect(await new ForkTeamWatchdog({ hooks: hooks() }).sweep(at(25))).toEqual([]);
    delete process.env.OPENBOT_FORK_TEAM_WATCHDOG;
    records = [request({ senderAgentId: "gone" }), request({ id: "req-3", channel: true })];
    expect(await new ForkTeamWatchdog({ hooks: hooks() }).sweep(at(25))).toEqual([]);
  });

  it("takes its thresholds from the environment", async () => {
    process.env.OPENBOT_FORK_TEAM_WATCHDOG_QUIET_MS = String(2 * MIN);
    expect(await new ForkTeamWatchdog({ hooks: hooks() }).sweep(at(3))).toEqual(["vegapunk"]);
  });
});
