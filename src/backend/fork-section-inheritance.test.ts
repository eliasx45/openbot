import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentSummary, DEFAULT_AGENT_DEFAULTS, type SidebarLayoutSnapshot } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { installFakeAgent, readJsonl, runTurn, stopClients, xorCipher } from "../../scripts/provider-fakes/host";
import { CustomAgentStore } from "../main/custom-agent-store";
import { developerInstructions } from "./agent/developer-instructions";
import {
  FORK_SECTION_TOOL_DEFINITIONS,
  forkSectionReadAgentView,
  handleForkSectionTool,
} from "./agent/fork-section-tools";
import { openBotToolResult } from "./agent/routine-tools";
import { handleSidebarTool } from "./agent/sidebar-tools";
import { TurnContext } from "./agent/turn-context";
import type { AgentClient } from "./agent-client";
import { CodexAppServerClient } from "./app-server-client";
import { runCauseEffect } from "./effect-boundary";
import { forkHub } from "./fork-hub";
import {
  ForkSectionInheritance,
  resolveSectionInheritance,
  SECTION_DEFAULTS_POINTER,
  type SectionDefaultsContext,
  SectionDefaultsStore,
  type SectionSkillFile,
} from "./fork-section-inheritance";
import { getRecord, getString } from "./protocol";
import { requireProviderDriver } from "./provider-drivers";
import { SidebarLayoutStore } from "./sidebar-layout-store";

const roots: string[] = [];
const clients: AgentClient[] = [];

afterEach(async () => {
  forkHub.sections = null;
  await stopClients(clients.splice(0));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `openbot-section-${name}-`));
  roots.push(root);
  return root;
}

const EDITING = "6f0b6a3e-1d2c-4b5a-8e7f-0a1b2c3d4e5f";
const CLIENTS = "7a1c7b4f-2e3d-4c6b-9f80-1b2c3d4e5f60";
const SCHOOL = "8b2d8c50-3f4e-4d7c-a091-2c3d4e5f6071";

function layout(assignments: Record<string, string>): SidebarLayoutSnapshot {
  return {
    revision: 1,
    sections: [
      { id: EDITING, name: "Editing" },
      { id: CLIENTS, name: "Clients", parentId: EDITING },
      { id: SCHOOL, name: "School" },
    ],
    order: ["people", EDITING, CLIENTS, SCHOOL, "unassigned"],
    agentAssignments: assignments,
    agentOrder: [],
  };
}

const SKILL_ID = "local-skill-11111111-2222-4333-8444-555555555555";
const OTHER_SKILL_ID = "local-skill-66666666-7777-4888-8999-000000000000";

async function sectionsFixture(initial: Record<string, string>) {
  const root = await tempRoot("store");
  const store = new SectionDefaultsStore(join(root, "fork-section-defaults-v1.json"));
  await runCauseEffect(store.initialize());
  let current = layout(initial);
  const skillFile = (id: string, slug: string): SectionSkillFile => ({
    id,
    slug,
    name: slug,
    description: `Use ${slug} for client edits.`,
    file: join(root, "skills", slug, "SKILL.md"),
  });
  const refreshed: string[][] = [];
  const agents = [
    { id: "tapa", name: "Tapa" },
    { id: "tatiana", name: "Tatiana" },
    { id: "tyson", name: "Tyson" },
    { id: "adrian", name: "Adrian" },
  ];
  const sections = new ForkSectionInheritance({
    store,
    layout: () => current,
    skillFiles: (ids) =>
      Effect.succeed(
        ids.flatMap((id) =>
          id === SKILL_ID
            ? [skillFile(id, "client-voice")]
            : id === OTHER_SKILL_ID
              ? [skillFile(id, "color-grade")]
              : [],
        ),
      ),
    skillChoices: () =>
      Effect.succeed([
        { id: SKILL_ID, name: "client-voice", description: "Write in the client's voice." },
        { id: OTHER_SKILL_ID, name: "color-grade" },
      ]),
    mcpServerChoices: () => [
      { id: "mcp-frameio", name: "Frame.io" },
      { id: "mcp-drive", name: "Drive" },
    ],
    agents: () => agents,
    refreshAgents: (agentIds) => Effect.sync(() => void refreshed.push([...agentIds])),
  });
  return {
    root,
    store,
    sections,
    refreshed,
    agents,
    setLayout: (assignments: Record<string, string>) => {
      current = layout(assignments);
      sections.invalidate();
    },
  };
}

describe("section defaults store", () => {
  it("keeps each section's markdown, skills and MCP servers, and removes an emptied section", async () => {
    const { root, store } = await sectionsFixture({});
    const markdown = "# Clients\n\n- Always deliver ProRes 422.\n- Never post drafts publicly.\n";
    await runCauseEffect(store.update({ sectionId: CLIENTS, instructions: markdown, skillIds: [SKILL_ID] }));
    await runCauseEffect(store.update({ sectionId: CLIENTS, mcpServerIds: ["mcp-frameio", "mcp-frameio"] }));
    await runCauseEffect(store.setOptOut({ agentId: "tyson", kind: "skill", id: SKILL_ID, optedOut: true }));

    const again = new SectionDefaultsStore(join(root, "fork-section-defaults-v1.json"));
    await runCauseEffect(again.initialize());
    expect(again.get(CLIENTS)).toMatchObject({
      instructions: markdown,
      skillIds: [SKILL_ID],
      mcpServerIds: ["mcp-frameio"],
    });
    expect(again.optOut("tyson")).toEqual({ skillIds: [SKILL_ID], mcpServerIds: [] });
    const stored = JSON.parse(await readFile(join(root, "fork-section-defaults-v1.json"), "utf8"));
    expect(stored.version).toBe(1);
    expect(stored.sections[CLIENTS].instructions).toBe(markdown);

    await runCauseEffect(again.update({ sectionId: CLIENTS, instructions: " ", skillIds: [], mcpServerIds: [] }));
    expect(again.sectionIds()).toEqual([]);
    await runCauseEffect(again.update({ sectionId: SCHOOL, instructions: "Cite sources." }));
    await runCauseEffect(again.prune(new Set([EDITING])));
    expect(again.get(SCHOOL).instructions).toBe("");
  });
});

describe("section inheritance", () => {
  it("resolves section only, agent only, nested sections, moves and new agents", async () => {
    const fixture = await sectionsFixture({ tapa: CLIENTS, tatiana: CLIENTS, adrian: SCHOOL });
    const { sections, store } = fixture;
    await runCauseEffect(
      store.update({ sectionId: EDITING, instructions: "Editing rule", skillIds: [OTHER_SKILL_ID] }),
    );
    await runCauseEffect(
      store.update({ sectionId: CLIENTS, instructions: "Clients rule", skillIds: [SKILL_ID, OTHER_SKILL_ID] }),
    );

    const tapa = sections.resolve("tapa");
    expect(tapa.path).toEqual(["Editing", "Clients"]);
    expect(tapa.layers.map((layer) => [layer.path.join("/"), layer.instructions])).toEqual([
      ["Editing", "Editing rule"],
      ["Editing/Clients", "Clients rule"],
    ]);
    expect(tapa.skillIds).toEqual([OTHER_SKILL_ID, SKILL_ID]);

    expect(sections.resolve("adrian").layers).toEqual([
      expect.objectContaining({ sectionId: SCHOOL, instructions: "", skillIds: [] }),
    ]);
    expect(await Effect.runPromise(sections.context({ id: "adrian", workspacePath: fixture.root }))).toBeNull();
    expect(sections.resolve("tyson").sectionId).toBeNull();

    fixture.setLayout({ tapa: CLIENTS, tatiana: CLIENTS, adrian: SCHOOL, tyson: CLIENTS, newcomer: CLIENTS });
    expect(sections.resolve("tyson").skillIds).toEqual([OTHER_SKILL_ID, SKILL_ID]);
    expect(sections.resolve("newcomer").layers.map((layer) => layer.instructions)).toEqual([
      "Editing rule",
      "Clients rule",
    ]);

    fixture.setLayout({ tapa: SCHOOL, tatiana: CLIENTS });
    expect(sections.resolve("tapa").skillIds).toEqual([]);
    expect(sections.key("tapa")).toBe("");

    fixture.setLayout({ tapa: EDITING });
    expect(sections.resolve("tapa").skillIds).toEqual([OTHER_SKILL_ID]);
  });

  it("lets an agent opt out of a section skill or MCP server, and keeps its own skill copy", async () => {
    const fixture = await sectionsFixture({ tapa: CLIENTS, tatiana: CLIENTS });
    const { sections, store } = fixture;
    await runCauseEffect(
      store.update({ sectionId: CLIENTS, skillIds: [SKILL_ID, OTHER_SKILL_ID], mcpServerIds: ["mcp-frameio"] }),
    );
    await runCauseEffect(sections.setOptOut({ agentId: "tatiana", kind: "mcp", id: "mcp-frameio", optedOut: true }));
    await runCauseEffect(sections.setOptOut({ agentId: "tatiana", kind: "skill", id: SKILL_ID, optedOut: true }));
    expect(sections.grantsMcp("tapa", "mcp-frameio")).toBe(true);
    expect(sections.grantsMcp("tatiana", "mcp-frameio")).toBe(false);
    expect(sections.resolve("tatiana").skillIds).toEqual([OTHER_SKILL_ID]);

    const workspace = join(fixture.root, "tapa");
    await mkdir(join(workspace, ".claude", "skills", "color-grade"), { recursive: true });
    await writeFile(join(workspace, ".claude", "skills", "color-grade", "SKILL.md"), "---\nname: color-grade\n---\n");
    const context = await Effect.runPromise(sections.context({ id: "tapa", workspacePath: workspace }));
    expect(context?.skills.map((skill) => skill.slug)).toEqual(["client-voice"]);
  });

  it("restarts only the agents whose section MCP servers changed", async () => {
    const fixture = await sectionsFixture({ tapa: CLIENTS, adrian: SCHOOL });
    const { sections, refreshed } = fixture;
    await runCauseEffect(sections.syncMcpGrants());
    await runCauseEffect(sections.update({ sectionId: CLIENTS, mcpServerIds: ["mcp-frameio"] }));
    expect(refreshed).toEqual([["tapa"]]);
    fixture.setLayout({ tapa: CLIENTS, adrian: CLIENTS });
    await runCauseEffect(sections.layoutChanged());
    expect(refreshed.at(-1)).toEqual(["adrian"]);
    await runCauseEffect(sections.update({ sectionId: CLIENTS, instructions: "Only text" }));
    expect(refreshed).toHaveLength(2);
  });
});

function contextFixture(text: string, skills: SectionDefaultsContext["skills"] = []): SectionDefaultsContext {
  return { section: "Editing / Clients", layers: [{ section: "Editing / Clients", instructions: text }], skills };
}

describe("section defaults in the prompt", () => {
  it("brings section text before the agent's own Instructions in a turn, once, and again on change or leave", () => {
    const turns = new TurnContext();
    const skill = {
      slug: "client-voice",
      description: "Voice.",
      file: "/tmp/client-voice/SKILL.md",
      section: "Clients",
    };
    turns.set(
      "thread",
      {
        sectionTeammates: null,
        sectionDefaults: contextFixture("Always deliver ProRes.", [skill]),
        instructionsFile: { fileName: "AGENTS.md", text: "I am Tapa.", truncated: false },
      },
      false,
    );
    const first = turns.take("thread");
    const sectionBlock = first.findIndex((block) => block.startsWith("<openbot_section_defaults>"));
    const agentBlock = first.findIndex((block) => block.startsWith("<openbot_agent_instructions>"));
    expect(sectionBlock).toBeGreaterThanOrEqual(0);
    expect(agentBlock).toBeGreaterThan(sectionBlock);
    expect(first[sectionBlock]).toContain("Always deliver ProRes.");
    expect(first[sectionBlock]).toContain("client-voice: Voice. (/tmp/client-voice/SKILL.md");
    expect(first[sectionBlock]).toContain("win on a conflict");
    expect(turns.take("thread")).toEqual([]);

    turns.set("thread", { sectionTeammates: null, sectionDefaults: contextFixture("Deliver H.264.") }, true);
    expect(turns.take("thread").join("\n")).toContain("Deliver H.264.");
    turns.set("thread", { sectionTeammates: null, sectionDefaults: null }, true);
    expect(turns.take("thread").join("\n")).toContain("Earlier section defaults no longer apply.");
    expect(turns.take("thread")).toEqual([]);
    turns.set("other", { sectionTeammates: null, sectionDefaults: null }, true);
    expect(turns.take("other").some((block) => block.startsWith("<openbot_section_defaults>"))).toBe(false);
  });

  it("puts the pointer, or the inline section text before <agent_instructions>, in the developer instructions", () => {
    const agent: AgentSummary = {
      id: "tapa",
      name: "Tapa",
      title: "Editor",
      description: "",
      notifications: false,
      provider: "codex",
      model: "gpt-5",
      reasoningEffort: "medium",
      threadId: null,
      workspacePath: "/tmp/tapa",
      preview: "",
      updatedAt: null,
      avatarSeed: "tapa",
      avatarHue: null,
      avatarUrl: null,
    };
    const defaults = DEFAULT_AGENT_DEFAULTS;
    const turnMode = developerInstructions(agent, "/tmp/shared", [], "/tmp/auto", defaults, { teammatesInTurns: true });
    expect(turnMode).toContain(SECTION_DEFAULTS_POINTER);
    expect(turnMode).toContain("openbot.update_section_defaults");
    const inline = developerInstructions(agent, "/tmp/shared", [], "/tmp/auto", defaults, {
      sectionDefaults: contextFixture("Inline rule"),
      instructionsFile: {
        fileName: "AGENTS.md",
        text: "Own rule",
        truncated: false,
        readByCli: false,
      },
    });
    expect(inline.indexOf("Inline rule")).toBeGreaterThan(0);
    expect(inline.indexOf("Inline rule")).toBeLessThan(inline.indexOf("<agent_instructions>"));
  });

  it("reaches a Codex turn and an ACP (Gemini) turn as a context block", async () => {
    const root = await tempRoot("providers");
    const codexLog = join(root, "codex.jsonl");
    const codexExecutable = join(root, "bin", "codex");
    await installFakeAgent(codexExecutable, "codex-turn-input", { FAKE_LOG: codexLog });
    const codex = new CodexAppServerClient(codexExecutable, 10_000, { CODEX_HOME: join(root, "codex") });
    clients.push(codex);
    codex.start();
    const started = await runCauseEffect(
      codex.request(
        "thread/start",
        { cwd: root, sectionTeammates: null, sectionDefaults: contextFixture("Codex section rule") },
        (value) => value,
      ),
    );
    const codexThread = getString(getRecord(started, "thread"), "id") ?? "";
    await runTurn(codex, codexThread, { text: "hello", timeoutMs: 10_000 });
    const codexEntries = await readJsonl<{ method: string; params?: { sectionDefaults?: unknown }; input?: unknown }>(
      codexLog,
    );
    expect(codexEntries.find((entry) => entry.method === "thread/start")?.params).not.toHaveProperty("sectionDefaults");
    const codexInput = JSON.stringify(codexEntries.find((entry) => entry.method === "turn/start")?.input);
    expect(codexInput).toContain("<openbot_section_defaults>");
    expect(codexInput).toContain("Codex section rule");

    const acpLog = join(root, "acp.jsonl");
    const acpExecutable = join(root, "bin", "fake-acp-agent");
    await installFakeAgent(acpExecutable, "acp-turn-input");
    const agents = new CustomAgentStore({ path: join(root, "custom-agents.json"), cipher: xorCipher });
    await runCauseEffect(agents.load());
    await runCauseEffect(
      agents.save({
        id: "plain",
        name: "plain",
        command: acpExecutable,
        args: [],
        env: [
          { name: "FAKE_MODE", value: "plain" },
          { name: "FAKE_LOG", value: acpLog },
        ],
        usagePrompt: null,
      }),
    );
    const driver = requireProviderDriver("acp");
    const acp = driver.createClient(
      await runCauseEffect(driver.resolveCli()),
      10_000,
      { apiKey: () => null, customProviders: () => [], mcpServers: () => [], customAgents: () => agents.configs() },
      undefined,
    );
    clients.push(acp);
    acp.start();
    const acpStarted = await runCauseEffect(
      acp.request(
        "thread/start",
        {
          model: "plain/default",
          cwd: root,
          runtimeWorkspaceRoots: [root],
          developerInstructions: "base",
          sectionTeammates: null,
          sectionDefaults: contextFixture("Gemini section rule"),
        },
        (value) => value,
      ),
    );
    const acpThread = getString(getRecord(acpStarted, "thread"), "id") ?? "";
    await runTurn(acp, acpThread, { model: "plain/default", text: "hello", timeoutMs: 10_000 });
    const prompts = await readJsonl<{ prompt: { text?: string }[] }>(acpLog);
    const context = prompts.flatMap((entry) => entry.prompt.map((block) => block.text ?? "")).join("\n");
    expect(context).toContain("<openbot_section_defaults>");
    expect(context).toContain("Gemini section rule");
  });
});

describe("section tools", () => {
  it("lists, reads and updates section defaults; refuses members; asks before a new MCP server", async () => {
    const fixture = await sectionsFixture({ tapa: CLIENTS, tatiana: CLIENTS, adrian: SCHOOL });
    const { sections, store } = fixture;
    forkHub.sections = sections;
    expect(FORK_SECTION_TOOL_DEFINITIONS.map((tool) => tool.name)).toEqual(["read_section", "update_section_defaults"]);
    const approvals: string[] = [];
    let decision: "accept" | "decline" = "accept";
    const options = (canAdminister = true) => ({
      sections,
      senderAgentId: "tapa",
      requestersCanAdminister: canAdminister,
      approve: (reason: string) =>
        Effect.sync(() => {
          approvals.push(reason);
          return decision;
        }),
    });
    const parse = (response: { contentItems: { text?: string }[] } | null) =>
      JSON.parse(response?.contentItems[0]?.text ?? "null");

    const refused = await runCauseEffect(
      handleForkSectionTool("update_section_defaults", { sectionId: CLIENTS, instructions: "x" }, options(false)),
    );
    expect(refused?.success).toBe(false);
    expect(parse(refused).error).toContain("owner or admin");
    expect(store.get(CLIENTS).instructions).toBe("");

    const updated = await runCauseEffect(
      handleForkSectionTool(
        "update_section_defaults",
        { sectionId: CLIENTS, instructions: "Clients rule", skillIds: ["client-voice"] },
        options(),
      ),
    );
    expect(parse(updated)).toMatchObject({ status: "updated", skillIds: [SKILL_ID], agents: ["Tapa", "Tatiana"] });
    expect(approvals).toEqual([]);

    decision = "decline";
    const declined = await runCauseEffect(
      handleForkSectionTool("update_section_defaults", { sectionId: CLIENTS, mcpServerIds: ["Frame.io"] }, options()),
    );
    expect(declined?.success).toBe(false);
    expect(store.get(CLIENTS).mcpServerIds).toEqual([]);
    decision = "accept";
    await runCauseEffect(
      handleForkSectionTool("update_section_defaults", { sectionId: CLIENTS, mcpServerIds: ["Frame.io"] }, options()),
    );
    expect(store.get(CLIENTS).mcpServerIds).toEqual(["mcp-frameio"]);
    expect(approvals).toHaveLength(2);

    const unknown = await runCauseEffect(
      handleForkSectionTool("update_section_defaults", { sectionId: CLIENTS, skillIds: ["nope"] }, options()),
    );
    expect(parse(unknown).error).toContain("list_local_skills");

    const own = parse(await runCauseEffect(handleForkSectionTool("read_section", {}, options())));
    expect(own).toMatchObject({
      sectionId: CLIENTS,
      path: "Editing / Clients",
      instructions: "Clients rule",
      skills: [{ id: SKILL_ID, name: "client-voice" }],
      mcpServers: [{ id: "mcp-frameio", name: "Frame.io" }],
      agents: [
        { id: "tapa", name: "Tapa" },
        { id: "tatiana", name: "Tatiana" },
      ],
    });

    const sidebarPath = join(fixture.root, "openbot-sidebar-layout-v1.json");
    await writeFile(
      sidebarPath,
      JSON.stringify({ version: 2, ...layout({ tapa: CLIENTS, tatiana: CLIENTS, adrian: SCHOOL }) }),
    );
    const sidebar = new SidebarLayoutStore(sidebarPath);
    await runCauseEffect(sidebar.initialize());
    const listed = parse(
      await runCauseEffect(
        handleSidebarTool(
          "list_sections",
          {},
          sidebar,
          () => new Set(),
          () => new Set(),
        ),
      ),
    );
    expect(listed.sectionDefaults[CLIENTS]).toEqual({
      instructions: "Clients rule",
      skillIds: [SKILL_ID],
      mcpServerIds: ["mcp-frameio"],
    });
    expect(listed.sectionDefaults[SCHOOL]).toBeUndefined();

    const readAgent = forkSectionReadAgentView(sections.resolve("tatiana"));
    expect(readAgent).toMatchObject({
      sectionId: CLIENTS,
      path: "Editing / Clients",
      inherited: [{ sectionId: CLIENTS, instructions: "Clients rule", skillIds: [SKILL_ID] }],
      skillIds: [SKILL_ID],
      mcpServerIds: ["mcp-frameio"],
    });
    expect(forkSectionReadAgentView(sections.resolve("nobody"))).toEqual({ sectionId: null });
    expect(openBotToolResult(readAgent).success).toBe(true);
    expect(resolveSectionInheritance(null, (id) => store.get(id), { skillIds: [], mcpServerIds: [] }, "tapa")).toEqual(
      expect.objectContaining({ sectionId: null, layers: [] }),
    );
  });
});
