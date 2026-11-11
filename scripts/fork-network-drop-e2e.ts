#!/usr/bin/env bun
/**
 * Fork (docs/fork/FEATURES.md #69, "Agents ride out a network drop"): drops a real Claude CLI's
 * connection and shows how long it keeps retrying. A local proxy resets every connection (ECONNRESET,
 * as on 11 Nov 2026) for `--drop` seconds, then forwards to api.anthropic.com. The CLI runs one tiny
 * turn (`-p`, haiku) through it, with and without OpenBot's `CLAUDE_CODE_MAX_RETRIES`.
 *
 *   bun scripts/fork-network-drop-e2e.ts [--drop 300] [--retries 15] [--cli <path>]
 *
 * Prints each retry the CLI reports and whether the turn answered. Costs one haiku request per run.
 */
import { spawn } from "node:child_process";
import { connect, createServer, type Socket } from "node:net";
import { parseArgs } from "node:util";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";

const { values } = parseArgs({
  options: {
    drop: { type: "string", default: "300" },
    retries: { type: "string" },
    cli: { type: "string", default: "node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude" },
  },
});
const dropMs = Number(values.drop) * 1000;
const say = (line: string) => process.stdout.write(`${line}\n`);

// The forwarder: plain HTTP in, HTTPS to Anthropic out, streamed both ways.
const forward = Bun.serve({
  port: 0,
  idleTimeout: 255,
  async fetch(request) {
    const url = new URL(request.url);
    const headers = new Headers(request.headers);
    headers.delete("host");
    headers.delete("accept-encoding");
    const upstream = await fetch(`https://api.anthropic.com${url.pathname}${url.search}`, {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer(),
    });
    const out = new Headers(upstream.headers);
    out.delete("content-encoding");
    out.delete("content-length");
    return new Response(upstream.body, { status: upstream.status, headers: out });
  },
});

const started = Date.now();
let resets = 0;
const front = createServer((socket: Socket) => {
  if (Date.now() - started < dropMs) {
    resets++;
    socket.resetAndDestroy();
    return;
  }
  const back = connect(forward.port ?? 0, "127.0.0.1");
  socket.pipe(back).pipe(socket);
  socket.on("error", () => back.destroy());
  back.on("error", () => socket.destroy());
});
await new Promise<void>((resolve) => front.listen(0, "127.0.0.1", resolve));
const address = front.address();
const port = typeof address === "object" && address !== null ? address.port : 0;

const env: NodeJS.ProcessEnv = { ...process.env };
env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
delete env.CLAUDE_CODE_MAX_RETRIES;
if (values.retries) env.CLAUDE_CODE_MAX_RETRIES = values.retries;
const t = () => `${((Date.now() - started) / 1000).toFixed(0)}s`;
say(`drop ${values.drop}s · CLAUDE_CODE_MAX_RETRIES=${values.retries ?? "(unset: CLI default)"} · proxy :${port}`);

const child = spawn(
  values.cli,
  ["-p", "Reply with the single word: ok", "--model", "haiku", "--output-format", "stream-json", "--verbose"],
  { env, stdio: ["ignore", "pipe", "pipe"] },
);
let buffer = "";
const state: { answer: string | null; failed: string | null; lastRetry: number } = {
  answer: null,
  failed: null,
  lastRetry: 0,
};
child.stdout.on("data", (chunk: Buffer) => {
  buffer += chunk.toString();
  for (let index = buffer.indexOf("\n"); index >= 0; index = buffer.indexOf("\n")) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isDynamicRecord(message)) continue;
    if (message.type === "system" && message.subtype === "api_retry") {
      state.lastRetry = Number(message.attempt);
      say(`${t()} retry ${message.attempt}/${message.max_retries} in ${message.retry_delay_ms} ms`);
    }
    if (message.type === "result") {
      if (message.is_error) state.failed = String(message.result ?? message.subtype);
      else state.answer = String(message.result ?? "");
    }
  }
});
const code = await new Promise<number>((resolve) => child.on("exit", (exit) => resolve(exit ?? -1)));
front.close();
forward.stop(true);
say(
  `${t()} exit ${code} · connections reset ${resets} · last retry ${state.lastRetry} · ${
    state.answer !== null ? `ANSWERED "${state.answer.trim()}"` : `FAILED: ${state.failed ?? "no result"}`
  }`,
);
process.exit(state.answer !== null ? 0 : 1);
