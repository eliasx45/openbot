import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import {
  CHANNEL_WEBHOOK_DELIVERY_HEADER,
  CHANNEL_WEBHOOK_EVENT,
  CHANNEL_WEBHOOK_SIGNATURE_HEADER,
  CHANNEL_WEBHOOK_TIMESTAMP_HEADER,
  type ChannelWebhookChange,
  type ChannelWebhookPayload,
  type ChannelWebhookSettings,
  channelWebhookBlockedAddress,
  channelWebhookUrlProblem,
} from "@openbot/contracts/fork-channel-webhooks";
import type { ChannelMessage } from "@openbot/contracts/ipc";
import { isBoolean, isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { createOpenBotLogger } from "@openbot/logging";
import { Effect } from "effect";
import type { ForkChannelWebhooks } from "../backend/fork-hub";
import { type PreferenceFileFailure, PreferenceStore } from "./preference-file";
import type { SecretStorageCipher } from "./secret-storage-cipher";
import { signWebhookBody } from "./webhook-security";

export const CHANNEL_WEBHOOKS_FILE = "openbot-channel-webhooks-v1.json";
export const CHANNEL_WEBHOOK_TIMEOUT_MS = 10_000;
export const CHANNEL_WEBHOOK_RETRY_DELAYS_MS = [2_000, 8_000] as const;
export const CHANNEL_WEBHOOK_RATE = { deliveries: 30, windowMs: 60_000 } as const;

const logger = createOpenBotLogger("fork-channel-webhooks");

interface StoredWebhook {
  url: string;
  enabled: boolean;
  secret?: string;
}

interface StoredWebhooks {
  channels: Record<string, StoredWebhook>;
}

export interface ChannelWebhookLogDetail {
  channelId: string;
  target?: string;
  problem?: string;
  status?: number | null;
  error?: string | null;
  attempts?: number;
}

export type ChannelWebhookFetch = (url: string, init: RequestInit) => Promise<Pick<Response, "status">>;
export type ChannelWebhookResolve = (hostname: string) => Promise<readonly string[]>;

export interface ChannelWebhookServiceOptions {
  path: string;
  cipher: Pick<SecretStorageCipher, "encrypt" | "decrypt">;
  fetch?: ChannelWebhookFetch;
  resolve?: ChannelWebhookResolve;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  warn?: (message: string, detail: ChannelWebhookLogDetail) => void;
}

function decodeStored(parsed: unknown): StoredWebhooks | null {
  if (!isDynamicRecord(parsed) || !isDynamicRecord(parsed.channels)) return null;
  const channels: Record<string, StoredWebhook> = {};
  for (const [channelId, value] of Object.entries(parsed.channels)) {
    if (!isDynamicRecord(value) || !isString(value.url) || !isBoolean(value.enabled)) continue;
    channels[channelId] = {
      url: value.url,
      enabled: value.enabled,
      ...(isString(value.secret) ? { secret: value.secret } : {}),
    };
  }
  return { channels };
}

export function channelWebhookPayload(input: {
  channelId: string;
  channelName: string;
  message: ChannelMessage;
  origin: "member" | "routine" | "other";
}): ChannelWebhookPayload & { origin: "member" | "routine" | "other" } {
  const { message } = input;
  return {
    event: CHANNEL_WEBHOOK_EVENT,
    channelId: input.channelId,
    channelName: input.channelName,
    messageId: message.id,
    sequence: message.sequence,
    author: { kind: "agent", id: message.author.id, name: message.author.name },
    text: message.message.text,
    timestamp: message.message.createdAt,
    taskId: message.taskId,
    origin: input.origin,
  };
}

function safeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "invalid";
  }
}

async function defaultResolve(hostname: string): Promise<readonly string[]> {
  const found = await lookup(hostname, { all: true, verbatim: true });
  return found.map((entry) => entry.address);
}

export class ChannelWebhookService implements ForkChannelWebhooks {
  readonly #store: PreferenceStore<StoredWebhooks>;
  readonly #options: ChannelWebhookServiceOptions;
  readonly #sent = new Map<string, number[]>();
  readonly #pending = new Set<Promise<void>>();

  constructor(options: ChannelWebhookServiceOptions) {
    this.#options = options;
    this.#store = new PreferenceStore<StoredWebhooks>({
      path: options.path,
      defaultValue: { channels: {} },
      decode: decodeStored,
    });
  }

  load(): Effect.Effect<void, PreferenceFileFailure> {
    return this.#store.load();
  }

  settings(channelId: string): ChannelWebhookSettings {
    const stored = this.#store.get().channels[channelId];
    return {
      channelId,
      url: stored?.url ?? "",
      enabled: stored?.enabled ?? false,
      hasSecret: stored?.secret !== undefined,
    };
  }

  set(change: ChannelWebhookChange): Effect.Effect<ChannelWebhookSettings, PreferenceFileFailure> {
    return Effect.gen({ self: this }, function* () {
      const current = this.#store.get();
      const previous = current.channels[change.channelId];
      const channels = { ...current.channels };
      const secret =
        change.secret === undefined
          ? previous?.secret
          : change.secret === null
            ? undefined
            : this.#options.cipher.encrypt(change.secret).toString("base64");
      if (change.url === "" && secret === undefined) delete channels[change.channelId];
      else
        channels[change.channelId] = {
          url: change.url,
          enabled: change.enabled && change.url !== "",
          ...(secret === undefined ? {} : { secret }),
        };
      yield* this.#store.set({ channels });
      return this.settings(change.channelId);
    });
  }

  remove(channelId: string): Effect.Effect<void, PreferenceFileFailure> {
    return Effect.gen({ self: this }, function* () {
      const current = this.#store.get();
      if (!current.channels[channelId]) return;
      const channels = { ...current.channels };
      delete channels[channelId];
      yield* this.#store.set({ channels });
    });
  }

  turnAnswered(input: Parameters<ForkChannelWebhooks["turnAnswered"]>[0]): void {
    const stored = this.#store.get().channels[input.channelId];
    if (!stored?.enabled || !stored.url) return;
    if (input.message.author.kind !== "agent") return;
    if (!this.#takeSlot(input.channelId)) {
      this.#warn("A channel webhook was skipped: too many deliveries in a minute.", {
        channelId: input.channelId,
        target: safeOrigin(stored.url),
      });
      return;
    }
    const body = JSON.stringify(channelWebhookPayload(input));
    const delivery = this.#deliver(input.channelId, stored, body).catch((error: unknown) => {
      this.#warn("A channel webhook failed.", {
        channelId: input.channelId,
        target: safeOrigin(stored.url),
        error: error instanceof Error ? error.name : typeof error,
      });
    });
    this.#pending.add(delivery);
    void delivery.finally(() => this.#pending.delete(delivery));
  }

  idle(): Promise<void> {
    return Promise.all([...this.#pending]).then(() => undefined);
  }

  #takeSlot(channelId: string): boolean {
    const now = (this.#options.now ?? Date.now)();
    const recent = (this.#sent.get(channelId) ?? []).filter((at) => now - at < CHANNEL_WEBHOOK_RATE.windowMs);
    if (recent.length >= CHANNEL_WEBHOOK_RATE.deliveries) {
      this.#sent.set(channelId, recent);
      return false;
    }
    recent.push(now);
    this.#sent.set(channelId, recent);
    return true;
  }

  #warn(message: string, detail: ChannelWebhookLogDetail): void {
    if (this.#options.warn) this.#options.warn(message, detail);
    else logger.warn(message, detail);
  }

  async #deliver(channelId: string, stored: StoredWebhook, body: string): Promise<void> {
    const problem = channelWebhookUrlProblem(stored.url);
    if (problem) {
      this.#warn("A channel webhook address is not allowed.", { channelId, problem });
      return;
    }
    const { hostname } = new URL(stored.url);
    const addresses = await (this.#options.resolve ?? defaultResolve)(hostname.replace(/^\[|\]$/g, ""));
    if (addresses.length === 0 || addresses.some(channelWebhookBlockedAddress)) {
      this.#warn("A channel webhook address resolves to a blocked network.", {
        channelId,
        target: safeOrigin(stored.url),
      });
      return;
    }
    const secret = stored.secret ? this.#options.cipher.decrypt(Buffer.from(stored.secret, "base64")) : null;
    const deliveryId = randomUUID();
    const send = this.#options.fetch ?? fetch;
    const sleep = this.#options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    for (let attempt = 0; ; attempt++) {
      const timestamp = String(Math.floor((this.#options.now ?? Date.now)() / 1000));
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "User-Agent": "OpenBot-Channel-Webhook",
        [CHANNEL_WEBHOOK_TIMESTAMP_HEADER]: timestamp,
        [CHANNEL_WEBHOOK_DELIVERY_HEADER]: deliveryId,
      };
      if (secret)
        headers[CHANNEL_WEBHOOK_SIGNATURE_HEADER] = signWebhookBody(secret, timestamp, deliveryId, Buffer.from(body));
      let status: number | null = null;
      let failure: string | null = null;
      try {
        status = (
          await send(stored.url, {
            method: "POST",
            headers,
            body,
            redirect: "manual",
            signal: AbortSignal.timeout(CHANNEL_WEBHOOK_TIMEOUT_MS),
          })
        ).status;
      } catch (error) {
        failure = error instanceof Error ? error.name : typeof error;
      }
      if (status !== null && status >= 200 && status < 300) return;
      const retry = status === null || status === 429 || status >= 500;
      const delay = CHANNEL_WEBHOOK_RETRY_DELAYS_MS[attempt];
      if (!retry || delay === undefined) {
        this.#warn("A channel webhook was not accepted.", {
          channelId,
          target: safeOrigin(stored.url),
          status,
          error: failure,
          attempts: attempt + 1,
        });
        return;
      }
      await sleep(delay);
    }
  }
}

export const forkChannelWebhooks: { current: ChannelWebhookService | null } = { current: null };
