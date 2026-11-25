// @vitest-environment node
// Fork (docs/fork/FEATURES.md #107): the outbound channel webhook signs, times out, retries a bounded
// number of times, refuses unsafe addresses and never shows or logs its secret.

import { createHmac } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHANNEL_WEBHOOK_SIGNATURE_HEADER,
  channelWebhookUrlProblem,
  parseChannelWebhookChange,
} from "@openbot/contracts/fork-channel-webhooks";
import type { ChannelMessage } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  CHANNEL_WEBHOOK_RATE,
  CHANNEL_WEBHOOK_RETRY_DELAYS_MS,
  CHANNEL_WEBHOOK_TIMEOUT_MS,
  type ChannelWebhookLogDetail,
  ChannelWebhookService,
} from "./fork-channel-webhooks";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const SECRET = "partner-signing-secret-123";

function answer(author: ChannelMessage["author"]["kind"] = "agent"): ChannelMessage {
  return {
    id: "message-1",
    channelId: "channel-1",
    sequence: 42,
    author: { kind: author, id: "traf", name: "Traf" },
    taskId: "task-1",
    superseded: false,
    message: {
      id: "item-1",
      author: "assistant",
      text: "Here is the cut.",
      createdAt: "2026-11-25T10:00:00.000Z",
      status: "completed",
    },
  };
}

async function service(
  options: {
    fetch?: ConstructorParameters<typeof ChannelWebhookService>[0]["fetch"];
    resolve?: ConstructorParameters<typeof ChannelWebhookService>[0]["resolve"];
    now?: () => number;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "openbot-channel-webhooks-"));
  roots.push(root);
  const warnings: Array<{ message: string; detail: ChannelWebhookLogDetail }> = [];
  const sleeps: number[] = [];
  const path = join(root, "openbot-channel-webhooks-v1.json");
  const webhooks = new ChannelWebhookService({
    path,
    cipher: {
      encrypt: (value) => Buffer.from(`sealed:${Buffer.from(value).toString("base64")}`),
      decrypt: (value) => Buffer.from(value.toString().slice("sealed:".length), "base64").toString(),
    },
    resolve: options.resolve ?? (async () => ["93.184.216.34"]),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    warn: (message, detail) => warnings.push({ message, detail }),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  await Effect.runPromise(webhooks.load());
  return { webhooks, warnings, sleeps, path };
}

describe("fork #107 outbound channel webhook", () => {
  it("posts the agent's answer once, signed with HMAC-SHA256, without showing the secret", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const { webhooks, warnings, path } = await service({
      fetch: async (url, init) => {
        calls.push({ url, init });
        return { status: 204 };
      },
    });
    const saved = await Effect.runPromise(
      webhooks.set({ channelId: "channel-1", url: "https://bots.example.com/in", enabled: true, secret: SECRET }),
    );
    expect(saved).toEqual({
      channelId: "channel-1",
      url: "https://bots.example.com/in",
      enabled: true,
      hasSecret: true,
    });
    expect(await readFile(path, "utf8")).not.toContain(SECRET);
    webhooks.turnAnswered({ channelId: "channel-1", channelName: "agency", message: answer(), origin: "member" });
    await webhooks.idle();
    expect(calls).toHaveLength(1);
    const [call] = calls;
    const headers = new Headers(call?.init.headers);
    const body = String(call?.init.body);
    expect(JSON.parse(body)).toEqual({
      event: "channel.message",
      channelId: "channel-1",
      channelName: "agency",
      messageId: "message-1",
      sequence: 42,
      author: { kind: "agent", id: "traf", name: "Traf" },
      text: "Here is the cut.",
      timestamp: "2026-11-25T10:00:00.000Z",
      taskId: "task-1",
      origin: "member",
    });
    const timestamp = headers.get("X-OpenBot-Timestamp");
    const delivery = headers.get("X-OpenBot-Delivery");
    const expected = `sha256=${createHmac("sha256", SECRET).update(`${timestamp}.${delivery}.`).update(body).digest("hex")}`;
    expect(headers.get(CHANNEL_WEBHOOK_SIGNATURE_HEADER)).toBe(expected);
    expect(call?.init.redirect).toBe("manual");
    expect(call?.init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.stringify(warnings)).not.toContain(SECRET);
  });

  it("never posts a person's or the coordinator's message, so its own inbound post cannot echo", async () => {
    const calls: string[] = [];
    const { webhooks } = await service({
      fetch: async (url) => {
        calls.push(url);
        return { status: 200 };
      },
    });
    await Effect.runPromise(
      webhooks.set({ channelId: "channel-1", url: "https://bots.example.com/in", enabled: true }),
    );
    webhooks.turnAnswered({
      channelId: "channel-1",
      channelName: "agency",
      message: answer("member"),
      origin: "member",
    });
    webhooks.turnAnswered({
      channelId: "channel-1",
      channelName: "agency",
      message: answer("coordinator"),
      origin: "member",
    });
    webhooks.turnAnswered({ channelId: "channel-2", channelName: "other", message: answer(), origin: "member" });
    await webhooks.idle();
    expect(calls).toEqual([]);
  });

  it("caps deliveries per channel per minute so two bots cannot storm each other", async () => {
    let now = 1_000_000;
    let posts = 0;
    const { webhooks, warnings } = await service({
      now: () => now,
      fetch: async () => {
        posts++;
        return { status: 200 };
      },
    });
    await Effect.runPromise(
      webhooks.set({ channelId: "channel-1", url: "https://bots.example.com/in", enabled: true }),
    );
    for (let index = 0; index < CHANNEL_WEBHOOK_RATE.deliveries + 5; index++)
      webhooks.turnAnswered({ channelId: "channel-1", channelName: "agency", message: answer(), origin: "routine" });
    await webhooks.idle();
    expect(posts).toBe(CHANNEL_WEBHOOK_RATE.deliveries);
    expect(warnings.filter((warning) => warning.message.includes("too many"))).toHaveLength(5);
    now += CHANNEL_WEBHOOK_RATE.windowMs;
    webhooks.turnAnswered({ channelId: "channel-1", channelName: "agency", message: answer(), origin: "routine" });
    await webhooks.idle();
    expect(posts).toBe(CHANNEL_WEBHOOK_RATE.deliveries + 1);
  });

  it("retries a timeout or a server error a bounded number of times, then logs without the address path", async () => {
    let attempts = 0;
    const { webhooks, warnings, sleeps } = await service({
      fetch: async () => {
        attempts++;
        if (attempts === 1) throw new DOMException("The operation timed out.", "TimeoutError");
        return { status: 503 };
      },
    });
    await Effect.runPromise(
      webhooks.set({ channelId: "channel-1", url: "https://bots.example.com/in/token-abc", enabled: true }),
    );
    webhooks.turnAnswered({ channelId: "channel-1", channelName: "agency", message: answer(), origin: "member" });
    await webhooks.idle();
    expect(attempts).toBe(CHANNEL_WEBHOOK_RETRY_DELAYS_MS.length + 1);
    expect(sleeps).toEqual([...CHANNEL_WEBHOOK_RETRY_DELAYS_MS]);
    expect(CHANNEL_WEBHOOK_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
    expect(warnings.at(-1)?.detail).toMatchObject({ target: "https://bots.example.com", status: 503, attempts: 3 });
    expect(JSON.stringify(warnings)).not.toContain("token-abc");
  });

  it("does not retry a refusal (4xx)", async () => {
    let attempts = 0;
    const { webhooks } = await service({
      fetch: async () => {
        attempts++;
        return { status: 401 };
      },
    });
    await Effect.runPromise(
      webhooks.set({ channelId: "channel-1", url: "https://bots.example.com/in", enabled: true }),
    );
    webhooks.turnAnswered({ channelId: "channel-1", channelName: "agency", message: answer(), origin: "member" });
    await webhooks.idle();
    expect(attempts).toBe(1);
  });

  it("refuses an address that resolves to a metadata or link-local network", async () => {
    let posts = 0;
    const { webhooks, warnings } = await service({
      resolve: async () => ["169.254.169.254"],
      fetch: async () => {
        posts++;
        return { status: 200 };
      },
    });
    await Effect.runPromise(
      webhooks.set({ channelId: "channel-1", url: "https://rebind.example.com/in", enabled: true }),
    );
    webhooks.turnAnswered({ channelId: "channel-1", channelName: "agency", message: answer(), origin: "member" });
    await webhooks.idle();
    expect(posts).toBe(0);
    expect(warnings.at(-1)?.message).toContain("blocked network");
  });

  it("validates webhook addresses as the inbound webhooks do", () => {
    expect(channelWebhookUrlProblem("https://bots.example.com/in")).toBeNull();
    expect(channelWebhookUrlProblem("http://localhost:8787/in")).toBeNull();
    expect(channelWebhookUrlProblem("http://100.101.102.103/in")).toBeNull();
    expect(channelWebhookUrlProblem("http://agency.tail1234.ts.net/in")).toBeNull();
    expect(channelWebhookUrlProblem("http://bots.example.com/in")).toBe("plain-http");
    expect(channelWebhookUrlProblem("ftp://bots.example.com/in")).toBe("scheme");
    expect(channelWebhookUrlProblem("https://user:pass@bots.example.com/in")).toBe("credentials");
    expect(channelWebhookUrlProblem("http://169.254.169.254/latest")).toBe("blocked-host");
    expect(channelWebhookUrlProblem("https://metadata.google.internal/")).toBe("blocked-host");
    expect(channelWebhookUrlProblem("https://[fe80::1]/")).toBe("blocked-host");
    expect(channelWebhookUrlProblem("https://100.100.100.100/")).toBe("blocked-host");
    expect(channelWebhookUrlProblem("not a url")).toBe("invalid");
    expect(() =>
      parseChannelWebhookChange({ channelId: "c", url: "http://169.254.169.254/", enabled: true }),
    ).toThrow();
    expect(parseChannelWebhookChange({ channelId: "c", url: "", enabled: false, secret: "" })).toEqual({
      channelId: "c",
      url: "",
      enabled: false,
      secret: null,
    });
  });

  it("keeps the secret when a change leaves it out and clears it on null", async () => {
    const { webhooks } = await service();
    await Effect.runPromise(
      webhooks.set({ channelId: "channel-1", url: "https://bots.example.com/in", enabled: true, secret: SECRET }),
    );
    const kept = await Effect.runPromise(
      webhooks.set({ channelId: "channel-1", url: "https://bots.example.com/new", enabled: false }),
    );
    expect(kept).toMatchObject({ hasSecret: true, enabled: false });
    const cleared = await Effect.runPromise(
      webhooks.set({ channelId: "channel-1", url: "https://bots.example.com/new", enabled: true, secret: null }),
    );
    expect(cleared.hasSecret).toBe(false);
  });
});
