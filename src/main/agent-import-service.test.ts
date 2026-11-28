import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentModelOption, AgentSummary } from "@openbot/contracts/ipc";
import { sourceText } from "@openbot/i18n/source";
import { Effect } from "effect";
import { strToU8, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AgentImportAgents, AgentImportService } from "./agent-import-service";

const MODELS: AgentModelOption[] = [
  {
    provider: "codex",
    id: "gpt-5",
    name: "GPT-5",
    description: "",
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: ["low", "medium", "high"],
  },
  {
    provider: "claude",
    id: "claude-opus-5-5",
    name: "Claude Opus 5.5",
    description: "",
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
  },
];

let root: string;
let agents: AgentSummary[];
let updates: unknown[];
let models: AgentModelOption[];
let refuseUpdate: boolean;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "openbot-import-model-"));
  agents = [];
  updates = [];
  models = MODELS;
  refuseUpdate = false;
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function boundary(): AgentImportAgents {
  return {
    listAgents: () => agents,
    createAgentProfile: (input) =>
      Effect.promise(async () => {
        const id = `agent-${agents.length + 1}`;
        const created: AgentSummary = {
          id,
          name: input.name,
          title: "",
          description: input.description,
          notifications: false,
          provider: "codex",
          model: "gpt-5",
          reasoningEffort: "medium",
          threadId: null,
          workspacePath: join(root, "agents", id),
          preview: "",
          updatedAt: null,
          avatarSeed: id,
          avatarHue: null,
          avatarUrl: null,
        };
        await mkdir(created.workspacePath, { recursive: true });
        agents.push(created);
        return created;
      }),
    createRoutine: () => undefined,
    createMemory: () => undefined,
    memoryLimit: () => 50,
    initializeMemorySelection: () => undefined,
    setAvatar: () => Effect.die("The export has no avatars."),
    deleteAgent: () => Effect.die("No agent is deleted in this test."),
    listModels: () => models,
    updateAgent: (input) => {
      updates.push(input);
      if (refuseUpdate) return Effect.fail({ cause: new Error("Claude is off.") });
      const agent = agents.find((candidate) => candidate.id === input.agentId);
      if (!agent) return Effect.die("Unknown agent.");
      Object.assign(agent, {
        ...(input.provider ? { provider: input.provider } : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
      });
      return Effect.succeed({ ...agent });
    },
    channels: { command: () => Effect.die("The export has no group chats.") },
    createChannelMemory: () => undefined,
    createChannelRoutine: () => undefined,
    deleteChannel: () => Effect.die("The export has no group chats."),
  };
}

async function importCloner(model: unknown) {
  const path = join(root, "export.zip");
  const agent = {
    key: "cloner",
    name: "Cloner",
    description: "You copy things.",
    ...(model === undefined ? {} : { model }),
  };
  const manifest = { format: "openbot-agent-import", version: 1, agents: [agent] };
  await writeFile(path, zipSync({ "openbot-import.json": strToU8(JSON.stringify(manifest)) }));
  const service = new AgentImportService(
    boundary(),
    {
      library: () => {
        throw new Error("The export has no skills.");
      },
      installLocal: () => Effect.void,
    },
    () => ({ id: "local", name: "Local" }),
    () => "UTC",
  );
  const preview = await Effect.runPromise(service.stage(path));
  const result = await Effect.runPromise(service.apply({ token: preview.token, keys: ["cloner"], channelKeys: [] }));
  return { preview, result, agent: agents[0] };
}

describe("AgentImportService model", () => {
  it("puts the agent on the model of the export", async () => {
    const { preview, result, agent } = await importCloner({
      provider: "claude",
      model: "claude-opus-5-5",
      reasoningEffort: "high",
    });
    expect(preview.agents[0]?.model).toBe("Claude Opus 5.5");
    expect(preview.warnings).toEqual([]);
    expect(updates).toEqual([
      { agentId: "agent-1", provider: "claude", model: "claude-opus-5-5", reasoningEffort: "high" },
    ]);
    expect(agent).toMatchObject({ provider: "claude", model: "claude-opus-5-5", reasoningEffort: "high" });
    expect(result.agents.map((imported) => imported.model)).toEqual(["claude-opus-5-5"]);
    expect(result.warnings).toEqual([]);
  });

  it("finds the provider from the model id and uses the model's default effort", async () => {
    const { agent, result } = await importCloner({ model: "claude-opus-5-5" });
    expect(updates).toEqual([
      { agentId: "agent-1", provider: "claude", model: "claude-opus-5-5", reasoningEffort: "medium" },
    ]);
    expect(agent).toMatchObject({ provider: "claude", model: "claude-opus-5-5" });
    expect(result.warnings).toEqual([]);
  });

  it("keeps the default model and warns when the model is not available here", async () => {
    models = MODELS.filter((model) => model.provider !== "claude");
    const { preview, result, agent } = await importCloner({ provider: "claude", model: "claude-opus-5-5" });
    expect(preview.agents[0]?.model).toBeUndefined();
    expect(preview.warnings).toEqual([
      sourceText("error.import.modelNotHere", { model: "claude-opus-5-5", name: "Cloner" }),
    ]);
    expect(updates).toEqual([]);
    expect(agent).toMatchObject({ provider: "codex", model: "gpt-5" });
    expect(result.agents).toHaveLength(1);
    expect(result.warnings).toEqual([
      sourceText("error.import.modelMissing", { model: "claude-opus-5-5", name: "Cloner", fallback: "GPT-5" }),
    ]);
    expect(result.warnings[0]).toBe("Model claude-opus-5-5 is not available here; Cloner uses GPT-5.");
  });

  it("keeps the default model and warns when the model cannot be set", async () => {
    refuseUpdate = true;
    const { result, agent } = await importCloner({ provider: "claude", model: "claude-opus-5-5" });
    expect(updates).toHaveLength(1);
    expect(agent).toMatchObject({ provider: "codex", model: "gpt-5" });
    expect(result.agents).toHaveLength(1);
    expect(result.warnings).toEqual([
      sourceText("error.import.modelNotSet", {
        model: "claude-opus-5-5",
        name: "Cloner",
        fallback: "GPT-5",
        reason: "Claude is off.",
      }),
    ]);
  });

  it("uses the model's default effort for an effort the model does not have", async () => {
    const { agent, result } = await importCloner({ provider: "codex", model: "gpt-5", reasoningEffort: "xhigh" });
    expect(updates).toEqual([]);
    expect(agent).toMatchObject({ provider: "codex", model: "gpt-5", reasoningEffort: "medium" });
    expect(result.warnings).toEqual([
      sourceText("error.import.effortNotSupported", {
        name: "Cloner",
        model: "GPT-5",
        effort: "xhigh",
        fallback: "medium",
      }),
    ]);
  });

  it("imports an export without a model on the default model", async () => {
    const { preview, result, agent } = await importCloner(undefined);
    expect(preview.agents[0]?.model).toBeUndefined();
    expect(updates).toEqual([]);
    expect(agent).toMatchObject({ provider: "codex", model: "gpt-5" });
    expect(result.warnings).toEqual([]);
  });

  it("imports the agent on the default model when the model is invalid", async () => {
    const { preview, result, agent } = await importCloner({ provider: 42 });
    expect(preview.warnings).toEqual([sourceText("error.import.modelInvalid", { name: "Cloner" })]);
    expect(updates).toEqual([]);
    expect(agent).toMatchObject({ provider: "codex", model: "gpt-5" });
    expect(result.agents).toHaveLength(1);
  });
});
