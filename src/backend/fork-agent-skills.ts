/**
 * Fork (docs/fork/FEATURES.md, "`$` list shows the agent's own skills"): the skills and commands
 * that the agent's own CLI has, for the `$` list. Upstream lists only the skills OpenBot manages or
 * finds in the agent's workspace and `~/.agents/skills`; a CLI also loads the skills in its home
 * folder (Claude Code: `~/.claude/skills`) and in the project folders it works in, an ACP agent
 * names its commands in `available_commands_update`, and Claude (Agent SDK, not ACP) names its
 * skills, plugin skills and built-in commands in `supportedCommands()` (`ClaudeAgentClient`).
 *
 * A tag of one of these is `agent:<name>` and reaches the agent as `/<name> (skill)`: Claude Code
 * runs a skill that the user names as `/<name>` with its Skill tool, and an ACP agent knows its
 * commands by the same name. A Claude Code built-in command is `agent-cmd:<name>` and reaches it as
 * a bare `/<name>`, which runs only at the start of the message (`expandAgentCommandTags`).
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { agentProviderDescriptor } from "@openbot/contracts/agent-providers";
import { chatTagReferences } from "@openbot/contracts/chat-tag-references";
import { AGENT_COMMAND_ID_PREFIX, type AgentSummary, type InstalledSkill } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import { FORK_COMMANDS } from "./fork-commands";
import { HOME_SKILL_FOLDER } from "./home-skills";
import { readSkillFrontmatter } from "./skill-frontmatter";

/**
 * A command that the agent's CLI listed: an ACP agent in its last `available_commands_update`, Claude
 * in the Agent SDK's `supportedCommands()`. `builtin`: a command of Claude Code itself (`/compact`),
 * which runs only as the start of a message, not a skill.
 */
export interface AgentOwnCommand {
  name: string;
  description: string;
  builtin?: boolean;
}

const AGENT_SKILL_ID_PREFIX = "agent:";

/**
 * Claude Code commands that make no sense in OpenBot, as claude-agent-acp leaves them out
 * (`getAvailableSlashCommands`): OpenBot owns the session, the login and the MCP servers.
 */
const CLAUDE_HIDDEN_COMMANDS = new Set([
  "clear",
  "cost",
  "keybindings-help",
  "login",
  "logout",
  "mcp",
  "output-style:new",
  "release-notes",
  "todos",
]);

/** The fields of the Agent SDK's `SlashCommand` that the `$` list reads. */
export interface ClaudeCommandRow {
  name: string;
  description: string;
  builtin?: boolean | undefined;
}

/** A row of a `commands_changed` message, which the stream gives untyped. */
export function isClaudeCommandRow(value: unknown): value is ClaudeCommandRow {
  return (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    typeof value.name === "string" &&
    "description" in value &&
    typeof value.description === "string"
  );
}

/**
 * The Agent SDK's command list as the `$` list wants it. Left out: the commands above, the commands
 * that only work in a terminal (`terminal_slash_commands` of `system/init`), and the skills of
 * OpenBot's own plugins (`agents:`, `openbot:`), which upstream already lists by their folders.
 */
export function claudeCommandsForList(
  commands: readonly ClaudeCommandRow[],
  terminal: readonly string[],
): AgentOwnCommand[] {
  return commands
    .filter(
      (command) =>
        !CLAUDE_HIDDEN_COMMANDS.has(command.name) &&
        !terminal.includes(command.name) &&
        !/^(?:agents|openbot):/u.test(command.name),
    )
    .map((command) => ({
      name: command.name,
      description: command.description,
      ...(command.builtin ? { builtin: true } : {}),
    }));
}
const MAX_SKILLS_PER_FOLDER = 300;
const MAX_SKILL_FILE_BYTES = 256 * 1024;
const MAX_DESCRIPTION = 1024;

/** The `name` of a `SKILL.md` front matter, which the CLI uses; the folder name when there is none. */
function frontmatterName(text: string): string | null {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(text)?.[1];
  const name = block ? /^name:\s*["']?([^"'\r\n]+?)["']?\s*$/mu.exec(block)?.[1] : undefined;
  return name?.trim() || null;
}

async function folderSkills(root: string, label: string): Promise<InstalledSkill[]> {
  let names: string[];
  try {
    names = (await readdir(root)).filter((name) => !name.startsWith(".")).sort();
  } catch {
    return [];
  }
  const skills: InstalledSkill[] = [];
  for (const slug of names.slice(0, MAX_SKILLS_PER_FOLDER)) {
    const file = join(root, slug, "SKILL.md");
    try {
      const info = await stat(file);
      if (!info.isFile() || info.size > MAX_SKILL_FILE_BYTES) continue;
      const text = await readFile(file, "utf8");
      const name = frontmatterName(text) ?? slug;
      const checked = readSkillFrontmatter(text, slug);
      skills.push(agentSkill(name, checked.description ?? "", `${label}/${slug}`));
    } catch {}
  }
  return skills;
}

function agentSkill(name: string, description: string, location?: string, builtin = false): InstalledSkill {
  return {
    skillId: `${builtin ? AGENT_COMMAND_ID_PREFIX : AGENT_SKILL_ID_PREFIX}${name}`,
    slug: name,
    name,
    installedVersion: 1,
    availableVersion: 1,
    state: "installed",
    enabled: true,
    // `workspace`: a folder skill that OpenBot lists and never changes; an older client decodes it.
    origin: "workspace",
    description: description.slice(0, MAX_DESCRIPTION),
    ...(location ? { location } : {}),
  };
}

/**
 * The agent CLI's own skills: its skill folders in the user's home (not `~/.agents/skills`, which
 * upstream lists) and in each project folder of the agent, then the ACP commands it listed. Names in
 * `exclude` are already in the list.
 */
export const listAgentOwnSkills = Effect.fn("ForkAgentSkills.list")(function* (
  agent: Pick<AgentSummary, "provider" | "additionalFolders"> & { workFolder?: string | undefined },
  commands: readonly AgentOwnCommand[],
  exclude: ReadonlySet<string>,
) {
  const folders = agentProviderDescriptor(agent.provider).skillFolders.filter((folder) => folder !== HOME_SKILL_FOLDER);
  const roots: Array<{ root: string; label: string }> = [];
  for (const folder of folders) {
    const home =
      folder === ".claude/skills" && process.env.CLAUDE_CONFIG_DIR
        ? join(process.env.CLAUDE_CONFIG_DIR, "skills")
        : join(homedir(), folder);
    roots.push({ root: home, label: `~/${folder}` });
  }
  const projects = new Set(agent.additionalFolders ?? []);
  if (agent.workFolder) projects.add(agent.workFolder);
  for (const project of projects)
    for (const folder of [...folders, HOME_SKILL_FOLDER])
      roots.push({ root: join(project, folder), label: join(project, folder) });
  const found = yield* Effect.promise(() => Promise.all(roots.map(({ root, label }) => folderSkills(root, label))));
  const seen = new Set(exclude);
  const skills: InstalledSkill[] = [];
  // Fork commands first (`/goal`, `/setup`, `/learn`, `/memory`): OpenBot runs them, whatever the CLI lists.
  const listed = [...FORK_COMMANDS, ...commands].map((command) =>
    agentSkill(command.name, command.description, undefined, command.builtin),
  );
  const forkCount = FORK_COMMANDS.length;
  for (const skill of [...listed.slice(0, forkCount), ...found.flat(), ...listed.slice(forkCount)]) {
    if (seen.has(skill.name)) continue;
    seen.add(skill.name);
    skills.push(skill);
  }
  return skills;
});

/** The text a provider reads for an `agent:<name>` tag, or undefined for any other id. */
export function agentSkillTagName(id: string): string | undefined {
  if (!id.startsWith(AGENT_SKILL_ID_PREFIX)) return undefined;
  const name = id.slice(AGENT_SKILL_ID_PREFIX.length).trim();
  return name && !/\s/u.test(name) ? `/${name}` : undefined;
}

/**
 * The text with each built-in command tag (`agent-cmd:<name>`) as a bare `/<name>`. The usual tag
 * text adds " (skill)", which Claude Code would read as the command's arguments. A command at the
 * start of the message loses the blank before it, because Claude Code runs a command only when the
 * message starts with `/`; one later in the text stays words for the model.
 */
export function expandAgentCommandTags(text: string): string {
  const tags = chatTagReferences(text).filter(
    (reference) => reference.kind === "skill" && reference.id.startsWith(AGENT_COMMAND_ID_PREFIX),
  );
  let result = text;
  for (const tag of tags.reverse()) {
    const name = tag.id.slice(AGENT_COMMAND_ID_PREFIX.length).trim();
    if (!name || /\s/u.test(name)) continue;
    const before = result.slice(0, tag.start);
    result = `${/^\s*$/u.test(before) ? "" : before}/${name}${result.slice(tag.end)}`;
  }
  return result;
}

/** Names cleaned as Codync does: no leading `/`, no spaces, each once, at most 500. */
export function cleanAgentCommands(
  raw: ReadonlyArray<{ name?: unknown; description?: unknown; builtin?: unknown }>,
): AgentOwnCommand[] {
  const commands = new Map<string, AgentOwnCommand>();
  for (const entry of raw) {
    const name = typeof entry.name === "string" ? entry.name.trim().replace(/^\/+/u, "") : "";
    if (!name || /\s/u.test(name) || commands.has(name)) continue;
    const description = typeof entry.description === "string" ? entry.description.trim().slice(0, 200) : "";
    commands.set(name, { name, description, ...(entry.builtin === true ? { builtin: true } : {}) });
    if (commands.size >= 500) break;
  }
  return [...commands.values()];
}

/**
 * Fork (docs/fork/FEATURES.md, "`$` in channels"): the line a channel member reads first when the
 * user's request tags skills that this member has, or null. A channel packet starts with the
 * channel's own text, not the user's, so a `/<name>` in it does not run by itself. Built-in commands
 * (`agent-cmd:`) run only at the start of a prompt, so they are not named. A member without the
 * skill gets no line and reads the tag as plain text.
 */
export function pickedSkillsLine(text: string, skills: readonly InstalledSkill[]): string | null {
  const names = new Set<string>();
  for (const reference of chatTagReferences(text)) {
    if (reference.kind !== "skill" || reference.id.startsWith(AGENT_COMMAND_ID_PREFIX)) continue;
    const skill = skills.find((item) => item.skillId === reference.id && item.enabled !== false);
    if (skill) names.add(agentSkillTagName(skill.skillId) ?? skill.name);
  }
  const list = [...names];
  if (list.length === 0) return null;
  return list.length === 1
    ? `The user picked your ${list[0]} skill for this message. Use it.`
    : `The user picked your skills ${list.join(", ")} for this message. Use them.`;
}
