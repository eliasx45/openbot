// @vitest-environment node
// Fork (docs/fork/FEATURES.md, "Agents continue after a restart"): the wake text, its chat line, the
// subagent id that `SendMessage` takes, and the subagent transcripts that a work-folder move carries.
// The restart flow itself is checked end to end by scripts/restart-resume-e2e.ts.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clampConversationSubagents, isConversationSubagents } from "@openbot/contracts/ipc";
import { afterEach, describe, expect, it } from "vitest";
import { foldClaudeSubagentCall, foldClaudeSubagentResult, newSubagentState } from "./agent/subagent-updates";
import { carryClaudeTranscript, claudeSubagentAgentIds } from "./claude-history";
import {
  ForkRestartResume,
  type ForkRestartResumeHooks,
  parseRunId,
  restartHandOverText,
  restartResumeText,
  restartResumeTitle,
} from "./fork-restart-resume";

const folders: string[] = [];
afterEach(async () => {
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});

const base = {
  kind: "turn" as const,
  interruptedAt: "2026-11-06T13:12:00.000Z",
  timezone: "Europe/Berlin",
  attempt: 1,
  subagents: [],
  requestText: "Render the intro and send it to Zita.",
};

describe("restartResumeText", () => {
  it("says what happened, in the user's zone, and repeats the request", () => {
    const text = restartResumeText(base);
    expect(
      text.startsWith("[OpenBot: 🔄 restart] Your last turn was interrupted at 14:12 on 6 Nov (Europe/Berlin)"),
    ).toBe(true);
    expect(text).toContain("this is not a message from the user");
    expect(text).toContain("Never repeat sends, posts, payments or other outward actions.");
    expect(text).toContain("The request it continues:\nRender the intro and send it to Zita.");
    expect(text).not.toContain("SendMessage");
    expect(text).not.toContain("last automatic try");
  });

  it("names each stopped subagent by the id SendMessage takes", () => {
    const text = restartResumeText({
      ...base,
      subagents: [
        { id: "toolu_1", title: "Build the ease panel", providerAgentId: "a2d43a70933019100", background: true },
        { id: "toolu_2", title: "Check the frames", providerAgentId: null, background: false },
      ],
    });
    expect(text).toContain(
      "These subagents were stopped mid-task: a2d43a70933019100 — Build the ease panel; (agent ID unknown: see your Agent call) — Check the frames.",
    );
    expect(text).toContain("continue it with SendMessage to its agent ID");
    expect(text).toContain("do NOT launch it again from scratch");
  });

  it("after a long downtime still resumes, and asks to check time-sensitive steps", () => {
    const short = restartResumeText({ ...base, now: "2026-11-06T14:00:00.000Z" });
    expect(short).not.toContain("OpenBot was down for about");
    const long = restartResumeText({ ...base, now: "2026-11-07T07:12:00.000Z" });
    expect(long).toContain("OpenBot was down for about 18 hours; it is now 08:12 on 7 Nov (Europe/Berlin).");
    expect(long).toContain("check that it still makes sense now");
    expect(long).toContain("skip that step and tell the user why instead of doing it late");
    expect(long).toContain("Then continue your work.");
    expect(restartResumeText({ ...base, now: "2026-11-09T13:12:00.000Z" })).toContain("about 3 days");
  });

  it("marks the second try as the last one", () => {
    expect(restartResumeText({ ...base, attempt: 2 })).toContain("This is the last automatic try.");
  });

  it("words the subagent and goal cases, and leaves out an empty request", () => {
    expect(restartResumeText({ ...base, kind: "subagents", requestText: "" })).toContain(
      "Your background subagents were stopped at",
    );
    expect(restartResumeText({ ...base, kind: "subagents", requestText: "" })).not.toContain(
      "The request it continues",
    );
    expect(restartResumeText({ ...base, kind: "goal" })).toContain("Your goal turns were stopped at");
  });
});

// Fork (docs/fork/FEATURES.md #113): a message of the user that runs before the restart's wake tells
// the agent what the restart stopped.
describe("restartHandOverText", () => {
  const subagents = [
    { id: "toolu_1", title: "Fork #112 quote in thread pane", providerAgentId: "a8d31d88f5a7d0d48", background: true },
    { id: "toolu_2", title: "Close 4 remaining #107 leaks", providerAgentId: null, background: true },
  ];
  const note = {
    kind: "subagents" as const,
    interruptedAt: "2026-11-25T16:40:40.073Z",
    subagents,
    requestText: "Inside the thread spin up a new thread",
  };

  it("names the stopped Claude subagents by agent ID and says to continue them after the message", () => {
    const text = restartHandOverText({ notes: [note], timezone: "Africa/Algiers", provider: "claude" });
    expect(text.startsWith("[OpenBot: 🔄 restart note] At 17:40 on 25 Nov (Africa/Algiers)")).toBe(true);
    expect(text).toContain("your background subagents were stopped while you waited for them");
    expect(text).toContain("This note is from OpenBot, not from the user.");
    expect(text).toContain(
      "These subagents were stopped mid-task: a8d31d88f5a7d0d48 — Fork #112 quote in thread pane; (agent ID unknown: see your Agent call) — Close 4 remaining #107 leaks.",
    );
    expect(text).toContain("Answer the user's message first.");
    expect(text).toContain("SendMessage to its agent ID");
    expect(text).toContain("do NOT launch it again from scratch");
    expect(text).toContain("never repeat sends, posts, payments");
    expect(text).toContain("The request that was stopped:\nInside the thread spin up a new thread");
    // Not the wake's header: the e2e and the chat tell the two apart.
    expect(text).not.toContain("[OpenBot: 🔄 restart]");
  });

  it("words an interrupted turn, and leaves the subagents out for a provider that cannot continue them", () => {
    const text = restartHandOverText({
      notes: [{ ...note, kind: "turn" }],
      timezone: undefined,
      provider: "codex",
    });
    expect(text).toContain("your last turn was interrupted");
    expect(text).not.toContain("SendMessage");
    expect(text).not.toContain("a8d31d88f5a7d0d48");
    const gemini = restartHandOverText({ notes: [note], timezone: undefined, provider: "antigravity" });
    expect(gemini).toContain("a8d31d88f5a7d0d48 — Fork #112 quote in thread pane");
    expect(gemini).toContain("invoke_subagent");
    expect(gemini).not.toContain("SendMessage");
  });
});

describe("ForkRestartResume.handOverNote", () => {
  const agentId = "agent-gotham";
  const threadId = "openbot-thread-agent-gotham";
  const lines: string[] = [];
  const closed: string[] = [];
  let starting: string[] = [];
  const hooks = (overrides: Partial<ForkRestartResumeHooks> = {}): ForkRestartResumeHooks => ({
    agent: (id) => (id === agentId ? { threadId, provider: "claude" } : null),
    providerReady: () => true,
    session: () => ({ externalSessionId: "session-1" }),
    subagentIds: async () => new Map(),
    subagentOutcomes: async () => new Map(),
    executionDelivery: () => false,
    laneBusy: () => false,
    laneQueued: () => 0,
    continuationQueued: () => false,
    delivery: () => null,
    deliveryOfTurn: () => null,
    // After the capture: the user's messages that are starting in the agent's own chat.
    unresolvedOwnDeliveries: () => starting.map(userDelivery),
    goalWorking: () => false,
    openWait: () => "wait-1",
    waitOpen: () => true,
    closeWait: (_agent, waitId) => closed.push(waitId),
    enqueue: async () => "wake-delivery",
    line: (_agent, text) => lines.push(text),
    timezone: () => "Africa/Algiers",
    isRunning: () => false,
    log: () => {},
    ...overrides,
  });
  const userDelivery = (id: string) => ({
    id,
    messageId: `message-${id}`,
    recipientAgentId: agentId,
    sender: { kind: "user" as const },
    text: "hi",
    attachments: [],
    replyToMessageId: null,
    status: "starting" as const,
    position: null,
    turnId: null,
    error: null,
    createdAt: "2026-11-25T16:42:35.000Z",
  });
  const capture = (resume: ForkRestartResume) => {
    starting = [];
    captureThread(resume);
    starting = ["delivery-user", "delivery-next", "queued", "u"];
  };
  const captureThread = (resume: ForkRestartResume) =>
    resume.capture({
      agentId,
      threadId,
      ownChat: true,
      turnId: null,
      messages: [
        {
          id: "turn-1:subagents",
          turnId: "turn-1",
          author: "assistant",
          text: "- Fork #112",
          createdAt: "2026-11-25T16:30:00.000Z",
          status: "completed",
          itemType: "subagents",
          subagents: [
            {
              id: "toolu_1",
              title: "Fork #112 quote in thread pane",
              agentType: "general-purpose",
              prompt: "Fix it.",
              status: "running",
              startedAt: "2026-11-25T16:30:00.000Z",
              endedAt: null,
              steps: [],
              error: null,
              background: true,
              providerAgentId: "a8d31d88f5a7d0d48",
            },
          ],
        },
      ],
    });

  it("gives the pending note to the user's message once, closes the wait, and stops the wake", () => {
    const resume = new ForkRestartResume({ databasePath: "relative.db", hooks: hooks() });
    capture(resume);
    resume.start();
    expect(resume.entries()[0]?.state).toBe("pending");
    const input = { agentId, deliveryId: "delivery-user", typed: "why is stuff not auto resuming?" };
    const text = resume.handOverNote(input);
    expect(text).toContain("a8d31d88f5a7d0d48 — Fork #112 quote in thread pane");
    expect(resume.entries()[0]?.state).toBe("skipped");
    expect(resume.entries()[0]?.reason).toBe("another turn started since the restart");
    expect(closed).toContain("wait-1");
    // The same delivery's prompt built again: the same note. Another message: nothing more.
    expect(resume.handOverNote(input)).toBe(text);
    expect(resume.handOverNote({ ...input, deliveryId: "delivery-next" })).toBeNull();
    resume.dispose();
  });

  it("gives nothing to a slash command, a message of a task thread, or when the switch is off", () => {
    const resume = new ForkRestartResume({ databasePath: "relative.db", hooks: hooks() });
    capture(resume);
    resume.start();
    const input = { agentId, deliveryId: "delivery-user", typed: "/compact" };
    expect(resume.handOverNote(input)).toBeNull();
    expect(resume.handOverNote({ ...input, typed: "hi", deliveryId: "task-delivery" })).toBeNull();
    expect(resume.entries()[0]?.state).toBe("pending");
    resume.setEnabled(false);
    expect(resume.handOverNote({ ...input, typed: "hi" })).toBeNull();
    resume.dispose();
  });

  it("a note skipped because a message waited in the queue goes to that message", () => {
    const resume = new ForkRestartResume({ databasePath: "relative.db", hooks: hooks({ laneQueued: () => 1 }) });
    capture(resume);
    expect(resume.entries()[0]?.reason).toBe("a queued message runs instead");
    expect(resume.handOverNote({ agentId, deliveryId: "queued", typed: "and also do this" })).toContain(
      "a8d31d88f5a7d0d48",
    );
    expect(resume.entries()[0]?.reason).toBe("a queued message runs instead");
  });

  it("a note still pending from an earlier start (a crash before its wake) goes to the message too", async () => {
    const folder = await mkdtemp(join(tmpdir(), "openbot-restart-hand-over-"));
    folders.push(folder);
    const databasePath = join(folder, "openbot.db");
    const first = new ForkRestartResume({ databasePath, hooks: hooks() });
    capture(first);
    first.start();
    first.dispose();
    const second = new ForkRestartResume({ databasePath, hooks: hooks() });
    second.start();
    expect(second.entries()[0]?.state).toBe("pending");
    expect(second.handOverNote({ agentId, deliveryId: "delivery-user", typed: "hi" })).toContain("a8d31d88f5a7d0d48");
    expect(second.entries()[0]?.handedTo).toBe("delivery-user");
    second.dispose();
  });

  it("a note of a routine run is not handed over", () => {
    const resume = new ForkRestartResume({
      databasePath: "relative.db",
      hooks: hooks({
        unresolvedOwnDeliveries: () => [
          {
            id: "run-delivery",
            messageId: "m",
            recipientAgentId: agentId,
            sender: { kind: "routine", routineId: "r", runId: "x", routineName: "Daily", scheduledFor: "" },
            text: "Daily run",
            attachments: [],
            replyToMessageId: null,
            status: "running",
            position: null,
            turnId: "turn-9",
            error: null,
            createdAt: "2026-11-25T16:30:00.000Z",
          },
        ],
      }),
    });
    resume.capture({ agentId, threadId, ownChat: true, turnId: "turn-9", messages: [] });
    expect(resume.entries()[0]?.reason).toBe("routine run");
    expect(resume.handOverNote({ agentId, deliveryId: "u", typed: "hi" })).toBeNull();
  });
});

describe("restartResumeTitle", () => {
  it("fits the 80-character routine name of the contract", () => {
    expect(restartResumeTitle(1)).toBe("🔄 Resumed after restart");
    expect(restartResumeTitle(2)).toBe("🔄 Resumed after restart (second try)");
    expect(restartResumeTitle(2).length).toBeLessThanOrEqual(80);
  });
});

describe("parseRunId", () => {
  it("reads the try and the interrupted work back from a wake's run id", () => {
    expect(parseRunId("restart-resume:2:turn:p1-turn-4")).toEqual({ attempt: 2, key: "turn:p1-turn-4" });
    expect(parseRunId("run-123")).toBeNull();
  });
});

describe("Claude subagent ids", () => {
  it("keeps the agentId of a background Agent result", () => {
    const state = newSubagentState();
    foldClaudeSubagentCall(
      state,
      "turn-1",
      { id: "toolu_1", name: "Agent", input: { description: "Render", prompt: "Go", run_in_background: true } },
      "2026-11-06T10:00:00.000Z",
    );
    const change = foldClaudeSubagentResult(
      state,
      "toolu_1",
      { isAsync: true, status: "async_launched", agentId: "a2d43a70933019100" },
      false,
      "",
      "2026-11-06T10:00:01.000Z",
    );
    expect(change?.subagents[0]?.providerAgentId).toBe("a2d43a70933019100");
    expect(change?.subagents[0]?.background).toBe(true);
    expect(change?.subagents[0]?.status).toBe("running");
  });

  it("stores and decodes the id with the subagent", () => {
    const [subagent] =
      clampConversationSubagents([
        {
          id: "toolu_1",
          title: "Render",
          agentType: null,
          prompt: null,
          status: "running",
          startedAt: "2026-11-06T10:00:00.000Z",
          endedAt: null,
          steps: [],
          error: null,
          background: true,
          providerAgentId: "a2d43a70933019100",
        },
      ]) ?? [];
    expect(subagent?.providerAgentId).toBe("a2d43a70933019100");
    expect(isConversationSubagents([subagent])).toBe(true);
    expect(isConversationSubagents([{ ...subagent, providerAgentId: "" }])).toBe(false);
  });
});

describe("Claude subagent transcripts", () => {
  async function configWithSession(): Promise<{ config: string; oldProject: string; sessionId: string }> {
    const config = await mkdtemp(join(tmpdir(), "openbot-claude-config-"));
    folders.push(config);
    const sessionId = "6f1c3a52-0000-4000-8000-000000000001";
    const oldProject = join(config, "projects", "-Users-elias-OpenBot-Agents-agent-1");
    await mkdir(join(oldProject, sessionId, "subagents"), { recursive: true });
    await writeFile(join(oldProject, `${sessionId}.jsonl`), '{"type":"user"}\n');
    await writeFile(
      join(oldProject, sessionId, "subagents", "agent-a2d43a70933019100.jsonl"),
      '{"agentId":"a2d43a70933019100"}\n',
    );
    await writeFile(
      join(oldProject, sessionId, "subagents", "agent-a2d43a70933019100.meta.json"),
      JSON.stringify({ description: "Render", toolUseId: "toolu_1" }),
    );
    return { config, oldProject, sessionId };
  }

  it("reads each subagent's agentId by the call that started it", async () => {
    const { config, sessionId } = await configWithSession();
    expect(await claudeSubagentAgentIds(sessionId, undefined, config)).toEqual(
      new Map([["toolu_1", "a2d43a70933019100"]]),
    );
  });

  it("carries the subagents folder with the session to a new work folder", async () => {
    const { config, sessionId } = await configWithSession();
    const workFolder = "/Users/elias/Developer/motion-kit";
    await carryClaudeTranscript(sessionId, workFolder, config);
    const target = join(config, "projects", "-Users-elias-Developer-motion-kit");
    expect(await readFile(join(target, `${sessionId}.jsonl`), "utf8")).toBe('{"type":"user"}\n');
    expect(await readFile(join(target, sessionId, "subagents", "agent-a2d43a70933019100.jsonl"), "utf8")).toContain(
      "a2d43a70933019100",
    );
    expect(await claudeSubagentAgentIds(sessionId, workFolder, config)).toEqual(
      new Map([["toolu_1", "a2d43a70933019100"]]),
    );
  });
});
