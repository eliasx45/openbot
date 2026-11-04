/**
 * Fork (docs/fork/FEATURES.md, "Compact before the cache goes cold"): Claude keeps a chat's prompt
 * cache for one hour. A message after that writes the whole context again (Rasta: 164k tokens, about
 * $1.64 at list price, against $0.08 for a warm turn). When an agent's own chat has been quiet for
 * 55 minutes and its context holds 100k tokens or more, OpenBot sends that session Claude Code's
 * `/compact` while the cache is still warm: the compaction reads the context from the cache and the
 * next message writes only the summary.
 *
 * The compaction is a delivery with a routine sender (`routineId` `fork-compact`, no real routine),
 * like the wake of `wait_until`: it runs in the agent's own session and its text is the whole prompt.
 * A chat quiet for more than an hour (the Mac slept) is not compacted: its cache is cold already, and
 * a compaction then costs about what the next message would.
 */

import { createOpenBotLogger } from "@openbot/logging";

export const FORK_COMPACT_ROUTINE_ID = "fork-compact";
/** The context size from which a compaction pays for itself. Elias chose 100k (4 Nov 2026). */
export const FORK_COMPACT_MIN_TOKENS = 100_000;
/**
 * Claude's prompt cache lives one hour; the compaction runs in the last minutes of it. Test switch:
 * `OPENBOT_FORK_COMPACT_QUIET_MINUTES=2` compacts after 2 quiet minutes.
 */
const TEST_QUIET_MINUTES = Number(process.env.OPENBOT_FORK_COMPACT_QUIET_MINUTES) || 0;
const QUIET_FROM_MS = (TEST_QUIET_MINUTES > 0 ? TEST_QUIET_MINUTES : 55) * 60_000;
const QUIET_UNTIL_MS = QUIET_FROM_MS + 5 * 60_000;
const CHECK_MS = TEST_QUIET_MINUTES > 0 ? 15_000 : 60_000;

const logger = createOpenBotLogger("fork-cache-compact");

export interface ForkCacheCompactHooks {
  /** The agents whose own chat runs on Claude. */
  claudeAgentIds(): string[];
  /** The tokens the provider last reported for the agent's own chat, or null when none is known. */
  contextTokens(agentId: string): number | null;
  /** A turn runs, a message waits, or a compaction runs for the agent. */
  busy(agentId: string): boolean;
  /** Queues the `/compact` delivery in the agent's own chat. */
  compact(agentId: string, input: { runId: string; tokens: number }): void;
  isRunning(): boolean;
}

export class ForkCacheCompact {
  readonly #hooks: ForkCacheCompactHooks;
  readonly #timer: ReturnType<typeof setInterval>;
  /** When the last turn of the agent's own chat ended; only those chats are compacted. */
  readonly #endedAt = new Map<string, number>();

  constructor(hooks: ForkCacheCompactHooks) {
    this.#hooks = hooks;
    this.#timer = setInterval(() => this.#check(), CHECK_MS);
    this.#timer.unref?.();
  }

  /** A turn of the agent's own chat ended: the cache was written now. */
  turnEnded(agentId: string): void {
    this.#endedAt.set(agentId, Date.now());
  }

  dispose(): void {
    clearInterval(this.#timer);
  }

  #check(): void {
    if (!this.#hooks.isRunning()) return;
    const now = Date.now();
    for (const agentId of this.#hooks.claudeAgentIds()) {
      const endedAt = this.#endedAt.get(agentId);
      if (endedAt === undefined) continue;
      const quiet = now - endedAt;
      if (quiet < QUIET_FROM_MS) continue;
      // One try per quiet stretch: the compaction turn sets a new end, and a cold cache waits for the user.
      this.#endedAt.delete(agentId);
      if (quiet >= QUIET_UNTIL_MS || this.#hooks.busy(agentId)) continue;
      const tokens = this.#hooks.contextTokens(agentId);
      if (tokens === null || tokens < FORK_COMPACT_MIN_TOKENS) continue;
      logger.info("Compacting a quiet chat before its prompt cache goes cold.", { agentId, tokens });
      this.#hooks.compact(agentId, { runId: `${agentId}:${endedAt}`, tokens });
    }
  }
}

/** The prompt of the compaction turn. Claude Code runs a prompt that starts with `/compact` as its command. */
export function forkCompactPrompt(): string {
  return "/compact Keep what the user asked for and decided, the open work and its next steps, file paths, names and numbers. Drop tool output that was only read once.";
}
