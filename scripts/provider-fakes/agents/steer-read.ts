import { appendFileSync, closeSync, openSync, readSync, statSync } from "node:fs";
import type { SessionUpdate } from "@agentclientprotocol/sdk";

interface Request {
  id: number | string;
  method: string;
  params: { sessionId?: string; prompt?: { type: string; text?: string }[] };
}

interface Command {
  update?: SessionUpdate;
  end?: true;
  mark: number;
}

const NL = "\n";
const steering = process.env.FAKE_MODE === "steering";
const control = process.env.FAKE_CONTROL ?? "";
const MODELS = { availableModels: [{ modelId: "fake-model", name: "Fake Model" }], currentModelId: "fake-model" };
const open = new Map<string, Request>();
let sessions = 0;
let offset = sizeOf(control);
let buffer = "";

function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function log(entry: Record<string, string | number>): void {
  if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, `${JSON.stringify(entry)}${NL}`);
}

type Outgoing =
  | { id: Request["id"]; result: unknown }
  | { id: Request["id"]; error: { code: number; message: string } }
  | { method: string; params: unknown };

function write(message: Outgoing): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}${NL}`);
}

function reply(request: Request, result: unknown): void {
  write({ id: request.id, result });
}

function update(sessionId: string, value: SessionUpdate): void {
  write({ method: "session/update", params: { sessionId, update: value } });
}

function promptText(request: Request): string {
  return (request.params.prompt ?? [])
    .map((block) => block.text ?? "")
    .join("")
    .replace(/^[\s\S]*<\/openbot-developer-instructions>/u, "")
    .trim();
}

function run(command: Command): void {
  for (const [sessionId, request] of open) {
    if (command.update) update(sessionId, command.update);
    if (command.end) {
      open.delete(sessionId);
      reply(request, { stopReason: "end_turn" });
    }
    update(sessionId, { sessionUpdate: "usage_update", used: command.mark, size: 1_000_000 });
  }
}

function readControl(): void {
  const size = sizeOf(control);
  if (size <= offset) return;
  const bytes = Buffer.alloc(size - offset);
  const file = openSync(control, "r");
  readSync(file, bytes, 0, bytes.length, offset);
  closeSync(file);
  offset = size;
  buffer += bytes.toString("utf8");
  for (let index = buffer.indexOf(NL); index >= 0; index = buffer.indexOf(NL)) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (line.trim() && open.size > 0) run(JSON.parse(line));
  }
}

function handle(request: Request): void {
  const sessionId = request.params.sessionId ?? "";
  switch (request.method) {
    case "initialize":
      reply(request, {
        protocolVersion: 1,
        agentInfo: steering
          ? { name: "OpenCode", version: "2.3.0" }
          : { name: "Antigravity ACP Server", version: process.env.FAKE_VERSION ?? "1.5.16" },
        agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } },
        authMethods: [],
        ...(steering ? { _meta: { steering: { supported: true } } } : {}),
      });
      return;
    case "session/new":
      sessions += 1;
      reply(request, { sessionId: `fake-${process.pid}-${sessions}`, models: MODELS });
      return;
    case "session/resume":
      reply(request, { models: MODELS });
      return;
    case "session/prompt": {
      const previous = open.get(sessionId);
      const text = promptText(request);
      log({ event: "prompt", sessionId, text, steer: previous ? 1 : 0 });
      if (previous && text.startsWith("refuse")) {
        write({
          id: request.id,
          error: { code: -32603, message: `Can't add this prompt to session ${sessionId}: the running prompt waits` },
        });
        return;
      }
      if (previous) reply(previous, { stopReason: "end_turn" });
      open.set(sessionId, request);
      return;
    }
    case "_session/steering":
      log({ event: "steering", sessionId, text: promptText(request) });
      reply(request, open.has(sessionId) ? { outcome: "injected" } : { outcome: "promptRequired" });
      return;
    default:
      reply(request, {});
  }
}

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  input += chunk;
  for (let index = input.indexOf(NL); index >= 0; index = input.indexOf(NL)) {
    const line = input.slice(0, index);
    input = input.slice(index + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (typeof message.method !== "string") continue;
    if (message.id === undefined) {
      if (message.method !== "session/cancel") continue;
      const sessionId = message.params?.sessionId ?? "";
      const prompt = open.get(sessionId);
      open.delete(sessionId);
      if (prompt) reply(prompt, { stopReason: "cancelled" });
      continue;
    }
    handle({ id: message.id, method: message.method, params: message.params ?? {} });
  }
});
process.stdin.on("end", () => process.exit(0));
setInterval(readControl, 10);
