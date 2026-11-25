import { appendFileSync } from "node:fs";

const NL = "\n";
const log = process.env.FAKE_LOG ?? "";
let buffer = "";
let sessions = 0;

interface Outgoing {
  id?: number | string;
  method?: string;
  params?: object;
  result?: object;
}

interface Incoming {
  id?: number | string;
  method?: string;
  params?: { sessionId?: string; prompt?: unknown };
}

function write(message: Outgoing): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}${NL}`);
}

function handle(message: Incoming): void {
  if (message.id === undefined || typeof message.method !== "string") return;
  const params = message.params ?? {};
  if (message.method === "initialize") {
    write({
      id: message.id,
      result: {
        protocolVersion: 1,
        agentInfo: { name: "fake", title: "turn-input", version: "1.0.0" },
        agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } },
      },
    });
    return;
  }
  if (message.method === "session/new") {
    sessions += 1;
    write({ id: message.id, result: { sessionId: `session-${sessions}` } });
    return;
  }
  if (message.method === "session/prompt") {
    const sessionId = params.sessionId;
    const blocks = Array.isArray(params.prompt) ? params.prompt : [];
    appendFileSync(log, `${JSON.stringify({ sessionId, prompt: blocks })}${NL}`);
    write({
      method: "session/update",
      params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "OK" } } },
    });
    write({ id: message.id, result: { stopReason: "end_turn" } });
    return;
  }
  write({ id: message.id, result: {} });
}

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
