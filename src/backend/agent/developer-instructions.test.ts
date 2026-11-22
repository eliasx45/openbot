import { type AgentSummary, DEFAULT_AGENT_DEFAULTS } from "@openbot/contracts/ipc";
import { describe, expect, it } from "vitest";
import { type DeveloperInstructionOptions, developerInstructions } from "./developer-instructions";

// Fork #88: what an agent with Computer Use is told about the user's own Chrome profile.

const agent: AgentSummary = {
  id: "a1b2c3d4-0000-4000-8000-000000000000",
  name: "Tester",
  title: "",
  description: "",
  notifications: false,
  provider: "claude",
  model: "claude-sonnet-4-5",
  reasoningEffort: "medium",
  threadId: null,
  workspacePath: "/tmp/openbot-instructions-test",
  preview: "",
  updatedAt: null,
  avatarSeed: "agent-1",
  avatarHue: null,
  avatarUrl: null,
};

const OFF_RULE =
  "browser_consent_required means that OpenBot cannot use the user's own browser profiles: do not call browser_prepare; say so in one plain sentence and continue in openbot_browser, with request_takeover for a sign-in.";

function instructions(options: DeveloperInstructionOptions): string {
  return developerInstructions(agent, "/tmp/shared", [], "/tmp/automation", DEFAULT_AGENT_DEFAULTS, options);
}

describe("instructions for the user's own Chrome profile", () => {
  it("keeps today's rule while the switch is off", () => {
    const text = instructions({});
    expect(text).toContain(`took the screen from the user. ${OFF_RULE} Select a window by its title and size`);
    expect(text).not.toContain("existing_profile");
    expect(instructions({ computerUseChromeProfile: false })).toBe(text);
  });

  it("tells the agent to attach the exact Chrome window, without asking, while the switch is on", () => {
    const text = instructions({ computerUseChromeProfile: true });
    expect(text).not.toContain(OFF_RULE);
    expect(text).toContain("select the exact Chrome window by its title and size");
    expect(text).toContain(
      'call browser_prepare with the same pid and window_id and strategy {"kind":"existing_profile"}',
    );
    expect(text).toContain("this setting is the user's approval, so do not ask first");
    expect(text).toContain(
      "If browser_prepare refuses with background_unavailable, call it again with delivery_mode foreground",
    );
    expect(text).toContain(`Never click Chrome's "Allow remote debugging?" prompt`);
    expect(text).toContain("When a task does not need the user's own Chrome, use openbot_browser.");
  });

  it("keeps one session for that Chrome, so the approved connection is reused", () => {
    const text = instructions({ computerUseChromeProfile: true });
    expect(text).toContain("Use the session label chrome-a1b2c3d4 on every call for that Chrome");
    expect(text).toContain("do not call end_session for it");
  });

  it("says nothing about Chrome to an agent with Computer Use off", () => {
    const text = developerInstructions(
      { ...agent, computerUse: false },
      "/tmp/shared",
      [],
      "/tmp/automation",
      DEFAULT_AGENT_DEFAULTS,
      { computerUseChromeProfile: true },
    );
    expect(text).not.toContain("existing_profile");
  });
});
