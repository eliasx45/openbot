// Fork (docs/fork/FEATURES.md #108): builds the section defaults service of this computer.
import { join } from "node:path";
import type { AgentSummary, McpServerConfig } from "@openbot/contracts/ipc";
import { createOpenBotLogger } from "@openbot/logging";
import { Effect } from "effect";
import { runCauseEffect } from "../backend/effect-boundary";
import { forkHub } from "../backend/fork-hub";
import {
  ForkSectionInheritance,
  SECTION_DEFAULTS_FILE,
  SectionDefaultsStore,
} from "../backend/fork-section-inheritance";
import type { SidebarLayoutStore } from "../backend/sidebar-layout-store";
import { ForkSectionSkills } from "./fork-section-skills";
import type { LocalSkillLibrary } from "./local-skill-library";

const logger = createOpenBotLogger("fork-section-defaults");

export interface ForkSectionDefaultsOptions {
  userData: string;
  sidebarLayout: SidebarLayoutStore;
  library: () => LocalSkillLibrary;
  agents: () => readonly AgentSummary[];
  mcpServers: () => readonly McpServerConfig[];
  refreshAgent: (agentId: string) => Effect.Effect<void, unknown>;
}

export async function createForkSectionDefaults(options: ForkSectionDefaultsOptions): Promise<ForkSectionInheritance> {
  const store = new SectionDefaultsStore(join(options.userData, SECTION_DEFAULTS_FILE));
  await runCauseEffect(store.initialize());
  const skills = new ForkSectionSkills(join(options.userData, "fork-section-skills"), () => {
    try {
      return options.library();
    } catch {
      return null;
    }
  });
  const sections = new ForkSectionInheritance({
    store,
    layout: () => options.sidebarLayout.getSnapshot(),
    skillFiles: (skillIds) => skills.files(skillIds),
    skillChoices: () => skills.choices(),
    mcpServerChoices: () => options.mcpServers().map((server) => ({ id: server.id, name: server.name })),
    agents: () => options.agents().map((agent) => ({ id: agent.id, name: agent.name })),
    refreshAgents: (agentIds) =>
      Effect.forEach(
        agentIds,
        (agentId) =>
          options.refreshAgent(agentId).pipe(
            Effect.catch((error) =>
              Effect.sync(() =>
                logger.warn("OpenBot could not restart an agent after its section MCP servers changed.", {
                  error: String(error),
                }),
              ),
            ),
          ),
        { discard: true },
      ),
  });
  forkHub.sections = sections;
  await runCauseEffect(sections.layoutChanged());
  options.sidebarLayout.on("changed", () => {
    sections.invalidate();
    Effect.runFork(sections.layoutChanged());
  });
  return sections;
}
