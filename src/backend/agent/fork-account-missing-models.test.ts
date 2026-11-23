import type { AgentModelOption, ProviderAccountStatus } from "@openbot/contracts/ipc";
import { describe, expect, it } from "vitest";
import { withAccountModelDifference } from "./fork-account-missing-models";

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

const firstAccount = [
  model("gemini-4-neon", "Gemini 4 Neon"),
  model("gemini-4-argon", "Gemini 4 Argon"),
  model("gemini-pro-orchestrator-g1-pro", "Orchestrator (Argon)"),
  model("claude-opus-5-5", "Claude Opus 5.5"),
];
const secondAccount = [
  model("gemini-4-neon", "Gemini 4 Neon"),
  model("gemini-4-carbon", "Gemini 4 Carbon"),
  model("gemini-4-argon", "Gemini 4 Argon"),
  model("gemini-pro-orchestrator", "Orchestrator (Carbon)"),
  model("gemini-pro-orchestrator-argon", "Orchestrator (Argon)"),
  model("claude-opus-5-5", "Claude Opus 5.5"),
];
const account = (models?: AgentModelOption[]): ProviderAccountStatus => ({
  id: "add7140b9ec5fa013",
  label: null,
  email: "second@example.com",
  state: "connected",
  message: null,
  ...(models ? { models } : {}),
});

describe("fork #97: a second account's status names the shared models that it does not list", () => {
  it("sends the account's own models and the shared models that it does not list", () => {
    const status = withAccountModelDifference(account(secondAccount), firstAccount);
    expect(status.models?.map((entry) => entry.id)).toEqual([
      "gemini-4-carbon",
      "gemini-pro-orchestrator",
      "gemini-pro-orchestrator-argon",
    ]);
    expect(status.missingModels).toEqual(["gemini-pro-orchestrator-g1-pro"]);
  });

  it("leaves the status alone while the account's models are not read", () => {
    expect(withAccountModelDifference(account(), firstAccount)).toEqual(account());
    expect(withAccountModelDifference(account([]), firstAccount).missingModels).toBeUndefined();
  });

  it("names no missing model when the account lists every shared model", () => {
    const status = withAccountModelDifference(account([...firstAccount, model("extra", "Extra")]), firstAccount);
    expect(status.missingModels).toBeUndefined();
    expect(status.models?.map((entry) => entry.id)).toEqual(["extra"]);
  });
});
