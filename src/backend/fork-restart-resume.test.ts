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
import { parseRunId, restartResumeText, restartResumeTitle } from "./fork-restart-resume";

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
