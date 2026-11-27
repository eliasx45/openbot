// Fork (docs/fork/FEATURES.md #131): an `agy acp` that is slow, not hung. It leaves its first
// `FAKE_SILENT_LISTS` `session/list` requests unanswered (or answers them after `FAKE_LIST_DELAY_MS`
// when that is set), as a busy machine did to OpenBot's liveness probe. A `hold-<ms>` prompt is a turn
// held open while a background job runs: one line at once, then nothing until the job ends after
// `<ms>`, then the rest of the answer and `end_turn`. `quiet-<ms>` does the same without the first line
// (a turn with no answer yet). With `FAKE_JOB=1` such a prompt starts a `sleep` child, a background job
// that outlives the agent; with `FAKE_BUSY=1` a child that burns CPU instead (a job that computes).
// Self-contained (no imports from `../acp-agent`)
// so `node` runs it under vitest too. Logs its start, each `session/list` and its SIGTERM to `FAKE_LOG`.
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";

interface McpServer {
  type?: string;
  name: string;
  url?: string;
  headers?: { name: string; value: string }[];
}

interface Request {
  id: number | string;
  method?: string;
  params?: {
    sessionId?: string;
    cwd?: string;
    prompt?: { type: string; text?: string }[];
    mcpServers?: McpServer[];
  };
}

const NL = "\n";
const silentLists = Number(process.env.FAKE_SILENT_LISTS ?? 0);
const listDelayMs = Number(process.env.FAKE_LIST_DELAY_MS ?? 0);
const MODELS = { availableModels: [{ modelId: "gemini-fake", name: "Gemini Fake" }], currentModelId: "gemini-fake" };
const open = new Map<string, Request>();
let sessions = 0;
let lists = 0;
/** A prompt with `lists:now`, `lists:late` or `lists:none` sets how this process answers probes from then on. */
let listMode: string | null = null;
let buffer = "";

if (process.argv.includes("--version")) {
  process.stdout.write("1.5.17\n");
  process.exit(0);
}

function log(entry: { event: string; text?: string; sessionId?: string }): void {
  if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, `${JSON.stringify(entry)}${NL}`);
}

type Outgoing = { id: Request["id"]; result: unknown } | { method: string; params: unknown };

function write(message: Outgoing): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}${NL}`);
}

function reply(request: Request, result: unknown): void {
  write({ id: request.id, result });
}

function say(sessionId: string, text: string): void {
  write({
    method: "session/update",
    params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } },
  });
}

/** Lists OpenBot's MCP tools as `agy` does when a session opens, so OpenBot sees its tools reached. */
async function listOpenBotTools(servers: McpServer[]): Promise<void> {
  for (const server of servers) {
    if (server.type !== "http" || !server.name.startsWith("openbot")) continue;
    for (const [id, method] of ["initialize", "tools/list"].entries()) {
      const headers = new Headers({
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      });
      for (const header of server.headers ?? []) headers.set(header.name, header.value);
      const params =
        method === "initialize"
          ? { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake-agy", version: "1" } }
          : {};
      await fetch(server.url ?? "", {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: id + 1, method, params }),
      })
        .then((response) => response.text())
        .catch(() => "");
    }
  }
}

function promptText(request: Request): string {
  return (request.params?.prompt ?? [])
    .map((block) => block.text ?? "")
    .join("")
    .replace(/^[\s\S]*<\/openbot-developer-instructions>/u, "")
    .trim();
}

function handle(request: Request): void {
  const sessionId = request.params?.sessionId ?? "";
  if (request.method === "session/cancel") {
    const prompt = open.get(sessionId);
    open.delete(sessionId);
    if (prompt) reply(prompt, { stopReason: "cancelled" });
    return;
  }
  switch (request.method) {
    case "initialize":
      reply(request, {
        protocolVersion: 1,
        agentInfo: { name: "Antigravity ACP Server", version: "1.5.17" },
        agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {}, list: {} } },
        authMethods: [],
      });
      return;
    case "session/new": {
      sessions += 1;
      const id = `agy-${process.pid}-${sessions}`;
      void listOpenBotTools(request.params?.mcpServers ?? []).then(() =>
        reply(request, { sessionId: id, models: MODELS }),
      );
      return;
    }
    case "session/resume":
    case "session/load":
      log({ event: request.method, sessionId });
      void listOpenBotTools(request.params?.mcpServers ?? []).then(() => reply(request, { models: MODELS }));
      return;
    case "session/list":
      lists += 1;
      log({ event: "session/list", text: String(lists) });
      if (listMode === "now" || (listMode === null && lists > silentLists)) reply(request, { sessions: [] });
      else if (listMode !== "none" && listDelayMs > 0) setTimeout(() => reply(request, { sessions: [] }), listDelayMs);
      return;
    case "session/prompt": {
      const text = promptText(request);
      log({ event: "prompt", sessionId, text });
      listMode = /\blists:(now|late|none)\b/u.exec(text)?.[1] ?? listMode;
      const hold = /\b(hold|quiet)-(\d+)\b/u.exec(text);
      // OpenBot's own notes and wakes quote the request; they get a plain answer.
      if (!hold || text.includes("[OpenBot:") || text.includes("OpenBot note")) {
        say(sessionId, "ok");
        reply(request, { stopReason: "end_turn" });
        return;
      }
      open.set(sessionId, request);
      if (process.env.FAKE_JOB === "1") {
        const job = spawn("sleep", ["300"], { stdio: "ignore" });
        log({ event: "job", text: String(job.pid) });
      }
      if (process.env.FAKE_BUSY === "1") {
        const job = spawn(process.execPath, ["-e", "for(;;){}"], { stdio: "ignore" });
        log({ event: "job", text: String(job.pid) });
      }
      if (hold[1] === "hold") say(sessionId, "Started the run; waiting for it to finish.");
      setTimeout(() => {
        if (open.get(sessionId) !== request) return;
        open.delete(sessionId);
        say(sessionId, " Run finished.");
        reply(request, { stopReason: "end_turn" });
      }, Number(hold[2]));
      return;
    }
    default:
      if (request.id !== undefined) reply(request, {});
  }
}

log({ event: "start", text: String(process.pid) });
process.on("SIGTERM", () => {
  log({ event: "sigterm", text: String(process.pid) });
  process.exit(0);
});
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  for (let index = buffer.indexOf(NL); index >= 0; index = buffer.indexOf(NL)) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});
setInterval(() => {}, 1000);
