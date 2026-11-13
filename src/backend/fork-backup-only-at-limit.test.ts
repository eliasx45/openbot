// @vitest-environment node
// Fork (docs/fork/FEATURES.md #81, "Backup models switch only at a usage limit"): an agent with backup
// models moves to one only when its model hits a usage limit. A network drop, a timeout, an outage, a
// short rate limit, a billing or sign-in error and a turn with no answer fail as with no backup. The
// whole turn path (a real agent service, a stand-in Claude CLI) is checked by
// `bun scripts/backup-model-failover-e2e.ts`.

import { classifyFailure } from "@openbot/telemetry";
import { describe, expect, it } from "vitest";
import { isUsageLimitDiagnostic } from "./agent/provider-diagnostics";
import { forkSwitchesToBackup, forkUsageLimitCause } from "./agent/turn-lifecycle";

/** Texts that providers wrote, with the cause each must read as. */
const FAILURES: [string, string][] = [
  ["API Error: Connection dropped (ECONNRESET). Check those or switch networks, then try again.", "network"],
  ["fetch failed", "network"],
  ["Request timed out", "timeout"],
  [
    'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
    "provider_unavailable",
  ],
  ["API Error: 500 Internal server error", "provider_unavailable"],
  [
    'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed the rate limit for your organization of 50,000 input tokens per minute."}}',
    "rate_limit",
  ],
  ["429 Too Many Requests", "rate_limit"],
  ["402 Payment Required: insufficient credits", "billing"],
  ["API Error: 401 authentication_error: invalid x-api-key", "authentication"],
  ["The model returned an empty response.", "empty_answer"],
  // Plan limits: also when the text names a 429 or "too many requests".
  ["You've hit your session limit · resets 8:40pm", "usage_limit"],
  ['429: {"type":"GoUsageLimitError","message":"Go usage limit exceeded"}', "usage_limit"],
  ["429 Too Many Requests: You've hit your usage limit. Try again at 10:34 AM.", "usage_limit"],
  ["Usage limit reached for 5 hour. Your limit will reset at 2026-11-02 17:37:38", "usage_limit"],
  ["subscription:free-usage-exhausted: You've used all the included free usage for model grok", "usage_limit"],
];

describe("backup models switch only at a usage limit", () => {
  it("reads each provider text as its cause", () => {
    for (const [text, cause] of FAILURES) expect([text, classifyFailure(text)]).toEqual([text, cause]);
  });

  it("switches for a usage limit and for nothing else", () => {
    expect(forkSwitchesToBackup("usage_limit")).toBe(true);
    for (const cause of [
      "network",
      "timeout",
      "provider_unavailable",
      "rate_limit",
      "billing",
      "authentication",
      "empty_answer",
    ] as const)
      expect([cause, forkSwitchesToBackup(cause)]).toEqual([cause, false]);
  });

  it("a network error with backup models listed does not switch", () => {
    const drop = "API Error: Connection dropped (ECONNRESET). Check those or switch networks, then try again.";
    expect(isUsageLimitDiagnostic(drop)).toBe(false);
    expect(forkSwitchesToBackup(classifyFailure(drop))).toBe(false);
  });

  it("a spent quota that the gate does not hold switches; a spent balance or a per-minute quota does not", () => {
    // Gemini's spent daily quota is a 429 RESOURCE_EXHAUSTED: the text reads as a rate limit, but it is a usage limit.
    const geminiDaily =
      "RESOURCE_EXHAUSTED: You have exhausted your daily quota on this model. Your limit will reset in 2 days, 18 hours.";
    expect(isUsageLimitDiagnostic(geminiDaily)).toBe(true);
    expect(forkUsageLimitCause(classifyFailure(geminiDaily), geminiDaily)).toBe("usage_limit");
    expect(forkSwitchesToBackup(forkUsageLimitCause(classifyFailure(geminiDaily), geminiDaily))).toBe(true);

    const perMinute =
      "RESOURCE_EXHAUSTED: Quota exceeded for quota metric 'Generate Content API requests per minute' of service generativelanguage.googleapis.com.";
    expect(isUsageLimitDiagnostic(perMinute)).toBe(true);
    expect(forkUsageLimitCause(classifyFailure(perMinute), perMinute)).toBe("rate_limit");

    const balance = "Your credit balance is too low to access the Anthropic API.";
    expect(isUsageLimitDiagnostic(balance)).toBe(true);
    expect(forkUsageLimitCause(classifyFailure(balance), balance)).toBe("billing");

    const openAiQuota = "You exceeded your current quota, please check your plan and billing details.";
    expect(forkUsageLimitCause(classifyFailure(openAiQuota), openAiQuota)).toBe("billing");

    const antigravity = "Usage Limit Reached. You have reached your current quota for this period.";
    expect(forkUsageLimitCause(classifyFailure(antigravity), antigravity)).toBe("usage_limit");
  });
});
