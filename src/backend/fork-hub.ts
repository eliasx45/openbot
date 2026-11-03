/**
 * Fork: the fork's own services, reachable from the few upstream functions that call into them
 * (prompt building, turn ends) without threading them through upstream constructors. Keeping the
 * upstream diff small keeps `git merge upstream/main` easy. `AgentService` fills it at start and
 * clears it at stop. See docs/fork/FEATURES.md.
 */

import type { ForkComposio } from "./fork-composio";
import type { ForkGoals } from "./fork-goals";
import type { ForkMemory } from "./fork-memory";

export const forkHub: {
  goals: ForkGoals | null;
  memory: ForkMemory | null;
  composio: ForkComposio | null;
} = { goals: null, memory: null, composio: null };
