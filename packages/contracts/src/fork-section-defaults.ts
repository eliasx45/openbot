import { isDynamicRecord, isString } from "./runtime-values";

export const SECTION_DEFAULTS_LIMITS = {
  instructions: 32_000,
  skills: 50,
  mcpServers: 50,
  identifier: 128,
} as const;

export interface SectionDefaults {
  sectionId: string;
  instructions: string;
  skillIds: string[];
  mcpServerIds: string[];
  updatedAt: string | null;
}

export interface UpdateSectionDefaultsInput {
  sectionId: string;
  instructions?: string;
  skillIds?: string[];
  mcpServerIds?: string[];
}

export interface SectionDefaultsChoice {
  id: string;
  name: string;
  description?: string;
}

export interface InheritedSectionLayer {
  sectionId: string;
  path: string[];
  instructions: string;
  skills: SectionDefaultsChoice[];
  mcpServers: SectionDefaultsChoice[];
}

export interface SectionDefaultsEditor {
  sectionId: string;
  path: string[];
  defaults: SectionDefaults;
  parents: InheritedSectionLayer[];
  members: SectionDefaultsChoice[];
  skillChoices: SectionDefaultsChoice[];
  mcpServerChoices: SectionDefaultsChoice[];
}

export interface SectionOptOut {
  skillIds: string[];
  mcpServerIds: string[];
}

export interface AgentSectionInheritance {
  agentId: string;
  sectionId: string | null;
  path: string[];
  layers: InheritedSectionLayer[];
  optOut: SectionOptOut;
}

export interface SetSectionOptOutInput {
  agentId: string;
  kind: "skill" | "mcp";
  id: string;
  optedOut: boolean;
}

function identifier(value: unknown, label: string): string {
  if (!isString(value) || value.length === 0 || value.length > SECTION_DEFAULTS_LIMITS.identifier)
    throw new Error(`Invalid ${label}.`);
  return value;
}

function identifiers(value: unknown, label: string, limit: number): string[] {
  if (!Array.isArray(value) || value.length > limit) throw new Error(`Invalid ${label}.`);
  return [...new Set(value.map((item) => identifier(item, label)))];
}

export function parseUpdateSectionDefaultsInput(value: unknown): UpdateSectionDefaultsInput {
  if (!isDynamicRecord(value)) throw new Error("Invalid section defaults.");
  const known = ["sectionId", "instructions", "skillIds", "mcpServerIds"];
  if (Object.keys(value).some((key) => !known.includes(key))) throw new Error("Invalid section defaults.");
  const input: UpdateSectionDefaultsInput = { sectionId: identifier(value.sectionId, "section id") };
  if (value.instructions !== undefined) {
    if (!isString(value.instructions) || value.instructions.length > SECTION_DEFAULTS_LIMITS.instructions)
      throw new Error("Invalid section instructions.");
    input.instructions = value.instructions;
  }
  if (value.skillIds !== undefined)
    input.skillIds = identifiers(value.skillIds, "skill id", SECTION_DEFAULTS_LIMITS.skills);
  if (value.mcpServerIds !== undefined)
    input.mcpServerIds = identifiers(value.mcpServerIds, "MCP server id", SECTION_DEFAULTS_LIMITS.mcpServers);
  return input;
}

export function parseSetSectionOptOutInput(value: unknown): SetSectionOptOutInput {
  if (
    !isDynamicRecord(value) ||
    (value.kind !== "skill" && value.kind !== "mcp") ||
    typeof value.optedOut !== "boolean"
  )
    throw new Error("Invalid section opt-out.");
  return {
    agentId: identifier(value.agentId, "agent id"),
    kind: value.kind,
    id: identifier(value.id, value.kind === "skill" ? "skill id" : "MCP server id"),
    optedOut: value.optedOut,
  };
}

function decodeChoice(value: unknown): SectionDefaultsChoice {
  if (!isDynamicRecord(value)) throw new Error("Invalid section choice.");
  return {
    id: identifier(value.id, "choice id"),
    name: isString(value.name) ? value.name : "",
    ...(isString(value.description) ? { description: value.description } : {}),
  };
}

function decodeChoices(value: unknown): SectionDefaultsChoice[] {
  if (!Array.isArray(value)) throw new Error("Invalid section choices.");
  return value.map(decodeChoice);
}

function decodePath(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every(isString)) throw new Error("Invalid section path.");
  return [...value];
}

function decodeIds(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every(isString)) throw new Error("Invalid section ids.");
  return [...value];
}

function decodeLayer(value: unknown): InheritedSectionLayer {
  if (!isDynamicRecord(value) || !isString(value.instructions)) throw new Error("Invalid section layer.");
  return {
    sectionId: identifier(value.sectionId, "section id"),
    path: decodePath(value.path),
    instructions: value.instructions,
    skills: decodeChoices(value.skills),
    mcpServers: decodeChoices(value.mcpServers),
  };
}

export function decodeSectionDefaults(value: unknown): SectionDefaults {
  if (!isDynamicRecord(value) || !isString(value.instructions)) throw new Error("Invalid section defaults.");
  if (value.updatedAt !== null && !isString(value.updatedAt)) throw new Error("Invalid section defaults.");
  return {
    sectionId: identifier(value.sectionId, "section id"),
    instructions: value.instructions,
    skillIds: decodeIds(value.skillIds),
    mcpServerIds: decodeIds(value.mcpServerIds),
    updatedAt: value.updatedAt,
  };
}

export function decodeSectionDefaultsEditor(value: unknown): SectionDefaultsEditor {
  if (!isDynamicRecord(value) || !Array.isArray(value.parents)) throw new Error("Invalid section defaults.");
  return {
    sectionId: identifier(value.sectionId, "section id"),
    path: decodePath(value.path),
    defaults: decodeSectionDefaults(value.defaults),
    parents: value.parents.map(decodeLayer),
    members: decodeChoices(value.members),
    skillChoices: decodeChoices(value.skillChoices),
    mcpServerChoices: decodeChoices(value.mcpServerChoices),
  };
}

export function decodeAgentSectionInheritance(value: unknown): AgentSectionInheritance {
  if (!isDynamicRecord(value) || !Array.isArray(value.layers) || !isDynamicRecord(value.optOut))
    throw new Error("Invalid section inheritance.");
  if (value.sectionId !== null && !isString(value.sectionId)) throw new Error("Invalid section inheritance.");
  return {
    agentId: identifier(value.agentId, "agent id"),
    sectionId: value.sectionId,
    path: decodePath(value.path),
    layers: value.layers.map(decodeLayer),
    optOut: { skillIds: decodeIds(value.optOut.skillIds), mcpServerIds: decodeIds(value.optOut.mcpServerIds) },
  };
}

export function sectionLayerHasDefaults(layer: InheritedSectionLayer): boolean {
  return layer.instructions.trim().length > 0 || layer.skills.length > 0 || layer.mcpServers.length > 0;
}
