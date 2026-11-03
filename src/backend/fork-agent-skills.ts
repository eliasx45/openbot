/**
 * Fork (docs/fork/FEATURES.md, "`$` list shows the agent's own skills"): the skills and commands
 * that the agent's own CLI has, for the `$` list. Upstream lists only the skills OpenBot manages or
 * finds in the agent's workspace and `~/.agents/skills`; a CLI also loads the skills in its home
 * folder (Claude Code: `~/.claude/skills`) and in the project folders it works in, and an ACP agent
 * names its commands in `available_commands_update`.
 *
 * A tag of one of these is `agent:<name>` and reaches the agent as `/<name> (skill)`: Claude Code
 * runs a skill that the user names as `/<name>` with its Skill tool, and an ACP agent knows its
 * commands by the same name.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { agentProviderDescriptor } from "@openbot/contracts/agent-providers";
import type { AgentSummary, InstalledSkill } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import { HOME_SKILL_FOLDER } from "./home-skills";
import { readSkillFrontmatter } from "./skill-frontmatter";

/** A command that an ACP agent listed in its last `available_commands_update`. */
export interface AgentOwnCommand {
  name: string;
  description: string;
}

export const AGENT_SKILL_ID_PREFIX = "agent:";
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

function agentSkill(name: string, description: string, location?: string): InstalledSkill {
  return {
    skillId: `${AGENT_SKILL_ID_PREFIX}${name}`,
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
  for (const skill of [...found.flat(), ...commands.map((command) => agentSkill(command.name, command.description))]) {
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

/** Names cleaned as Codync does: no leading `/`, no spaces, each once, at most 500. */
export function cleanAgentCommands(raw: ReadonlyArray<{ name?: unknown; description?: unknown }>): AgentOwnCommand[] {
  const commands = new Map<string, AgentOwnCommand>();
  for (const entry of raw) {
    const name = typeof entry.name === "string" ? entry.name.trim().replace(/^\/+/u, "") : "";
    if (!name || /\s/u.test(name) || commands.has(name)) continue;
    const description = typeof entry.description === "string" ? entry.description.trim().slice(0, 200) : "";
    commands.set(name, { name, description });
    if (commands.size >= 500) break;
  }
  return [...commands.values()];
}
