// Fork (docs/fork/FEATURES.md #108): shared instructions, skills and MCP servers per sidebar section.
import { EventEmitter } from "node:events";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  type AgentSectionInheritance,
  type InheritedSectionLayer,
  SECTION_DEFAULTS_LIMITS,
  type SectionDefaults,
  type SectionDefaultsChoice,
  type SectionDefaultsEditor,
  type SectionOptOut,
  type SetSectionOptOutInput,
  type UpdateSectionDefaultsInput,
} from "@openbot/contracts/fork-section-defaults";
import {
  type SidebarLayoutSnapshot,
  sidebarFolderAncestors,
  sidebarFolderParents,
  sidebarFolderPath,
} from "@openbot/contracts/ipc";
import { type DynamicRecord, isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { redactText } from "@openbot/logging";
import { Effect, Schema, Semaphore } from "effect";
import { writeFileAtomically } from "./atomic-json-file";
import { skillFolderNames } from "./home-skills";
import { StoredStateFailure, storedIO } from "./stored-state-effects";
import { readVersionedJsonFile, type VersionedJsonFormat } from "./versioned-json-store";

export const SECTION_DEFAULTS_FILE = "fork-section-defaults-v1.json";

interface StoredSection {
  instructions: string;
  skillIds: string[];
  mcpServerIds: string[];
  updatedAt: string;
}

interface SectionDefaultsState {
  sections: Record<string, StoredSection>;
  optOuts: Record<string, SectionOptOut>;
}

const EMPTY_STATE: SectionDefaultsState = { sections: {}, optOuts: {} };

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter(isString))] : [];
}

function decodeState(file: DynamicRecord): SectionDefaultsState {
  if (!isDynamicRecord(file.sections) || !isDynamicRecord(file.optOuts)) throw new Error("Invalid section defaults.");
  const sections: Record<string, StoredSection> = {};
  for (const [sectionId, value] of Object.entries(file.sections)) {
    if (!isDynamicRecord(value) || !isString(value.instructions)) continue;
    sections[sectionId] = {
      instructions: value.instructions,
      skillIds: stringList(value.skillIds),
      mcpServerIds: stringList(value.mcpServerIds),
      updatedAt: isString(value.updatedAt) ? value.updatedAt : new Date(0).toISOString(),
    };
  }
  const optOuts: Record<string, SectionOptOut> = {};
  for (const [agentId, value] of Object.entries(file.optOuts)) {
    if (!isDynamicRecord(value)) continue;
    optOuts[agentId] = { skillIds: stringList(value.skillIds), mcpServerIds: stringList(value.mcpServerIds) };
  }
  return { sections, optOuts };
}

const SECTION_DEFAULTS_FORMAT: VersionedJsonFormat<SectionDefaultsState> = {
  current: 1,
  releases: { 1: decodeState },
};

function emptySection(): StoredSection {
  return { instructions: "", skillIds: [], mcpServerIds: [], updatedAt: new Date(0).toISOString() };
}

function isEmptySection(section: StoredSection): boolean {
  return section.instructions.trim() === "" && section.skillIds.length === 0 && section.mcpServerIds.length === 0;
}

export class SectionDefaultsStore extends EventEmitter<{ changed: [sectionId: string | null] }> {
  readonly #path: string;
  #writePath: string;
  #state: SectionDefaultsState = structuredClone(EMPTY_STATE);
  readonly #queue = Semaphore.makeUnsafe(1);

  constructor(path: string) {
    super();
    this.#path = path;
    this.#writePath = path;
  }

  initialize(): Effect.Effect<void, StoredStateFailure> {
    return Effect.gen({ self: this }, function* () {
      yield* storedIO(() => mkdir(dirname(this.#path), { recursive: true, mode: 0o700 }));
      const loaded = yield* readVersionedJsonFile(this.#path, SECTION_DEFAULTS_FORMAT).pipe(
        Effect.mapError((cause) => new StoredStateFailure({ cause })),
      );
      this.#writePath = loaded.writePath;
      this.#state = loaded.value ?? structuredClone(EMPTY_STATE);
    });
  }

  get(sectionId: string): SectionDefaults {
    const section = this.#state.sections[sectionId];
    return {
      sectionId,
      instructions: section?.instructions ?? "",
      skillIds: [...(section?.skillIds ?? [])],
      mcpServerIds: [...(section?.mcpServerIds ?? [])],
      updatedAt: section?.updatedAt ?? null,
    };
  }

  sectionIds(): string[] {
    return Object.keys(this.#state.sections);
  }

  optOut(agentId: string): SectionOptOut {
    const optOut = this.#state.optOuts[agentId];
    return { skillIds: [...(optOut?.skillIds ?? [])], mcpServerIds: [...(optOut?.mcpServerIds ?? [])] };
  }

  update(input: UpdateSectionDefaultsInput, now = new Date()): Effect.Effect<SectionDefaults, StoredStateFailure> {
    return this.#enqueue(
      Effect.gen({ self: this }, function* () {
        const current = this.#state.sections[input.sectionId] ?? emptySection();
        const next: StoredSection = {
          instructions: (input.instructions ?? current.instructions).slice(0, SECTION_DEFAULTS_LIMITS.instructions),
          skillIds: [...new Set(input.skillIds ?? current.skillIds)].slice(0, SECTION_DEFAULTS_LIMITS.skills),
          mcpServerIds: [...new Set(input.mcpServerIds ?? current.mcpServerIds)].slice(
            0,
            SECTION_DEFAULTS_LIMITS.mcpServers,
          ),
          updatedAt: now.toISOString(),
        };
        const sections = { ...this.#state.sections };
        if (isEmptySection(next)) delete sections[input.sectionId];
        else sections[input.sectionId] = next;
        yield* this.#commit({ ...this.#state, sections }, input.sectionId);
        return this.get(input.sectionId);
      }),
    );
  }

  setOptOut(input: SetSectionOptOutInput): Effect.Effect<SectionOptOut, StoredStateFailure> {
    return this.#enqueue(
      Effect.gen({ self: this }, function* () {
        const current = this.optOut(input.agentId);
        const key = input.kind === "skill" ? "skillIds" : "mcpServerIds";
        const ids = new Set(current[key]);
        if (input.optedOut) ids.add(input.id);
        else ids.delete(input.id);
        const next = { ...current, [key]: [...ids] };
        const optOuts = { ...this.#state.optOuts };
        if (next.skillIds.length === 0 && next.mcpServerIds.length === 0) delete optOuts[input.agentId];
        else optOuts[input.agentId] = next;
        yield* this.#commit({ ...this.#state, optOuts }, null);
        return this.optOut(input.agentId);
      }),
    );
  }

  prune(sectionIds: ReadonlySet<string>): Effect.Effect<void, StoredStateFailure> {
    return this.#enqueue(
      Effect.gen({ self: this }, function* () {
        const gone = Object.keys(this.#state.sections).filter((sectionId) => !sectionIds.has(sectionId));
        if (gone.length === 0) return;
        const sections = { ...this.#state.sections };
        for (const sectionId of gone) delete sections[sectionId];
        yield* this.#commit({ ...this.#state, sections }, null);
      }),
    );
  }

  #enqueue<A, E>(operation: Effect.Effect<A, E>): Effect.Effect<A, E> {
    return this.#queue.withPermit(operation.pipe(Effect.uninterruptible));
  }

  #commit(next: SectionDefaultsState, sectionId: string | null): Effect.Effect<void, StoredStateFailure> {
    return writeFileAtomically(this.#writePath, `${JSON.stringify({ version: 1, ...next }, null, 2)}\n`).pipe(
      Effect.mapError(({ cause }) => new StoredStateFailure({ cause })),
      Effect.tap(() =>
        Effect.sync(() => {
          this.#state = next;
          this.emit("changed", sectionId);
        }),
      ),
    );
  }
}

export interface ResolvedSectionLayer {
  sectionId: string;
  path: string[];
  instructions: string;
  skillIds: string[];
  mcpServerIds: string[];
}

export interface ResolvedSectionInheritance {
  agentId: string;
  sectionId: string | null;
  path: string[];
  layers: ResolvedSectionLayer[];
  optOut: SectionOptOut;
  skillIds: string[];
  mcpServerIds: string[];
}

export function sectionChain(layout: SidebarLayoutSnapshot, sectionId: string): string[] {
  if (!layout.sections.some((section) => section.id === sectionId)) return [];
  const parents = sidebarFolderParents(layout);
  return [...sidebarFolderAncestors(parents, sectionId), sectionId];
}

export function sectionPath(layout: SidebarLayoutSnapshot, sectionId: string): string[] {
  return sidebarFolderPath(layout, sidebarFolderParents(layout), sectionId);
}

export function resolveSectionInheritance(
  layout: SidebarLayoutSnapshot | null,
  defaults: (sectionId: string) => SectionDefaults,
  optOut: SectionOptOut,
  agentId: string,
): ResolvedSectionInheritance {
  const assigned = layout?.agentAssignments[agentId];
  const chain = layout && assigned !== undefined ? sectionChain(layout, assigned) : [];
  const layers = chain.map((sectionId): ResolvedSectionLayer => {
    const own = defaults(sectionId);
    return {
      sectionId,
      path: layout ? sectionPath(layout, sectionId) : [],
      instructions: own.instructions,
      skillIds: own.skillIds,
      mcpServerIds: own.mcpServerIds,
    };
  });
  const effective = (key: "skillIds" | "mcpServerIds") => {
    const skipped = new Set(optOut[key]);
    return [...new Set(layers.flatMap((layer) => layer[key]))].filter((id) => !skipped.has(id));
  };
  return {
    agentId,
    sectionId: chain.length > 0 ? (assigned ?? null) : null,
    path: layers.at(-1)?.path ?? [],
    layers,
    optOut,
    skillIds: effective("skillIds"),
    mcpServerIds: effective("mcpServerIds"),
  };
}

export interface SectionSkillFile {
  id: string;
  slug: string;
  name: string;
  description: string;
  file: string;
}

export interface SectionDefaultsContext {
  section: string;
  layers: { section: string; instructions: string }[];
  skills: { slug: string; description: string; file: string; section: string }[];
}

export interface ForkSectionInheritanceOptions {
  store: SectionDefaultsStore;
  layout: () => SidebarLayoutSnapshot | null;
  skillFiles: (skillIds: readonly string[]) => Effect.Effect<SectionSkillFile[]>;
  skillChoices?: () => Effect.Effect<SectionDefaultsChoice[]>;
  mcpServerChoices?: () => SectionDefaultsChoice[];
  agents?: () => readonly { id: string; name: string }[];
  refreshAgents?: (agentIds: readonly string[]) => Effect.Effect<void>;
}

export class SectionDefaultsFailed extends Schema.TaggedError<SectionDefaultsFailed>()("SectionDefaultsFailed", {
  cause: Schema.Defect(),
}) {}

function failed(message: string): SectionDefaultsFailed {
  return new SectionDefaultsFailed({ cause: new Error(message) });
}

const OWN_SKILL_FOLDERS = [join(".agents", "skills"), join(".claude", "skills"), join(".gemini", "skills")];

export class ForkSectionInheritance {
  readonly store: SectionDefaultsStore;
  readonly #layout: () => SidebarLayoutSnapshot | null;
  readonly #skillFiles: ForkSectionInheritanceOptions["skillFiles"];
  readonly #skillChoices: () => Effect.Effect<SectionDefaultsChoice[]>;
  readonly #mcpServerChoices: () => SectionDefaultsChoice[];
  readonly #agents: () => readonly { id: string; name: string }[];
  readonly #refreshAgents: (agentIds: readonly string[]) => Effect.Effect<void>;
  readonly #mcpSets = new Map<string, string>();
  readonly #resolved = new Map<string, ResolvedSectionInheritance>();

  constructor(options: ForkSectionInheritanceOptions) {
    this.store = options.store;
    this.#layout = options.layout;
    this.#skillFiles = options.skillFiles;
    this.#skillChoices = options.skillChoices ?? (() => Effect.succeed([]));
    this.#mcpServerChoices = options.mcpServerChoices ?? (() => []);
    this.#agents = options.agents ?? (() => []);
    this.#refreshAgents = options.refreshAgents ?? (() => Effect.void);
    this.store.on("changed", () => this.invalidate());
  }

  invalidate(): void {
    this.#resolved.clear();
  }

  layout(): SidebarLayoutSnapshot | null {
    return this.#layout();
  }

  resolve(agentId: string): ResolvedSectionInheritance {
    const known = this.#resolved.get(agentId);
    if (known) return known;
    const resolved = resolveSectionInheritance(
      this.#layout(),
      (sectionId) => this.store.get(sectionId),
      this.store.optOut(agentId),
      agentId,
    );
    this.#resolved.set(agentId, resolved);
    return resolved;
  }

  key(agentId: string): string {
    const resolved = this.resolve(agentId);
    if (!hasSharedPromptDefaults(resolved)) return "";
    return JSON.stringify([resolved.layers.map((layer) => [layer.path, layer.instructions]), resolved.skillIds]);
  }

  grantsMcp(agentId: string, mcpServerId: string): boolean {
    return this.resolve(agentId).mcpServerIds.includes(mcpServerId);
  }

  context(agent: { id: string; workspacePath: string }): Effect.Effect<SectionDefaultsContext | null> {
    const resolved = this.resolve(agent.id);
    if (!hasSharedPromptDefaults(resolved)) return Effect.succeed(null);
    const skillFiles = this.#skillFiles;
    return Effect.gen(function* () {
      const own = new Set<string>();
      for (const folder of OWN_SKILL_FOLDERS)
        for (const name of yield* skillFolderNames(join(agent.workspacePath, folder))) own.add(name);
      const files = resolved.skillIds.length > 0 ? yield* skillFiles(resolved.skillIds) : [];
      const sectionOf = (skillId: string) =>
        resolved.layers.findLast((layer) => layer.skillIds.includes(skillId))?.path.join(" / ") ?? "";
      const skills = files
        .filter((skill) => !own.has(skill.slug))
        .map((skill) => ({
          slug: skill.slug,
          description: skill.description,
          file: skill.file,
          section: sectionOf(skill.id),
        }));
      const layers = resolved.layers
        .filter((layer) => layer.instructions.trim() !== "")
        .map((layer) => ({ section: layer.path.join(" / "), instructions: layer.instructions.trim() }));
      if (layers.length === 0 && skills.length === 0) return null;
      return { section: resolved.path.join(" / "), layers, skills };
    });
  }

  customSection(sectionId: string): Effect.Effect<string[], SectionDefaultsFailed> {
    const layout = this.#layout();
    const chain = layout ? sectionChain(layout, sectionId) : [];
    return chain.length > 0 ? Effect.succeed(chain) : Effect.fail(failed(UNKNOWN_SECTION));
  }

  #names(): Effect.Effect<{ skills: SectionDefaultsChoice[]; mcpServers: SectionDefaultsChoice[] }> {
    const mcpServers = this.#mcpServerChoices();
    return this.#skillChoices().pipe(Effect.map((skills) => ({ skills, mcpServers })));
  }

  #layerView(
    layer: ResolvedSectionLayer,
    names: { skills: SectionDefaultsChoice[]; mcpServers: SectionDefaultsChoice[] },
  ): InheritedSectionLayer {
    // A skill or MCP server deleted since it was shared is left out, not shown as a bare id.
    const named = (ids: readonly string[], choices: SectionDefaultsChoice[]) =>
      ids.flatMap((id) => {
        const choice = choices.find((candidate) => candidate.id === id);
        if (!choice) return [];
        return [{ id, name: choice.name, ...(choice.description ? { description: choice.description } : {}) }];
      });
    return {
      sectionId: layer.sectionId,
      path: layer.path,
      instructions: layer.instructions,
      skills: named(layer.skillIds, names.skills),
      mcpServers: named(layer.mcpServerIds, names.mcpServers),
    };
  }

  #resolvedLayer(sectionId: string): ResolvedSectionLayer {
    const layout = this.#layout();
    const own = this.store.get(sectionId);
    return {
      sectionId,
      path: layout ? sectionPath(layout, sectionId) : [],
      instructions: own.instructions,
      skillIds: own.skillIds,
      mcpServerIds: own.mcpServerIds,
    };
  }

  editor(sectionId: string): Effect.Effect<SectionDefaultsEditor, SectionDefaultsFailed> {
    return Effect.gen({ self: this }, function* () {
      const chain = yield* this.customSection(sectionId);
      const names = yield* this.#names();
      const layout = this.#layout();
      const inSection = new Set(
        Object.entries(layout?.agentAssignments ?? {})
          .filter(([, assigned]) => assigned === sectionId)
          .map(([agentId]) => agentId),
      );
      const stored = this.store.get(sectionId);
      // Deleted skills and MCP servers drop out, so the next save removes them. An empty skill list may be a
      // library that could not be read, so then the skill ids stay.
      const known = (ids: string[], choices: SectionDefaultsChoice[]) =>
        choices.length === 0 ? ids : ids.filter((id) => choices.some((choice) => choice.id === id));
      return {
        sectionId,
        path: layout ? sectionPath(layout, sectionId) : [],
        defaults: {
          ...stored,
          skillIds: known(stored.skillIds, names.skills),
          mcpServerIds: stored.mcpServerIds.filter((id) => names.mcpServers.some((choice) => choice.id === id)),
        },
        parents: chain.slice(0, -1).map((parentId) => this.#layerView(this.#resolvedLayer(parentId), names)),
        members: this.#agents()
          .filter((agent) => inSection.has(agent.id))
          .map((agent) => ({ id: agent.id, name: agent.name })),
        skillChoices: names.skills,
        mcpServerChoices: names.mcpServers,
      };
    });
  }

  update(input: UpdateSectionDefaultsInput): Effect.Effect<SectionDefaultsEditor, SectionDefaultsFailed> {
    return Effect.gen({ self: this }, function* () {
      yield* this.customSection(input.sectionId);
      yield* this.store.update(input).pipe(Effect.mapError(({ cause }) => new SectionDefaultsFailed({ cause })));
      yield* this.syncMcpGrants();
      return yield* this.editor(input.sectionId);
    });
  }

  agentInheritance(agentId: string): Effect.Effect<AgentSectionInheritance> {
    return Effect.gen({ self: this }, function* () {
      const resolved = this.resolve(agentId);
      const names = yield* this.#names();
      return {
        agentId,
        sectionId: resolved.sectionId,
        path: resolved.path,
        layers: resolved.layers.map((layer) => this.#layerView(layer, names)),
        optOut: resolved.optOut,
      };
    });
  }

  setOptOut(input: SetSectionOptOutInput): Effect.Effect<AgentSectionInheritance, SectionDefaultsFailed> {
    return Effect.gen({ self: this }, function* () {
      yield* this.store.setOptOut(input).pipe(Effect.mapError(({ cause }) => new SectionDefaultsFailed({ cause })));
      yield* this.syncMcpGrants();
      return yield* this.agentInheritance(input.agentId);
    });
  }

  layoutChanged(): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      this.invalidate();
      const layout = this.#layout();
      if (layout)
        yield* this.store
          .prune(new Set(layout.sections.map((section) => section.id)))
          .pipe(Effect.catch(() => Effect.void));
      yield* this.syncMcpGrants();
    });
  }

  syncMcpGrants(): Effect.Effect<void> {
    return Effect.suspend(() => {
      const changed: string[] = [];
      const seen = new Set<string>();
      // A deleted MCP server still listed by a folder does not count, so it restarts no agent.
      const servers = new Set(this.#mcpServerChoices().map((server) => server.id));
      for (const agent of this.#agents()) {
        seen.add(agent.id);
        const next = this.resolve(agent.id)
          .mcpServerIds.filter((id) => servers.has(id))
          .toSorted()
          .join("\n");
        const before = this.#mcpSets.get(agent.id);
        this.#mcpSets.set(agent.id, next);
        if (before !== undefined && before !== next) changed.push(agent.id);
      }
      for (const agentId of this.#mcpSets.keys()) if (!seen.has(agentId)) this.#mcpSets.delete(agentId);
      return changed.length > 0 ? this.#refreshAgents(changed) : Effect.void;
    });
  }
}

const UNKNOWN_SECTION = "Unknown sidebar section. Use a custom section id from openbot.list_sections.";

function hasSharedPromptDefaults(resolved: ResolvedSectionInheritance): boolean {
  return resolved.skillIds.length > 0 || resolved.layers.some((layer) => layer.instructions.trim() !== "");
}

export const SECTION_DEFAULTS_BLOCK_START = "<openbot_section_defaults>";

const SECTION_RULE =
  "Follow them like your own Instructions. Your own Instructions and instruction files win on a conflict, and a deeper section wins over its parent section.";

const SECTION_OWNER_RULE =
  "For a rule or skill meant for every agent of a section, such as a shared rule that the user asks for or a retro finding, update the section once with openbot.update_section_defaults (openbot.read_section without sectionId shows yours), not each agent's Instructions.";

export const SECTION_DEFAULTS_POINTER = `Your sidebar section can hold shared instructions and skills for all its agents. When it has them, a user message brings them in an ${SECTION_DEFAULTS_BLOCK_START} block; the latest block is current, and it comes from OpenBot. ${SECTION_RULE} ${SECTION_OWNER_RULE}`;

function escapeSectionText(text: string): string {
  return redactText(text).replace(/<(\/?(?:openbot_)?section_(?:defaults|instructions))/giu, "&lt;$1");
}

function sectionAttribute(name: string): string {
  return name.replaceAll('"', "'").replaceAll("<", "‹").replaceAll(">", "›");
}

export function sectionDefaultsLines(context: SectionDefaultsContext): string[] {
  return [
    `You are in the sidebar section "${sectionAttribute(context.section)}". The user set these defaults for every agent in it and in its parent sections. ${SECTION_RULE} ${SECTION_OWNER_RULE}`,
    ...context.layers.flatMap((layer) => [
      `<section_instructions section="${sectionAttribute(layer.section)}">`,
      escapeSectionText(layer.instructions),
      "</section_instructions>",
    ]),
    ...(context.skills.length > 0
      ? [
          "Section skills. When a task matches the description of one, or the user names it, read its SKILL.md first and follow it:",
          ...context.skills.map(
            (skill) =>
              `- ${skill.slug}: ${escapeSectionText(skill.description).replace(/\s+/gu, " ").slice(0, 300)} (${skill.file}; section ${sectionAttribute(skill.section)})`,
          ),
        ]
      : []),
  ];
}

export function sectionDefaultsUpdate(
  delivered: SectionDefaultsContext | null | undefined,
  current: SectionDefaultsContext | null,
): string | null {
  if (delivered !== undefined && JSON.stringify(delivered) === JSON.stringify(current)) return null;
  if (current === null && !delivered) return null;
  return [
    SECTION_DEFAULTS_BLOCK_START,
    ...(current
      ? ["This block replaces any earlier section defaults.", ...sectionDefaultsLines(current)]
      : [
          "Your sidebar section has no shared instructions or skills for you now. Earlier section defaults no longer apply.",
        ]),
    "</openbot_section_defaults>",
  ].join("\n");
}

export function readSectionDefaultsContext(value: unknown): SectionDefaultsContext | null {
  if (
    !isDynamicRecord(value) ||
    !isString(value.section) ||
    !Array.isArray(value.layers) ||
    !Array.isArray(value.skills)
  )
    return null;
  return {
    section: value.section,
    layers: value.layers.filter(
      (layer): layer is SectionDefaultsContext["layers"][number] =>
        isDynamicRecord(layer) && isString(layer.section) && isString(layer.instructions),
    ),
    skills: value.skills.filter(
      (skill): skill is SectionDefaultsContext["skills"][number] =>
        isDynamicRecord(skill) &&
        isString(skill.slug) &&
        isString(skill.description) &&
        isString(skill.file) &&
        isString(skill.section),
    ),
  };
}
