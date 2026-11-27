// Fork (docs/fork/FEATURES.md #136, "Never lose work"): a fake `agy acp` (Antigravity) for the checks of
// a quit mid-turn, a teammate turn that fails, and a repeated send. By prompt:
// - `hold-turn` (the whole prompt, or after OpenBot's prompt blocks): a turn that runs until OpenBot quits.
//   Prompts steered into it end the earlier prompt without an answer and keep the turn open, so they stay
//   unhandled, as when a quit comes before the agent read them.
// - the restart wake (`[OpenBot: 🔄 restart]`): answers which of the listed messages it handled.
// - `fail-once` / `fail-always` (a teammate's request): works `FAKE_FAIL_AFTER_MS` (default 8 s, so the
//   lead can steer updates in), then fails as Gemini does when its connection resets (cause network).
//   `fail-once` succeeds on OpenBot's retry (`[OpenBot: 🔁 retry]`) and names the messages resent with it.
// - `send-once:<json>` / `send-twice:<json>`: calls openbot `send_message` once or twice with the same
//   arguments over the session's OpenBot MCP server and answers the results.
import { type AcpPeer, type AcpRequest, logEntry, serveFakeAcpAgent } from "../acp-agent";

if (process.argv.includes("--version")) {
  process.stdout.write("1.5.14\n");
  process.exit(0);
}
logEntry({ event: "start", text: String(process.pid) });
process.on("SIGTERM", () => {
  logEntry({ event: "sigterm", text: String(process.pid) });
  process.exit(0);
});

type McpServers = NonNullable<AcpRequest["params"]["mcpServers"]>;
const MODELS = { availableModels: [{ modelId: "gemini-fake", name: "Gemini Fake" }], currentModelId: "gemini-fake" };
const FAIL_AFTER_MS = Number(process.env.FAKE_FAIL_AFTER_MS ?? "8000");
const NETWORK_FAILURE = "Agent execution error: read tcp 10.0.0.2:52144->142.250.0.95:443: connection reset by peer";
/** The open prompt of each session: a held turn, or the latest prompt steered into it. */
const open = new Map<string, AcpRequest>();
const servers = new Map<string, McpServers>();
let sessions = 0;
let replies = 0;
let lastPeer: AcpPeer | undefined;

function promptText(request: AcpRequest): string {
  return (request.params.prompt ?? [])
    .map((block) => block.text ?? "")
    .join("")
    .replace(/^[\s\S]*<\/openbot-developer-instructions>/u, "")
    .trim();
}

function end(peer: AcpPeer, request: AcpRequest): void {
  replies += 1;
  peer.reply(request, { stopReason: "end_turn", usage: { inputTokens: replies, outputTokens: 1, totalTokens: 2 } });
}

async function mcp(server: McpServers[number], method: string, params: unknown, id: number): Promise<string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  for (const header of server.headers ?? []) headers[header.name] = header.value;
  const response = await fetch(server.url ?? "", {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  }).catch(() => null);
  return response ? await response.text() : "";
}

/** Calls openbot `send_message` with `args` over the session's OpenBot MCP server. */
async function sendMessage(sessionId: string, args: unknown, id: number): Promise<string> {
  const server = (servers.get(sessionId) ?? []).find((item) => item.type === "http" && item.name.startsWith("openbot"));
  if (!server) return "no OpenBot MCP server";
  await mcp(
    server,
    "initialize",
    { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake-agy", version: "1" } },
    id,
  );
  const list = await mcp(server, "tools/list", {}, id + 1);
  const name = /"name":"((?:[\w-]+__)?send_message)"/u.exec(list)?.[1];
  const call = name
    ? { name, arguments: args }
    : { name: "tool_call", arguments: { name: "openbot.send_message", arguments: args } };
  return await mcp(server, "tools/call", call, id + 2);
}

/** As `agy` does at a session's start: it lists the OpenBot MCP tools (OpenBot checks that it did). */
async function listTools(list: McpServers): Promise<void> {
  for (const server of list) {
    if (server.type !== "http" || !server.name.startsWith("openbot")) continue;
    await mcp(
      server,
      "initialize",
      { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake-agy", version: "1" } },
      1,
    );
    await mcp(server, "tools/list", {}, 2);
  }
}

function shown(result: string): string {
  const text = /"text":"((?:[^"\\]|\\.)*)"/u.exec(result)?.[1] ?? result;
  return text.replace(/\\"/gu, '"').slice(0, 400);
}

serveFakeAcpAgent({
  initialize: (request, peer) =>
    peer.reply(request, {
      protocolVersion: 1,
      agentInfo: { name: "Antigravity ACP Server", version: "1.5.14" },
      agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {}, list: {} } },
      authMethods: [],
    }),
  "session/new": (request, peer) => {
    sessions += 1;
    const sessionId = `agy-${process.pid}-${sessions}`;
    servers.set(sessionId, request.params.mcpServers ?? []);
    logEntry({ event: "new", sessionId });
    void listTools(request.params.mcpServers ?? []).then(() => peer.reply(request, { sessionId, models: MODELS }));
  },
  "session/resume": (request, peer) => {
    const sessionId = request.params.sessionId ?? "";
    servers.set(sessionId, request.params.mcpServers ?? []);
    logEntry({ event: "resume", sessionId });
    void listTools(request.params.mcpServers ?? []).then(() => peer.reply(request, { models: MODELS }));
  },
  "session/load": (request, peer) => {
    const sessionId = request.params.sessionId ?? "";
    servers.set(sessionId, request.params.mcpServers ?? []);
    logEntry({ event: "load", sessionId });
    void listTools(request.params.mcpServers ?? []).then(() => peer.reply(request, { models: MODELS }));
  },
  "session/list": (request, peer) => peer.reply(request, { sessions: [] }),
  "session/cancel": (request) => {
    const sessionId = request.params.sessionId ?? "";
    const held = open.get(sessionId);
    open.delete(sessionId);
    logEntry({ event: "cancel", sessionId });
    if (held) lastPeer?.reply(held, { stopReason: "cancelled" });
  },
  "session/prompt": (request, peer) => {
    lastPeer = peer;
    const sessionId = request.params.sessionId ?? "";
    const text = promptText(request);
    const previous = open.get(sessionId);
    logEntry({ event: "prompt", sessionId, text, steer: previous !== undefined });
    if (previous) {
      // Steered into the running turn: the turn goes on, the message is not handled yet.
      open.set(sessionId, request);
      end(peer, previous);
      return;
    }
    if (/(?:^|>)hold-turn$/u.test(text)) {
      peer.say(sessionId, "Working on it.");
      open.set(sessionId, request);
      return;
    }
    if (text.includes("[OpenBot: 🔄 restart]")) {
      const listed = text
        .split("\n")
        .filter((line) => line.startsWith("- "))
        .map((line) => line.replace(/^- [^:]*:\d\d[^,]*, from [^:]+: /u, ""));
      peer.say(
        sessionId,
        listed.length > 0
          ? `Resumed after the restart. Handled the messages that came in: ${listed.join(" | ")}`
          : "Resumed after the restart; nothing else was waiting.",
      );
      end(peer, request);
      return;
    }
    const send = /send-(once|twice):(\{[\s\S]*\})\s*$/u.exec(text);
    if (send?.[2]) {
      const args = JSON.parse(send[2]);
      const twice = send[1] === "twice";
      void (async () => {
        const first = await sendMessage(sessionId, args, 10);
        const second = twice ? await sendMessage(sessionId, args, 20) : "";
        logEntry({ event: `send-${send[1]}`, sessionId, text: `${shown(first)} || ${shown(second)}` });
        peer.say(
          sessionId,
          twice ? `First send: ${shown(first)}\nSecond send: ${shown(second)}` : `Sent: ${shown(first)}`,
        );
        end(peer, request);
      })();
      return;
    }
    if (text.includes("fail-once") || text.includes("fail-always")) {
      if (text.includes("fail-once") && text.includes("[OpenBot: 🔁 retry]")) {
        const resent = (text.match(/\[OpenBot: 🔁 resent\]/gu) ?? []).length;
        peer.say(
          sessionId,
          `Status: done\nResult: finished on OpenBot's retry; ${resent} message(s) from the failed attempt handled too.`,
        );
        end(peer, request);
        return;
      }
      peer.say(sessionId, "Working on the request.");
      open.set(sessionId, request);
      setTimeout(() => {
        const current = open.get(sessionId);
        if (!current) return;
        open.delete(sessionId);
        peer.say(sessionId, NETWORK_FAILURE);
        end(peer, current);
      }, FAIL_AFTER_MS);
      return;
    }
    peer.say(sessionId, "ok");
    end(peer, request);
  },
});
