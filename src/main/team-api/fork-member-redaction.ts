import { AGENT_PROVIDERS, PROVIDER_ACCOUNT_STATES } from "@openbot/contracts/ipc";
import type { TeamProtocolV1JsonObject, TeamProtocolV1JsonValue } from "@openbot/contracts/team-protocol/v1";

// Fork (docs/fork/FEATURES.md #107): a member who cannot administer the server does not see the host's
// provider accounts: the email of each sign-in (`auth`, provider rows) and the name and email of each
// provider account. Team member emails are not touched.

const PROVIDER_IDS: ReadonlySet<string> = new Set(AGENT_PROVIDERS);
// `AgentAuthState` kinds: the provider ids, and "chatgpt" for Codex.
const AUTH_KINDS: ReadonlySet<string> = new Set([...AGENT_PROVIDERS, "chatgpt"]);
const ACCOUNT_STATES: ReadonlySet<string> = new Set(PROVIDER_ACCOUNT_STATES);

function providerIdentity(value: TeamProtocolV1JsonObject): "email" | "account" | null {
  if (!("email" in value)) return null;
  if (typeof value.kind === "string" && AUTH_KINDS.has(value.kind)) return "email";
  if (typeof value.id === "string" && PROVIDER_IDS.has(value.id) && typeof value.state === "string") return "email";
  if (typeof value.state === "string" && ACCOUNT_STATES.has(value.state) && "label" in value) return "account";
  return null;
}

function redact(value: TeamProtocolV1JsonValue): TeamProtocolV1JsonValue {
  if (Array.isArray(value)) return value.map(redact);
  if (value === null || typeof value !== "object") return value;
  const result: TeamProtocolV1JsonObject = {};
  for (const [key, child] of Object.entries(value)) result[key] = redact(child);
  const identity = providerIdentity(value);
  if (identity !== null && typeof result.email === "string") result.email = null;
  if (identity === "account" && typeof result.label === "string") result.label = null;
  return result;
}

/** The same JSON with provider sign-in identities set to null. */
export function forkMemberProviderView(value: unknown): TeamProtocolV1JsonValue {
  const json: TeamProtocolV1JsonValue = JSON.parse(JSON.stringify(value) ?? "null");
  return redact(json);
}
