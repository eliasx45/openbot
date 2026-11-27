/**
 * Fork: the fork's own services, reachable from the few upstream functions that call into them
 * (prompt building, turn ends) without threading them through upstream constructors. Keeping the
 * upstream diff small keeps `git merge upstream/main` easy. `AgentService` fills it at start and
 * clears it at stop. See docs/fork/FEATURES.md.
 */

import type { ChannelMessage } from "@openbot/contracts/ipc";
import type { ForkCacheCompact } from "./fork-cache-compact";
import type { ForkComposio } from "./fork-composio";
import type { ForkGoals } from "./fork-goals";
import type { ForkMemory } from "./fork-memory";
import type { ForkRestartResume } from "./fork-restart-resume";
import type { ForkSectionInheritance } from "./fork-section-inheritance";
import type { ForkVoiceNotes } from "./fork-voice-notes";

/** Fork (docs/fork/FEATURES.md, "Agents ride out a network drop"): what a turn end of an agent's own chat tells it. */
export interface ForkNetworkResume {
  turnFailed(input: {
    agentId: string;
    turnId: string;
    provider: string;
    error: string;
    requestMessageId: string | null;
    requestText: string | null;
  }): void;
  turnCompleted(agentId: string): void;
}

/** Fork (docs/fork/FEATURES.md #107): an agent's final answer of a turn in a channel goes to its outbound webhook. */
export interface ForkChannelWebhooks {
  turnAnswered(input: {
    channelId: string;
    channelName: string;
    message: ChannelMessage;
    origin: "member" | "routine" | "other";
  }): void;
}

/** Fork (docs/fork/FEATURES.md #123): a new chat page (html_render) can be a new version of a saved app. */
export interface ForkSavedAppsHook {
  pageAdded(page: { agentId: string; threadId: string; messageId: string; attachmentId: string; title: string }): void;
}

export const forkHub: {
  goals: ForkGoals | null;
  memory: ForkMemory | null;
  composio: ForkComposio | null;
  cacheCompact: ForkCacheCompact | null;
  restartResume: ForkRestartResume | null;
  voiceNotes: ForkVoiceNotes | null;
  networkResume: ForkNetworkResume | null;
  /** Fork (docs/fork/FEATURES.md #108): shared defaults per sidebar section. The main process sets it. */
  sections: ForkSectionInheritance | null;
  channelWebhooks: ForkChannelWebhooks | null;
  savedApps: ForkSavedAppsHook | null;
} = {
  goals: null,
  memory: null,
  composio: null,
  cacheCompact: null,
  restartResume: null,
  voiceNotes: null,
  networkResume: null,
  sections: null,
  channelWebhooks: null,
  savedApps: null,
};
