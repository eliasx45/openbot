import type { AgentModelOption } from "@openbot/contracts/ipc";
import { accountModelOptions } from "@openbot/ui/components/provider-model-options";
import { describe, expect, it } from "vitest";

function model(id: string, name: string): AgentModelOption {
  return {
    provider: "antigravity",
    id,
    name,
    description: "",
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: ["medium"],
  };
}

const shared = [
  model("gemini-4-neon", "Gemini 4 Neon"),
  model("gemini-4-argon", "Gemini 4 Argon"),
  model("gemini-pro-orchestrator-g1-pro", "Orchestrator (Argon)"),
  model("claude-opus-5-5", "Claude Opus 5.5"),
];
const extra = [
  model("gemini-4-carbon", "Gemini 4 Carbon"),
  model("gemini-pro-orchestrator", "Orchestrator (Carbon)"),
  model("gemini-pro-orchestrator-argon", "Orchestrator (Argon)"),
];

describe("fork #97: a second account's picker shows only that account's models", () => {
  it("leaves out a shared model that the account does not list, so no name shows twice", () => {
    const shown = accountModelOptions(
      shared,
      { models: extra, missingModels: ["gemini-pro-orchestrator-g1-pro"] },
      null,
    );
    expect(shown.map((entry) => entry.id)).toEqual([
      "gemini-4-neon",
      "gemini-4-argon",
      "claude-opus-5-5",
      "gemini-4-carbon",
      "gemini-pro-orchestrator",
      "gemini-pro-orchestrator-argon",
    ]);
    expect(shown.filter((entry) => entry.name === "Orchestrator (Argon)")).toHaveLength(1);
  });

  it("keeps the model that the agent uses now on this account", () => {
    const shown = accountModelOptions(
      shared,
      { models: extra, missingModels: ["gemini-pro-orchestrator-g1-pro"] },
      "gemini-pro-orchestrator-g1-pro",
    );
    expect(shown.some((entry) => entry.id === "gemini-pro-orchestrator-g1-pro")).toBe(true);
  });

  it("shows the shared list as before for an account with no difference", () => {
    expect(accountModelOptions(shared, undefined, null)).toEqual(shared);
    expect(accountModelOptions(shared, { models: [] }, null)).toEqual(shared);
  });
});
