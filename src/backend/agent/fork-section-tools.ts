// Fork (docs/fork/FEATURES.md #108): agent tools that read and write the shared defaults of a sidebar section.
import { SECTION_DEFAULTS_LIMITS, type SectionDefaultsChoice } from "@openbot/contracts/fork-section-defaults";
import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type { SidebarLayoutSnapshot } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import { z } from "zod";
import type { ForkSectionInheritance, ResolvedSectionInheritance } from "../fork-section-inheritance";
import type { ToolApprovalDecision } from "./attention-registry";
import { type OpenBotToolResponse, openBotToolFailure, openBotToolResult } from "./routine-tools";
import { type ToolOperationFailed, toolStep, toToolOperationFailed } from "./tool-operation";

const sectionId = z.string().min(1).max(INPUT_LIMITS.identifier);
const ids = (limit: number) => z.array(z.string().trim().min(1).max(INPUT_LIMITS.identifier)).max(limit);

export const readSectionToolSchema = z
  .object({
    sectionId: sectionId
      .optional()
      .describe("Custom section id from openbot.list_sections. Omit it to read your own section."),
  })
  .strict();

export const updateSectionDefaultsToolSchema = z
  .object({
    sectionId: sectionId.describe("Custom section id from openbot.list_sections."),
    instructions: z
      .string()
      .max(SECTION_DEFAULTS_LIMITS.instructions)
      .optional()
      .describe(
        "Markdown shared by every agent in the section and its subsections. Replaces the whole text: read_section first and keep what still applies. Empty clears it.",
      ),
    skillIds: ids(SECTION_DEFAULTS_LIMITS.skills)
      .optional()
      .describe("Local skill ids from openbot.list_local_skills. Replaces the whole list."),
    mcpServerIds: ids(SECTION_DEFAULTS_LIMITS.mcpServers)
      .optional()
      .describe("MCP server ids or names to give every agent of the section. Replaces the whole list."),
  })
  .strict();

export const FORK_SECTION_TOOL_DEFINITIONS = [
  {
    name: "read_section",
    description:
      "Read a sidebar section's shared defaults (instructions, skills, MCP servers that its agents inherit), those of its parent sections, and its agents. Omit sectionId for your own section.",
    shape: readSectionToolSchema.shape,
  },
  {
    name: "update_section_defaults",
    description:
      "Change a sidebar section's shared instructions, skills or MCP servers once for every agent in it, now and later, instead of changing each agent. Each field you pass replaces its old value.",
    shape: updateSectionDefaultsToolSchema.shape,
  },
] as const;

export const FORK_SECTION_GUIDANCE =
  "A custom section can hold shared defaults that every agent in it and in its subsections inherits at its next message, also agents moved or created there later: instructions (markdown), local skills, and MCP servers. Agents get the parent section first, then the subsection, then their own Instructions; their own Instructions win on a conflict, and an agent can opt out of a section skill or MCP server in its settings. When the user asks for a rule, skill or app for a whole group of agents, or a retro finds one, call openbot.read_section, then openbot.update_section_defaults once for the section that owns it, not update_profile or each agent's instruction file. Read first and pass the whole new text: each field replaces the old one. Only an owner or admin can change it; a new MCP server needs the owner's approval.";

export const FORK_SECTION_AGENT_GUIDANCE =
  "read_agent's section field shows the sidebar section of an agent and what it inherits from it (instructions, skills, MCP servers). Change a shared rule there with openbot.update_section_defaults, not in each agent.";

export const FORK_SECTION_TOOL_NAMES: ReadonlySet<string> = new Set(
  FORK_SECTION_TOOL_DEFINITIONS.map((tool) => tool.name),
);

export interface ForkSectionToolOptions {
  sections: ForkSectionInheritance | null;
  senderAgentId: string;
  requestersCanAdminister: boolean;
  approve(reason: string): Effect.Effect<ToolApprovalDecision, ToolOperationFailed>;
}

const MEMBER_REFUSAL =
  "A server member who is not an owner or admin sent this request. Only an owner or admin can change the shared defaults of a sidebar section. Tell the user to ask an owner or admin of the server.";

function resolveIds(
  requested: readonly string[],
  choices: readonly SectionDefaultsChoice[],
  kind: string,
): { ids: string[] } | { error: string } {
  const result: string[] = [];
  // The turn block names a skill by its slug ("client-voice"); the library by its name ("Client voice").
  const slug = (text: string) =>
    text
      .toLocaleLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/gu, "");
  for (const value of requested) {
    const choice =
      choices.find((candidate) => candidate.id === value) ??
      choices.find((candidate) => candidate.name.localeCompare(value, undefined, { sensitivity: "accent" }) === 0) ??
      choices.find((candidate) => slug(candidate.name) === slug(value));
    if (!choice) return { error: `Unknown ${kind}: ${value}.` };
    if (!result.includes(choice.id)) result.push(choice.id);
  }
  return { ids: result };
}

export function forkSectionSummaries(sections: ForkSectionInheritance | null, layout: SidebarLayoutSnapshot) {
  if (!sections) return {};
  const summaries: Record<string, { instructions: string; skillIds: string[]; mcpServerIds: string[] }> = {};
  for (const section of layout.sections) {
    const defaults = sections.store.get(section.id);
    if (!defaults.instructions.trim() && defaults.skillIds.length === 0 && defaults.mcpServerIds.length === 0) continue;
    summaries[section.id] = {
      instructions:
        defaults.instructions.length > 300 ? `${defaults.instructions.slice(0, 300)}…` : defaults.instructions,
      skillIds: defaults.skillIds,
      mcpServerIds: defaults.mcpServerIds,
    };
  }
  return Object.keys(summaries).length > 0 ? { sectionDefaults: summaries } : {};
}

export function forkSectionReadAgentView(resolved: ResolvedSectionInheritance) {
  if (!resolved.sectionId) return { sectionId: null };
  return {
    sectionId: resolved.sectionId,
    path: resolved.path.join(" / "),
    inherited: resolved.layers
      .filter((layer) => layer.instructions.trim() || layer.skillIds.length > 0 || layer.mcpServerIds.length > 0)
      .map((layer) => ({
        sectionId: layer.sectionId,
        path: layer.path.join(" / "),
        instructions: layer.instructions.length > 300 ? `${layer.instructions.slice(0, 300)}…` : layer.instructions,
        skillIds: layer.skillIds,
        mcpServerIds: layer.mcpServerIds,
      })),
    optedOut: resolved.optOut,
    skillIds: resolved.skillIds,
    mcpServerIds: resolved.mcpServerIds,
    rule: "Parent section first, then this section, then the agent's own Instructions, which win on a conflict. Change shared rules with openbot.update_section_defaults.",
  };
}

export const handleForkSectionTool = Effect.fn("ForkSectionTools.handle")(function* (
  tool: string,
  args: unknown,
  options: ForkSectionToolOptions,
): Effect.fn.Return<OpenBotToolResponse | null, ToolOperationFailed> {
  if (!FORK_SECTION_TOOL_NAMES.has(tool)) return null;
  const sections = options.sections;
  if (!sections) return openBotToolFailure("Section defaults are unavailable on this OpenBot.");
  if (tool === "read_section") {
    const input = yield* toolStep(() => readSectionToolSchema.parse(args));
    const target = input.sectionId ?? sections.resolve(options.senderAgentId).sectionId;
    if (!target)
      return openBotToolResult({
        sectionId: null,
        note: "You are in no custom sidebar section. openbot.list_sections lists the sections.",
      });
    const editor = yield* sections.editor(target).pipe(toToolOperationFailed);
    return openBotToolResult({
      sectionId: editor.sectionId,
      path: editor.path.join(" / "),
      instructions: editor.defaults.instructions,
      skills: editor.defaults.skillIds.map(
        (id) => editor.skillChoices.find((choice) => choice.id === id) ?? { id, name: id },
      ),
      mcpServers: editor.defaults.mcpServerIds.map(
        (id) => editor.mcpServerChoices.find((choice) => choice.id === id) ?? { id, name: id },
      ),
      parents: editor.parents.map((layer) => ({
        sectionId: layer.sectionId,
        path: layer.path.join(" / "),
        instructions: layer.instructions,
        skills: layer.skills,
        mcpServers: layer.mcpServers,
      })),
      agents: editor.members,
      rule: "Agents get parent sections first, then this section, then their own Instructions; the agent's own Instructions win on a conflict. Subsections inherit this section.",
    });
  }
  const input = yield* toolStep(() => updateSectionDefaultsToolSchema.parse(args));
  if (!options.requestersCanAdminister) return openBotToolFailure(MEMBER_REFUSAL);
  const editor = yield* sections.editor(input.sectionId).pipe(toToolOperationFailed);
  const skills = input.skillIds ? resolveIds(input.skillIds, editor.skillChoices, "local skill") : { ids: undefined };
  if ("error" in skills) return openBotToolFailure(`${skills.error} Use an id from openbot.list_local_skills.`);
  const servers = input.mcpServerIds
    ? resolveIds(input.mcpServerIds, editor.mcpServerChoices, "MCP server")
    : { ids: undefined };
  if ("error" in servers) return openBotToolFailure(`${servers.error} Use an id or name from openbot.read_agent.`);
  const added = (servers.ids ?? []).filter((id) => !editor.defaults.mcpServerIds.includes(id));
  if (added.length > 0) {
    const names = added.map((id) => editor.mcpServerChoices.find((choice) => choice.id === id)?.name ?? id);
    const decision = yield* options.approve(
      `Give every agent in the section ${editor.path.join(" / ")} the MCP server${names.length > 1 ? "s" : ""} ${names.join(", ")}.`,
    );
    if (decision === "cancel" || decision === "decline")
      return openBotToolFailure("The user declined the MCP server change. Nothing changed.");
  }
  const updated = yield* sections
    .update({
      sectionId: input.sectionId,
      ...(input.instructions !== undefined ? { instructions: input.instructions } : {}),
      ...(skills.ids ? { skillIds: skills.ids } : {}),
      ...(servers.ids ? { mcpServerIds: servers.ids } : {}),
    })
    .pipe(toToolOperationFailed);
  return openBotToolResult({
    status: "updated",
    sectionId: updated.sectionId,
    path: updated.path.join(" / "),
    instructions: updated.defaults.instructions,
    skillIds: updated.defaults.skillIds,
    mcpServerIds: updated.defaults.mcpServerIds,
    agents: updated.members.map((member) => member.name),
    note: "Every agent in this section and its subsections gets the change from its next message.",
  });
});
