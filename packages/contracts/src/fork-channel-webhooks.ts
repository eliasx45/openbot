import { isBoolean, isDynamicRecord, isString } from "./runtime-values";
import {
  type AdminDecoder,
  adminRoute,
  boolean,
  fields,
  identifier,
  nullable,
  type OptionalRouteCodec,
  string,
} from "./team-protocol/admin-wire";

export const CHANNEL_WEBHOOK_ROUTES = {
  read: "/v1/channels/webhook",
  set: "/v1/channels/webhook/set",
} as const;

export const CHANNEL_WEBHOOK_URL_LIMIT = 2048;
export const CHANNEL_WEBHOOK_SECRET_LIMIT = 512;
export const CHANNEL_WEBHOOK_SIGNATURE_HEADER = "X-OpenBot-Signature-256";
export const CHANNEL_WEBHOOK_TIMESTAMP_HEADER = "X-OpenBot-Timestamp";
export const CHANNEL_WEBHOOK_DELIVERY_HEADER = "X-OpenBot-Delivery";
export const CHANNEL_WEBHOOK_EVENT = "channel.message";

export interface ChannelWebhookSettings {
  channelId: string;
  url: string;
  enabled: boolean;
  hasSecret: boolean;
}

export interface ChannelWebhookChange {
  channelId: string;
  url: string;
  enabled: boolean;
  secret?: string | null;
}

export interface ChannelWebhookPayload {
  event: typeof CHANNEL_WEBHOOK_EVENT;
  channelId: string;
  channelName: string;
  messageId: string;
  sequence: number;
  author: { kind: "agent"; id: string; name: string };
  text: string;
  timestamp: string;
  taskId: string | null;
}

export type ChannelWebhookUrlProblem = "invalid" | "scheme" | "credentials" | "blocked-host" | "plain-http";

const METADATA_HOSTS: ReadonlySet<string> = new Set([
  "metadata",
  "metadata.google.internal",
  "metadata.goog",
  "instance-data",
  "instance-data.ec2.internal",
]);

function ipv4Parts(host: string): number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part))) return null;
  const numbers = parts.map(Number);
  return numbers.every((value) => value <= 255) ? numbers : null;
}

function bareHost(hostname: string): string {
  const lower = hostname.toLowerCase().replace(/\.$/, "");
  return lower.startsWith("[") && lower.endsWith("]") ? lower.slice(1, -1) : lower;
}

export function channelWebhookBlockedAddress(address: string): boolean {
  const host = bareHost(address);
  const v4 = ipv4Parts(host.startsWith("::ffff:") ? host.slice(7) : host);
  if (v4) {
    const [a = 0, b = 0] = v4;
    return a === 0 || (a === 169 && b === 254) || (a === 100 && b === 100) || a >= 224;
  }
  if (!host.includes(":")) return false;
  return host === "::" || /^fe[89ab]/.test(host) || host.startsWith("ff") || host === "fd00:ec2::254";
}

function loopbackOrTailnet(host: string): boolean {
  if (host === "localhost" || host === "::1" || host.endsWith(".ts.net")) return true;
  const v4 = ipv4Parts(host);
  if (!v4) return false;
  const [a = 0, b = 0] = v4;
  return a === 127 || (a === 100 && b >= 64 && b <= 127);
}

export function channelWebhookUrlProblem(value: string): ChannelWebhookUrlProblem | null {
  if (value.length === 0 || value.length > CHANNEL_WEBHOOK_URL_LIMIT) return "invalid";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "invalid";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return "scheme";
  if (url.username || url.password) return "credentials";
  const host = bareHost(url.hostname);
  if (!host || METADATA_HOSTS.has(host) || channelWebhookBlockedAddress(host)) return "blocked-host";
  if (url.protocol === "http:" && !loopbackOrTailnet(host)) return "plain-http";
  return null;
}

export function decodeChannelWebhookSettings(value: unknown): ChannelWebhookSettings {
  if (
    !isDynamicRecord(value) ||
    !isString(value.channelId) ||
    !isString(value.url) ||
    value.url.length > CHANNEL_WEBHOOK_URL_LIMIT ||
    !isBoolean(value.enabled) ||
    !isBoolean(value.hasSecret)
  )
    throw new Error("Invalid channel webhook settings.");
  return { channelId: value.channelId, url: value.url, enabled: value.enabled, hasSecret: value.hasSecret };
}

export function parseChannelWebhookRead(value: unknown): { channelId: string } {
  if (!isDynamicRecord(value) || !isString(value.channelId) || !value.channelId || value.channelId.length > 128)
    throw new Error("Invalid channel webhook request.");
  return { channelId: value.channelId };
}

export function parseChannelWebhookChange(value: unknown): ChannelWebhookChange {
  if (
    !isDynamicRecord(value) ||
    !isString(value.channelId) ||
    !value.channelId ||
    value.channelId.length > 128 ||
    !isString(value.url) ||
    value.url.length > CHANNEL_WEBHOOK_URL_LIMIT ||
    !isBoolean(value.enabled) ||
    (value.secret !== undefined &&
      value.secret !== null &&
      (!isString(value.secret) || value.secret.length > CHANNEL_WEBHOOK_SECRET_LIMIT))
  )
    throw new Error("Invalid channel webhook change.");
  const url = value.url.trim();
  if (url !== "" && channelWebhookUrlProblem(url) !== null) throw new Error("Invalid channel webhook address.");
  if (url === "" && value.enabled) throw new Error("Invalid channel webhook address.");
  return {
    channelId: value.channelId,
    url,
    enabled: value.enabled,
    ...(value.secret === undefined
      ? {}
      : { secret: value.secret === null || value.secret === "" ? null : value.secret }),
  };
}

const settingsWire = fields({
  channelId: identifier,
  url: string(CHANNEL_WEBHOOK_URL_LIMIT),
  enabled: boolean,
  hasSecret: boolean,
});
const readWire = fields({ channelId: identifier });
const changeWire: AdminDecoder = fields(
  { channelId: identifier, url: string(CHANNEL_WEBHOOK_URL_LIMIT), enabled: boolean },
  { secret: nullable(string(CHANNEL_WEBHOOK_SECRET_LIMIT)) },
);

export const CHANNEL_WEBHOOK_CODECS: ReadonlyMap<string, OptionalRouteCodec> = new Map([
  [CHANNEL_WEBHOOK_ROUTES.read, adminRoute(readWire, settingsWire)],
  [CHANNEL_WEBHOOK_ROUTES.set, adminRoute(changeWire, settingsWire)],
]);
