/**
 * Fork (docs/fork/FEATURES.md, "/goal"): an agent keeps working until a goal is done. Idea and
 * prompt wording adapted from OpenMausBot's goal mode (Apache-2.0, `server/group-goal-run.ts`).
 *
 * The user sends `/goal <goal>` in an agent's own chat. Each turn ends with the agent calling
 * `openbot.goal_status`: `continue` (with its next step), `waiting` (teammates work for it),
 * `completed`, `needs-input` or `blocked`. On `continue`, the turn goes on the way a plan does
 * (`PlanContinuation.continueGoal`): the same deliveries, the same provider session, so the agent
 * keeps everything it knew, with the goal prompt as the note of the next turn. A turn that ends
 * without a status gets one reminder turn, then the goal stops as blocked.
 *
 * Stops: the user's Stop button, `/goal stop`, a status other than continue/waiting, the turn limit
 * (`/goal continue` gives it the same number of turns again). A goal that needs the user, waits for
 * teammates, or lost its chain (a restart, a queued message) continues at the agent's next turn in
 * its own chat: every prompt there carries a goal footer that asks for `goal_status`.
 *
 * Goals are kept in a small JSON file beside the database, one per agent.
 */

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { sourceText } from "@openbot/i18n/source";
import { z } from "zod";
import { type OpenBotToolResponse, openBotToolFailure, openBotToolResult } from "./agent/routine-tools";
import type { DynamicToolCallParams } from "./protocol";

export const GOAL_STATUS_TOOL = "goal_status";
const DEFAULT_GOAL_TURNS = 25;
const MAX_GOAL_TURNS = 200;
const FILE = "fork-goals.json";
/** How long a command line waits for its turn to start before it is appended on its own. */
const START_LINE_WAIT_MS = 60_000;

export const goalStatusToolSchema = z.strictObject({
  status: z
    .enum(["continue", "waiting", "completed", "needs-input", "blocked"])
    .describe(
      "continue: OpenBot starts your next goal turn now. waiting: teammates work for you; their answers start your next turn. completed / needs-input / blocked end the goal turns.",
    ),
  next: z.string().trim().max(2000).optional().describe("For continue: the concrete next step you will do."),
  detail: z
    .string()
    .trim()
    .max(1000)
    .optional()
    .describe("For the other statuses: the result, the question for the user, what you wait for, or the blocker."),
});

type GoalReport = z.infer<typeof goalStatusToolSchema>;

export type GoalState = "working" | "waiting" | "paused" | "completed" | "blocked" | "limit" | "stopped";

export interface Goal {
  agentId: string;
  text: string;
  state: GoalState;
  /** Goal turns started so far, the first one included. */
  turn: number;
  maxTurns: number;
  /** The `/goal` message that started it, so a retried prompt does not start it twice. */
  startedBy: string;
  startedAt: string;
  /** Consecutive turns that ended without `goal_status`. */
  misses: number;
  next: string | null;
  detail: string | null;
}

export interface ForkGoalsHooks {
  /** A status line in the agent's own chat, outside any turn. */
  line(agentId: string, text: string): void;
  notify(title: string, body: string): void;
  agentName(agentId: string): string;
}

/** What a turn that just ended does next: continue with this note, or end. */
export interface GoalContinuation {
  note: string;
  line: string;
  current: number;
  limit: number;
}

export class ForkGoals {
  readonly #file: string | null;
  readonly #hooks: ForkGoalsHooks;
  readonly #goals = new Map<string, Goal>();
  /** The status an agent reported in the turn that runs now. */
  readonly #reports = new Map<string, GoalReport>();
  /** While `turnEnded` runs: the agent whose ending turn takes the chat line, and that line. */
  #ending: { agentId: string; line: string | null } | null = null;
  /** Lines of `/goal` commands, per agent, for the turn that starts next. */
  readonly #starting = new Map<string, string[]>();

  constructor(options: { databasePath: string; hooks: ForkGoalsHooks }) {
    this.#hooks = options.hooks;
    this.#file = options.databasePath.startsWith("/") ? join(dirname(options.databasePath), FILE) : null;
    if (!this.#file) return;
    try {
      const saved = JSON.parse(readFileSync(this.#file, "utf8"));
      const goals = isDynamicRecord(saved) && Array.isArray(saved.goals) ? saved.goals : [];
      for (const goal of goals) if (isGoal(goal)) this.#goals.set(goal.agentId, goal);
    } catch {}
  }

  get(agentId: string): Goal | null {
    return this.#goals.get(agentId) ?? null;
  }

  /** Whether the agent's own-chat prompts carry the goal footer. */
  active(agentId: string): Goal | null {
    const goal = this.#goals.get(agentId);
    return goal && (goal.state === "working" || goal.state === "waiting" || goal.state === "paused") ? goal : null;
  }

  /**
   * The prompt for a `/goal …` message. `rest` is what follows `/goal`. Idempotent per message:
   * the same delivery prompt built again (a retry, a steer) gives the same text.
   */
  command(agentId: string, messageId: string, rest: string): string {
    const words = rest.trim();
    const current = this.#goals.get(agentId);
    if (/^(?:stop|cancel|off|end)$/iu.test(words)) {
      if (current && this.active(agentId)) {
        this.#finish(current, "stopped", "");
        return `The user stopped goal mode for the goal "${current.text}". Do not continue working on it. Acknowledge in one short line.`;
      }
      return "The user asked to stop goal mode, but no goal is running. Say so in one short line.";
    }
    if (/^(?:continue|resume|go on)$/iu.test(words) || (words === "" && current && current.state !== "working")) {
      if (!current)
        return "The user asked to continue a goal, but there is none yet. Tell them to start one with /goal <goal>.";
      if (current.startedBy !== messageId) {
        current.startedBy = messageId;
        current.maxTurns = Math.min(MAX_GOAL_TURNS, current.turn + current.maxTurns);
        current.turn += 1;
        current.state = "working";
        current.misses = 0;
        this.#save();
        this.#line(
          agentId,
          sourceText("status.agent.goalResumed", {
            current: current.turn,
            limit: current.maxTurns,
            goal: current.text,
          }),
        );
      }
      return goalPrompt(
        current,
        "The user asked you to continue this goal. Pick up from where the conversation stands.",
      );
    }
    if (words === "") {
      return current
        ? `Goal mode runs for "${current.text}" (turn ${current.turn} of ${current.maxTurns}). Tell the user where it stands in a few lines, then call openbot.${GOAL_STATUS_TOOL}.`
        : "The user typed /goal without a goal. Explain in two lines: /goal <goal> makes you keep working turn after turn until the goal is done (or /goal --turns N <goal>), and /goal stop ends it.";
    }
    if (current?.startedBy === messageId) return goalPrompt(current, null);
    const turns = /^--turns\s+(\d{1,3})\s+/u.exec(words);
    const text = (turns ? words.slice(turns[0].length) : words).trim().slice(0, 4000);
    const goal: Goal = {
      agentId,
      text,
      state: "working",
      turn: 1,
      maxTurns: Math.max(2, Math.min(MAX_GOAL_TURNS, turns ? Number(turns[1]) : DEFAULT_GOAL_TURNS)),
      startedBy: messageId,
      startedAt: new Date().toISOString(),
      misses: 0,
      next: null,
      detail: null,
    };
    if (current && this.active(agentId))
      this.#line(agentId, sourceText("status.agent.goalReplaced", { goal: current.text }));
    this.#goals.set(agentId, goal);
    this.#reports.delete(agentId);
    this.#save();
    return goalPrompt(goal, null);
  }

  /**
   * The footer for any other prompt in the agent's own chat while a goal runs: a teammate's
   * answer, the user's reply to a question, a message queued during the goal.
   */
  footer(agentId: string, fromUser: boolean): string | null {
    const goal = this.active(agentId);
    if (!goal) return null;
    if (goal.state !== "working") {
      goal.state = "working";
      goal.misses = 0;
      this.#save();
    }
    return [
      `[Goal mode is on — goal: "${goal.text}" (turn ${goal.turn} of ${goal.maxTurns}).`,
      fromUser
        ? "Handle this message from the user first; it can change the goal or answer your question."
        : "Use this message for the goal.",
      `Then, as your last action, call openbot.${GOAL_STATUS_TOOL}: continue (with next), waiting, completed, needs-input or blocked.]`,
    ].join(" ");
  }

  handleTool(
    params: DynamicToolCallParams,
    caller: { agentId: string; inExecutionThread: boolean },
  ): OpenBotToolResponse | null {
    if (params.tool !== GOAL_STATUS_TOOL) return null;
    const parsed = goalStatusToolSchema.safeParse(params.arguments);
    if (!parsed.success) return openBotToolFailure(z.prettifyError(parsed.error));
    const report = parsed.data;
    if (caller.inExecutionThread) return openBotToolFailure("Goal mode runs only in your own chat.");
    const goal = this.active(caller.agentId);
    if (!goal) return openBotToolFailure("No goal runs in your chat. The user starts one with /goal <goal>.");
    if (report.status === "continue" && !report.next) return openBotToolFailure("continue needs next: your next step.");
    if (report.status !== "continue" && !report.detail) return openBotToolFailure(`${report.status} needs detail.`);
    this.#reports.set(caller.agentId, report);
    const left = goal.maxTurns - goal.turn;
    return openBotToolResult({
      recorded: report.status,
      note:
        report.status === "continue"
          ? left > 0
            ? `OpenBot starts goal turn ${goal.turn + 1} of ${goal.maxTurns} when this turn ends. End your turn now.`
            : "This was the last goal turn: the goal stops at the turn limit. Tell the user what is left."
          : report.status === "waiting"
            ? "The goal waits. Your next turn starts when a teammate answers or the user writes."
            : "The goal turns end with this turn.",
    });
  }

  /**
   * The agent's own-chat turn ended. Returns the continuation to run now, or null. `mayContinue` is
   * false when the turn cannot go on by itself (it failed, was stopped, the agent asked the user
   * something in the UI, or another message waits in the lane).
   */
  turnEnded(
    agentId: string,
    input: { outcome: string; stopped: boolean; mayContinue: boolean },
  ): GoalContinuation | null {
    this.#ending = { agentId, line: null };
    try {
      return this.#turnEnded(agentId, input);
    } finally {
      if (this.#ending?.line === null) this.#ending = null;
    }
  }

  /**
   * The line that the turn which just ended adds after its answer (the goal ended or paused), or
   * null. The turn writes it with its own snapshot, so the chat shows it at once.
   */
  takeLine(agentId: string): string | null {
    const ending = this.#ending;
    if (ending?.agentId !== agentId) return null;
    this.#ending = null;
    return ending.line;
  }

  #turnEnded(
    agentId: string,
    input: { outcome: string; stopped: boolean; mayContinue: boolean },
  ): GoalContinuation | null {
    const goal = this.active(agentId);
    const report = this.#reports.get(agentId);
    this.#reports.delete(agentId);
    if (goal?.state !== "working") return null;
    if (input.stopped) {
      this.#finish(goal, "stopped", "");
      return null;
    }
    // Interrupted by OpenBot, not the user (a requeue after a usage limit): the delivery runs again.
    if (input.outcome === "interrupted") return null;
    if (input.outcome === "failed") {
      goal.state = "paused";
      this.#save();
      this.#line(agentId, sourceText("status.agent.goalFailedTurn"));
      return null;
    }
    if (report && report.status !== "continue") {
      if (report.status === "waiting") {
        goal.state = "waiting";
        goal.detail = report.detail ?? null;
        goal.misses = 0;
        this.#save();
        this.#line(agentId, sourceText("status.agent.goalWaits", { detail: report.detail ?? "" }));
        return null;
      }
      const state =
        report.status === "completed" ? "completed" : report.status === "needs-input" ? "paused" : "blocked";
      if (state === "paused") {
        goal.state = "paused";
        goal.detail = report.detail ?? null;
        this.#save();
        this.#line(agentId, sourceText("status.agent.goalNeedsYou", { detail: report.detail ?? "" }));
        this.#hooks.notify(`${this.#hooks.agentName(agentId)}: goal needs you`, report.detail ?? "");
        return null;
      }
      this.#finish(goal, state, report.detail ?? "");
      return null;
    }
    let note: string;
    if (report) {
      goal.misses = 0;
      goal.next = report.next ?? null;
      note = `Your next step: ${report.next}`;
    } else {
      goal.misses += 1;
      if (goal.misses > 1) {
        this.#finish(goal, "blocked", `Two turns ended without openbot.${GOAL_STATUS_TOOL}.`);
        return null;
      }
      note = `Your last turn ended without openbot.${GOAL_STATUS_TOOL}. Decide now: continue the work, or report completed, needs-input or blocked.`;
    }
    if (goal.turn >= goal.maxTurns) {
      this.#finish(goal, "limit", "");
      return null;
    }
    if (!input.mayContinue) {
      goal.state = "paused";
      this.#save();
      return null;
    }
    goal.turn += 1;
    this.#save();
    return {
      note: goalPrompt(goal, note),
      line: goal.next
        ? sourceText("status.agent.goalTurn", {
            current: goal.turn,
            limit: goal.maxTurns,
            next: goal.next.slice(0, 160),
          })
        : sourceText("status.agent.goalTurnNoStep", { current: goal.turn, limit: goal.maxTurns }),
      current: goal.turn,
      limit: goal.maxTurns,
    };
  }

  #finish(goal: Goal, state: GoalState, detail: string): void {
    goal.state = state;
    goal.detail = detail;
    this.#save();
    const line =
      state === "completed"
        ? sourceText("status.agent.goalCompleted", { detail })
        : state === "stopped"
          ? sourceText("status.agent.goalStopped")
          : state === "limit"
            ? sourceText("status.agent.goalLimit", { limit: goal.maxTurns })
            : sourceText("status.agent.goalBlocked", { detail });
    this.#line(goal.agentId, line);
    if (state !== "stopped") this.#hooks.notify(this.#hooks.agentName(goal.agentId), line);
  }

  /** A chat line: with the ending turn when one ends now, else on its own. */
  /**
   * The lines that a `/goal` command made (resumed, replaced, stopped) for the turn that the command
   * starts now. That turn writes them with its own snapshot, so the chat shows them at once.
   */
  takeStartLines(agentId: string): string[] {
    const lines = this.#starting.get(agentId) ?? [];
    this.#starting.delete(agentId);
    return lines;
  }

  #line(agentId: string, text: string): void {
    if (this.#ending?.agentId === agentId) {
      this.#ending.line = text;
      return;
    }
    // A command line waits for the turn the command starts; with no turn, it is appended later.
    this.#starting.set(agentId, [...(this.#starting.get(agentId) ?? []), text]);
    setTimeout(() => {
      const waiting = this.#starting.get(agentId);
      if (!waiting?.includes(text)) return;
      this.#starting.set(
        agentId,
        waiting.filter((line) => line !== text),
      );
      this.#hooks.line(agentId, text);
    }, START_LINE_WAIT_MS).unref?.();
  }

  #save(): void {
    if (!this.#file) return;
    try {
      const temporary = `${this.#file}.tmp`;
      writeFileSync(temporary, JSON.stringify({ goals: [...this.#goals.values()] }, null, 2));
      renameSync(temporary, this.#file);
    } catch {}
  }
}

/** The prompt of one goal turn. */
function goalPrompt(goal: Goal, note: string | null): string {
  const left = goal.maxTurns - goal.turn;
  return [
    "[Goal mode] The user gave you a goal. Keep working on it turn after turn: OpenBot starts your next turn by itself after each one, until you report the goal completed, needing the user, or blocked.",
    `Goal: ${goal.text}`,
    `This is goal turn ${goal.turn} of ${goal.maxTurns}; ${left} turn(s) remain after this one.`,
    note ? `Note from OpenBot: ${note}` : null,
    "Use the conversation as the progress ledger. Do the next concrete piece of work now with your tools — real work, not a plan of it. You may hand parts to teammates with openbot.send_message; their answers come back to this chat.",
    "Do not continue merely to generate discussion. Do not claim completion unless the requested deliverable or answer exists and you checked it.",
    // Fork (docs/fork/FEATURES.md, "Goals build every option, then ask with a question card").
    "A choice for the user (a design, a setting, an approach) does not stop the goal. Build each reasonable option (at most 3) side by side, each separate and named: code on its own branch with its commits, an edit as its own copy (a duplicated comp, a new file or version). Do not change the original or what the user runs now. Then go on with the rest of the goal.",
    "When the options are built and checked, ask once with ask_user (or ask_ui with a choice block), never only in your message: what each option is, where it is, how to try it, and which one you recommend. When the user answers, apply the choice and go on; when the question is skipped or expires, report needs-input with the same summary. Ask before you build only when building would change or delete the user's real data, publish or send something, spend money, or cannot be undone.",
    `Write a brief update for the user, then, as your last action, call openbot.${GOAL_STATUS_TOOL} once: status "continue" with "next" (your concrete next step); "waiting" with "detail" while teammates work for you; or "completed", "needs-input" or "blocked" with "detail" (the result, your question, or the blocker).`,
  ]
    .filter(Boolean)
    .join("\n");
}

function isGoal(value: unknown): value is Goal {
  return (
    isDynamicRecord(value) &&
    typeof value.agentId === "string" &&
    typeof value.text === "string" &&
    typeof value.state === "string" &&
    typeof value.turn === "number" &&
    typeof value.maxTurns === "number" &&
    typeof value.startedBy === "string"
  );
}
