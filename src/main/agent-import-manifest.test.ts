import { sourceText } from "@openbot/i18n/source";
import { describe, expect, it } from "vitest";
import { decodeImportManifest } from "./agent-import-manifest";

function decode(model?: unknown) {
  const agent = {
    key: "cloner",
    name: "Cloner",
    description: "You copy things.",
    ...(model === undefined ? {} : { model }),
  };
  const text = JSON.stringify({ format: "openbot-agent-import", version: 1, agents: [agent] });
  return decodeImportManifest(new TextEncoder().encode(text), 50);
}

describe("decodeImportManifest model", () => {
  it("reads the provider, model and reasoning effort of an agent", () => {
    const { manifest, warnings } = decode({ provider: "claude", model: "claude-opus-5-5", reasoningEffort: "high" });
    expect(manifest.agents[0]?.model).toEqual({
      provider: "claude",
      model: "claude-opus-5-5",
      reasoningEffort: "high",
    });
    expect(warnings).toEqual([]);
  });

  it("reads a model without a provider or effort", () => {
    const { manifest, warnings } = decode({ model: "claude-opus-5-5" });
    expect(manifest.agents[0]?.model).toEqual({ provider: null, model: "claude-opus-5-5", reasoningEffort: null });
    expect(warnings).toEqual([]);
  });

  it("keeps an export without a model as before", () => {
    expect(decode().manifest.agents[0]?.model).toBeNull();
    expect(decode(null).manifest.agents[0]?.model).toBeNull();
    expect(decode().warnings).toEqual([]);
  });

  it.each([
    ["a string", "claude-opus-5-5"],
    ["no model id", { provider: "claude" }],
    ["an unsafe model id", { model: "../opus" }],
    ["an unknown provider", { provider: "skynet", model: "claude-opus-5-5" }],
  ])("imports the agent on the default model when the model is %s", (_, model) => {
    const { manifest, warnings } = decode(model);
    expect(manifest.agents[0]?.name).toBe("Cloner");
    expect(manifest.agents[0]?.model).toBeNull();
    expect(warnings).toEqual([sourceText("error.import.modelInvalid", { name: "Cloner" })]);
  });

  it("drops only an invalid reasoning effort", () => {
    const { manifest, warnings } = decode({ provider: "claude", model: "claude-opus-5-5", reasoningEffort: "turbo" });
    expect(manifest.agents[0]?.model).toEqual({ provider: "claude", model: "claude-opus-5-5", reasoningEffort: null });
    expect(warnings).toEqual([sourceText("error.import.effortInvalid", { name: "Cloner" })]);
  });
});
