// Fork (docs/fork/FEATURES.md #108): what an agent gets from its sidebar section, for its Settings panel.
import type { AgentSectionInheritance } from "@openbot/contracts/fork-section-defaults";
import { sectionLayerHasDefaults } from "@openbot/contracts/fork-section-defaults";
import type { AgentSectionDefaultsCalls } from "@openbot/ui/features/conversation/AgentSectionDefaultsView";
import { createEffect, createSignal } from "solid-js";
import { sectionDefaultsRevision } from "../sidebar/fork-section-defaults";
import { conversationPort } from "./conversation-port";

export const forkSectionDefaultsCalls: Omit<AgentSectionDefaultsCalls, "openLink"> = {
  load: (agentId) => window.openbot.agent.getAgentSectionInheritance(agentId),
  setOptOut: (input) => window.openbot.agent.setAgentSectionOptOut(input),
};

export function createForkSectionLink(agentId: () => string, enabled: () => boolean) {
  const [inheritance, setInheritance] = createSignal<AgentSectionInheritance | null>(null);
  const [layoutRevision, setLayoutRevision] = createSignal(0);
  let request = 0;
  createEffect(
    () => enabled(),
    (on) => {
      if (!on) return;
      return conversationPort().agent.onScopedEvent((scoped) => {
        if (scoped.event.type === "sidebar-layout-changed") setLayoutRevision((revision) => revision + 1);
      });
    },
  );
  createEffect(
    () => ({ id: agentId(), on: enabled(), saved: sectionDefaultsRevision(), moved: layoutRevision() }),
    ({ id, on }) => {
      const current = ++request;
      if (!on) {
        setInheritance(null);
        return;
      }
      forkSectionDefaultsCalls.load(id).then(
        (loaded) => {
          if (current === request) setInheritance(loaded);
        },
        () => {
          if (current === request) setInheritance(null);
        },
      );
    },
  );
  return {
    inheritance,
    /** Changes when a folder is saved here or the sidebar changes; the folder page reloads on it. */
    revision: () => sectionDefaultsRevision() + layoutRevision(),
    folder: () => {
      const loaded = inheritance();
      if (!loaded?.sectionId) return null;
      const shared = loaded.layers.some(sectionLayerHasDefaults);
      return shared ? loaded.path.join(" / ") : null;
    },
  };
}
