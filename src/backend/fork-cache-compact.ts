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
 *
 * `/keepwarm [2h]` keeps the whole chat instead, for a window the user chooses: while it is quiet,
 * OpenBot sends it a short ping 50 minutes after its last turn, which reads the context from the
 * cache and so keeps it one more hour. When the window ends, the compaction above takes over.
 */

import { createOpenBotLogger } from "@openbot/logging";

export const FORK_COMPACT_ROUTINE_ID = "fork-compact";
export const FORK_KEEPWARM_ROUTINE_ID = "fork-keepwarm";

/** A delivery of this class: its text is the whole prompt, and it runs in the agent's own session. */
export function isForkCacheRoutine(routineId: string | undefined): boolean {
  return routineId === FORK_COMPACT_ROUTINE_ID || routineId === FORK_KEEPWARM_ROUTINE_ID;
}
/** The context size from which a compaction pays for itself. Elias chose 100k (4 Nov 2026). */
const FORK_COMPACT_MIN_TOKENS = 100_000;
/**
 * Fork (docs/fork/FEATURES.md, "Long turns stay visible"): a chat that never goes quiet for 55 minutes
 * grows without limit (Gotham, 8 Nov 2026: 510k–550k tokens in each of 30 requests of one turn,
 * $3.88). From this size, the chat is compacted as soon as a turn ends and nothing else waits, while
 * the user reads the answer. Elias approved 300k on 8 Nov 2026.
 */
const FORK_COMPACT_BIG_TOKENS = 300_000;
/** The wait after a turn ends: a plan continuation or a waiting message starts first, and the size arrives. */
const BIG_CHECK_DELAY_MS = 20_000;
/**
 * Claude's prompt cache lives one hour; the compaction runs in the last minutes of it. Test switch:
 * `OPENBOT_FORK_COMPACT_QUIET_MINUTES=2` compacts after 2 quiet minutes.
 */
const TEST_QUIET_MINUTES = Number(process.env.OPENBOT_FORK_COMPACT_QUIET_MINUTES) || 0;
const QUIET_FROM_MS = (TEST_QUIET_MINUTES > 0 ? TEST_QUIET_MINUTES : 55) * 60_000;
const QUIET_UNTIL_MS = QUIET_FROM_MS + 5 * 60_000;
/** A keep-warm ping goes 5 minutes before the compaction would (test switch: at half of it). */
const PING_FROM_MS = TEST_QUIET_MINUTES > 0 ? QUIET_FROM_MS / 2 : QUIET_FROM_MS - 5 * 60_000;
const KEEPWARM_DEFAULT_MS = 2 * 60 * 60_000;
const KEEPWARM_MAX_MS = 12 * 60 * 60_000;
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
  compact(agentId: string, input: { runId: string; tokens: number; big?: boolean }): void;
  /** Queues the keep-warm ping in the agent's own chat. */
  ping(agentId: string, input: { runId: string; until: number }): void;
  isRunning(): boolean;
}

export class ForkCacheCompact {
  readonly #hooks: ForkCacheCompactHooks;
  readonly #timer: ReturnType<typeof setInterval>;
  /** When the last turn of the agent's own chat ended; only those chats are compacted. */
  readonly #endedAt = new Map<string, number>();
  /** The end of each agent's `/keepwarm` window. In memory: a restart ends every window. */
  readonly #warmUntil = new Map<string, number>();
  /** Agents whose big chat was just sent `/compact`: the end of that turn starts no other one. */
  readonly #bigCompacted = new Set<string>();
  readonly #bigChecks = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(hooks: ForkCacheCompactHooks) {
    this.#hooks = hooks;
    this.#timer = setInterval(() => this.#check(), CHECK_MS);
    this.#timer.unref?.();
  }

  /** A turn of the agent's own chat ended: the cache was written now. */
  turnEnded(agentId: string): void {
    const endedAt = Date.now();
    this.#endedAt.set(agentId, endedAt);
    clearTimeout(this.#bigChecks.get(agentId));
    if (this.#bigCompacted.delete(agentId)) return;
    const timer = setTimeout(() => {
      this.#bigChecks.delete(agentId);
      this.#compactBig(agentId, endedAt);
    }, BIG_CHECK_DELAY_MS);
    timer.unref?.();
    this.#bigChecks.set(agentId, timer);
  }

  /** Compacts a chat over `FORK_COMPACT_BIG_TOKENS` right after its turn, unless something else runs. */
  #compactBig(agentId: string, endedAt: number): void {
    if (!this.#hooks.isRunning() || this.#endedAt.get(agentId) !== endedAt || this.#hooks.busy(agentId)) return;
    // A keep-warm window means the user wants the whole chat kept.
    if (this.warmUntil(agentId) !== null || !this.supports(agentId)) return;
    const tokens = this.#hooks.contextTokens(agentId);
    if (tokens === null || tokens < FORK_COMPACT_BIG_TOKENS) return;
    logger.info("Compacting a big chat after its turn.", { agentId, tokens });
    this.#bigCompacted.add(agentId);
    this.#hooks.compact(agentId, { runId: `${agentId}:${endedAt}:big`, tokens, big: true });
  }

  /** Whether the agent's own chat runs on Claude, the only provider with this cache handling. */
  supports(agentId: string): boolean {
    return this.#hooks.claudeAgentIds().includes(agentId);
  }

  /** Starts (or replaces) the agent's keep-warm window; `null` ends it. Returns the window's end. */
  keepWarm(agentId: string, durationMs: number | null): number | null {
    if (durationMs === null) {
      this.#warmUntil.delete(agentId);
      return null;
    }
    const until = Date.now() + Math.min(Math.max(durationMs, 60_000), KEEPWARM_MAX_MS);
    this.#warmUntil.set(agentId, until);
    return until;
  }

  warmUntil(agentId: string): number | null {
    const until = this.#warmUntil.get(agentId);
    return until !== undefined && until > Date.now() ? until : null;
  }

  dispose(): void {
    clearInterval(this.#timer);
    for (const timer of this.#bigChecks.values()) clearTimeout(timer);
    this.#bigChecks.clear();
  }

  #check(): void {
    if (!this.#hooks.isRunning()) return;
    const now = Date.now();
    for (const [agentId, until] of this.#warmUntil) if (until <= now) this.#warmUntil.delete(agentId);
    for (const agentId of this.#hooks.claudeAgentIds()) {
      const endedAt = this.#endedAt.get(agentId);
      if (endedAt === undefined) continue;
      const quiet = now - endedAt;
      const until = this.#warmUntil.get(agentId);
      // Inside a keep-warm window the ping replaces the compaction; the ping turn sets a new end.
      const warm = until !== undefined;
      if (quiet < (warm ? PING_FROM_MS : QUIET_FROM_MS)) continue;
      // One try per quiet stretch: the turn it starts sets a new end, and a cold cache waits for the user.
      this.#endedAt.delete(agentId);
      if (quiet >= QUIET_UNTIL_MS || this.#hooks.busy(agentId)) continue;
      if (warm) {
        logger.info("Pinging a quiet chat to keep its prompt cache warm.", { agentId, until });
        this.#hooks.ping(agentId, { runId: `${agentId}:${endedAt}`, until });
        continue;
      }
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

/**
 * The prompt of a keep-warm ping: a cache read of the whole context, and as the answer the quiet
 * routine marker, so the chat keeps only the collapsed routine row.
 */
export function forkKeepWarmPrompt(): string {
  return "[OpenBot keep-warm ping: this message only keeps the prompt cache warm. Do nothing else and call no tool. Reply with exactly: [[no-update]]]";
}

/**
 * The window of `/keepwarm <rest>`: `off` → null, nothing → the default, `2h`, `90m`, `1h30m`, `3`
 * (hours). Undefined when the text is not a duration.
 */
export function parseKeepWarm(rest: string): number | null | undefined {
  const text = rest.trim().toLowerCase();
  if (text === "") return KEEPWARM_DEFAULT_MS;
  if (text === "off" || text === "stop") return null;
  if (/^\d+(?:\.\d+)?$/u.test(text)) return Number(text) * 60 * 60_000;
  const match = /^(?:(\d+(?:\.\d+)?)\s*h(?:ours?)?)?\s*(?:(\d+)\s*m(?:in(?:utes?)?)?)?$/u.exec(text);
  if (!match || (match[1] === undefined && match[2] === undefined)) return undefined;
  return (Number(match[1] ?? 0) * 60 + Number(match[2] ?? 0)) * 60_000;
}
