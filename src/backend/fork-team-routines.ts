/**
 * Fork (docs/fork/FEATURES.md #135, "Team watchdogs and guards"): the routine senders of OpenBot's own
 * team messages. Like the team follow-through wake (#130) they are no real routine: the text is the
 * whole prompt, the turn runs in the agent's own session, and a restart resumes it. Kept in a file of
 * their own so that `fork-restart-resume.ts`, `drain-scheduler.ts` and `delivery-content.ts` can import
 * them without importing the watchdog.
 */

/** The team watchdog's wake of a lead (`fork-team-watchdog.ts`). It may end with `routine_no_update`. */
export const FORK_TEAM_WATCHDOG_ROUTINE_ID = "fork-team-watchdog";
export const FORK_TEAM_WATCHDOG_ROUTINE_NAME = "🐕 Team watchdog";
/** The message to a teammate whose "Status: done" failed its check (`fork-team-guards.ts`). */
export const FORK_TEAM_CHECK_ROUTINE_ID = "fork-team-check";
export const FORK_TEAM_CHECK_ROUTINE_NAME = "🐕 Team check";

export function isForkTeamRoutine(routineId: string): boolean {
  return routineId === FORK_TEAM_WATCHDOG_ROUTINE_ID || routineId === FORK_TEAM_CHECK_ROUTINE_ID;
}
