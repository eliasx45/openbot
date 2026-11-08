/**
 * Fork (docs/fork/FEATURES.md, "Account 1 keeps its own Claude sign-in"): the provider's own Claude
 * sign-in runs in a folder of its own instead of the user's `~/.claude`.
 *
 * Every Claude CLI on the Mac that has no `CLAUDE_CONFIG_DIR` (the terminal `claude`, neptune, Ghostex,
 * the night run) shares the sign-in of `~/.claude`. The server changes the refresh token at each
 * refresh, and when two of them refresh it close together, the one that loses gets `invalid_grant`
 * and the CLI clears the shared sign-in for all of them (8 Nov 2026, 10:43: OpenBot was not running,
 * and all its agents waited for a sign-in at the next start).
 *
 * The folder holds a link to each entry of `~/.claude` (CLAUDE.md, settings, hooks, skills, plugins,
 * the saved sessions in `projects`...), so the agents keep everything they had. Only the sign-in is
 * separate: on macOS the CLI keeps it in the Keychain item named after the folder, and the account
 * fields are in the folder's own `.claude.json`. Entries that hold the sign-in are not linked.
 */

import { lstatSync, mkdirSync, readdirSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createOpenBotLogger } from "@openbot/logging";
import { Effect, Schema } from "effect";

const logger = createOpenBotLogger("fork-claude-home");

/** Entries of `~/.claude` that hold or back up the sign-in of that folder. */
const NOT_LINKED = new Set([".claude.json", ".config.json", ".credentials.json", ".credentials.lock", "backups"]);

class ForkClaudeHomeFailed extends Schema.TaggedError<ForkClaudeHomeFailed>()("ForkClaudeHomeFailed", {
  cause: Schema.Defect(),
}) {}

let home: string | null = null;

/** `CLAUDE_CONFIG_DIR` for the provider's own sign-in; empty before `prepareForkClaudeHome` or when it failed. */
export function forkClaudeHomeEnvironment(): Record<string, string> {
  return home ? { CLAUDE_CONFIG_DIR: home } : {};
}

/**
 * Makes the folder and links each entry of the user's Claude folder that it does not have yet, at
 * each start: an entry that Claude Code adds later is linked at the next start. An entry the CLI made
 * in the folder itself is kept. When the folder cannot be made, the own sign-in stays in `~/.claude`.
 */
export const prepareForkClaudeHome = Effect.fn("ForkClaudeHome.prepare")(function* (folder: string) {
  const source = process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
  const linked = yield* Effect.try({
    try: () => {
      mkdirSync(folder, { recursive: true, mode: 0o700 });
      const present = new Set(readdirSync(folder));
      let count = 0;
      for (const name of readdirSync(source)) {
        if (NOT_LINKED.has(name) || present.has(name)) continue;
        const target = join(source, name);
        symlinkSync(target, join(folder, name), lstatSync(target).isDirectory() ? "dir" : "file");
        count += 1;
      }
      return count;
    },
    catch: (cause) => new ForkClaudeHomeFailed({ cause }),
  }).pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        logger.warn("The own Claude sign-in folder could not be prepared; it stays in ~/.claude.", {
          message: error.cause instanceof Error ? error.cause.message : String(error.cause),
        });
        return null;
      }),
    ),
  );
  if (linked === null) return;
  home = folder;
  if (linked > 0) logger.info("Linked entries of ~/.claude into the own Claude sign-in folder.", { linked });
});
