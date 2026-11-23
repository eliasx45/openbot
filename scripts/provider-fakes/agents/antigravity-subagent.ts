// Fork: the Antigravity agent of `antigravity-subagent-permissions-e2e.ts`. It starts a subagent as
// `agy acp` 1.5.14 did in a live probe: a `spawn` prompt sends `invoke_subagent` as a tool call that
// completes at once with no output, writes the subagent's first message to
// `<gemini dir>/<app data dir>/brain/<child>/.system_generated/messages/`, and answers `end_turn`.
// The subagent's command asks for its approval only after a client opened the child's session with
// `session/resume` or `session/load`, on that connection and with the child's session id; the agent
// does not name the child over ACP and leaves it out of `session/list`. `spawn-other` writes a
// message whose call id is another one, which no client may take as the call's subagent.
// Fork (FEATURES.md #90): once opened, a subagent sends its steps on its own session and reports
// with `send_message` to its parent, as in the probe (`captures/C-resume-child/acp.ndjson`), then
// sends one more line of text. `spawn-two` starts two subagents with one `start_subagent` call, whose
// folders sort in the other order than the list; each only reports its task. `spawn-idle` starts one
// that does nothing, and `kill` stops it with `manage_subagents`.
// Fork (FEATURES.md #92): `spawn-hold-two` starts two subagents that each run one step and then wait
// until the test writes `finish-<their task>` in `FAKE_CONTROL`, so they run while the test changes
// an MCP server. The process logs its start and its SIGTERM, and answers `--version` as the CLI does,
// for a test that runs the whole agent service.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
const control = process.env.FAKE_CONTROL ?? ".";

const MODELS = { availableModels: [{ modelId: "gemini-fake", name: "Gemini Fake" }], currentModelId: "gemini-fake" };
const flag = (name: string) => process.argv.find((arg) => arg.startsWith(name))?.slice(name.length);
const brain = join(flag("--gemini-dir=") ?? ".", flag("--app-data-dir=") ?? "antigravity-acp", "brain");
const SHELL_PROMPT = "Run `pwd && echo shell-ok`.";
let sessions = 0;
let calls = 0;
/** What each subagent does once its session is opened: its parent, and its task. */
const children = new Map<string, { parent: string; work: "shell" | "report" | "idle" | "hold"; prompt: string }>();
let idleChild = "";

function promptText(request: AcpRequest): string {
  return (request.params.prompt ?? [])
    .map((block) => block.text ?? "")
    .join("")
    .replace(/^[\s\S]*<\/openbot-developer-instructions>/u, "")
    .trim();
}

function writeFirstMessage(child: string, parent: string, toolCallId: string, prompt: string): void {
  const messages = join(brain, child, ".system_generated", "messages");
  mkdirSync(messages, { recursive: true });
  writeFileSync(join(messages, "read.json"), "{}");
  writeFileSync(
    join(messages, `message-${child}.json`),
    JSON.stringify({
      id: `message-${child}`,
      recipient: child,
      sender: parent,
      renderDetails: { messageTitle: "Message from Parent Agent" },
      content: prompt,
      sourceMetadata: { tool: { conversationId: parent, toolCall: { id: toolCallId, name: "invoke_subagent" } } },
    }),
  );
}

/** The subagent's report to its parent, then a line of its own after it, as 1.5.14 sends them. */
function report(peer: AcpPeer, child: string, parent: string, text: string): void {
  peer.say(child, "Reporting to the parent.");
  const rawInput = { Message: text, Recipient: parent };
  const call = { toolCallId: `${child}-send`, name: "send_message", title: "Run send_message", kind: "other" as const };
  peer.update(child, { sessionUpdate: "tool_call", ...call, status: "in_progress", rawInput });
  peer.update(child, { sessionUpdate: "tool_call_update", ...call, status: "completed", rawInput });
  peer.say(child, "Reported output to parent.");
}

/** The subagent's one command, which waits for an approval as the CLI's harness does. */
function runChild(peer: AcpPeer, child: string): void {
  const task = children.get(child);
  if (!task || task.work === "idle") return;
  if (task.work === "report") {
    report(peer, child, task.parent, `Done: ${task.prompt}`);
    return;
  }
  if (task.work === "hold") {
    const step = { toolCallId: `${child}-hold`, title: `work on ${task.prompt}`, kind: "execute" as const };
    peer.update(child, { sessionUpdate: "tool_call", ...step, status: "in_progress", rawInput: {} });
    logEntry({ event: "child-running", sessionId: child, text: task.prompt });
    const finish = join(control, `finish-${task.prompt}`);
    const wait = setInterval(() => {
      if (!existsSync(finish)) return;
      clearInterval(wait);
      peer.update(child, { sessionUpdate: "tool_call_update", toolCallId: step.toolCallId, status: "completed" });
      report(peer, child, task.parent, `Done: ${task.prompt}`);
      logEntry({ event: "child-done", sessionId: child, text: task.prompt });
    }, 25);
    return;
  }
  const rawInput = { CommandLine: "pwd && echo shell-ok" };
  const toolCall = { toolCallId: `${child}-cmd`, title: "pwd && echo shell-ok", kind: "execute" as const };
  peer.update(child, { sessionUpdate: "tool_call", ...toolCall, status: "in_progress", rawInput });
  void peer
    .ask("session/request_permission", {
      sessionId: child,
      toolCall: { ...toolCall, status: "pending", rawInput },
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "reject", name: "Reject", kind: "reject_once" },
      ],
    })
    .then((reply) => {
      const allowed = JSON.stringify(reply).includes('"optionId":"allow"');
      logEntry({ event: "child-permission", sessionId: child, text: JSON.stringify(reply) });
      peer.update(child, {
        sessionUpdate: "tool_call_update",
        toolCallId: toolCall.toolCallId,
        status: allowed ? "completed" : "failed",
      });
      report(peer, child, task.parent, allowed ? "shell-ok" : "The command was refused.");
    });
}

type McpServers = NonNullable<AcpRequest["params"]["mcpServers"]>;

async function mcpRequest(server: McpServers[number], method: string, id: number): Promise<void> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  for (const header of server.headers ?? []) headers[header.name] = header.value;
  const params =
    method === "initialize"
      ? { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake-agy", version: "1" } }
      : {};
  await fetch(server.url ?? "", {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  })
    .then((response) => response.text())
    .catch(() => "");
}

async function listOpenBotTools(servers: McpServers): Promise<void> {
  for (const server of servers) {
    if (server.type !== "http" || !server.name.startsWith("openbot")) continue;
    await mcpRequest(server, "initialize", 1);
    await mcpRequest(server, "tools/list", 2);
  }
}

function open(request: AcpRequest, peer: AcpPeer, method: string): void {
  const sessionId = request.params.sessionId ?? "";
  logEntry({
    event: method,
    sessionId,
    text: request.params.cwd,
    mcp: (request.params.mcpServers ?? []).map((server) => server.name),
  });
  void listOpenBotTools(request.params.mcpServers ?? []).then(() => {
    peer.reply(request, { models: MODELS });
    if (children.has(sessionId)) setTimeout(() => runChild(peer, sessionId), 50);
  });
}

/** `invoke_subagent` (one subagent) or `start_subagent` (a `Subagents` list), which completes at once. */
function spawn(peer: AcpPeer, sessionId: string, text: string): void {
  calls += 1;
  const toolCallId = `call_${process.pid}_${calls}`;
  if (text === "spawn-two" || text === "spawn-hold-two") {
    const hold = text === "spawn-hold-two";
    const tasks = hold ? ["harvest-left", "harvest-right"] : ["Index the clips.", "Sort the shelf."];
    const list = tasks.map((Prompt, index) => ({
      TypeName: "self",
      Role: `Worker ${index + 1}`,
      Prompt,
    }));
    const rawInput = { Subagents: list };
    const call = { toolCallId, name: "start_subagent", title: "Running start_subagent", kind: "other" as const };
    peer.update(sessionId, { sessionUpdate: "tool_call", ...call, status: "in_progress", rawInput });
    // `z-…` holds the first task and `a-…` the second, so the folder order is not the list order.
    for (const [index, entry] of list.entries()) {
      const child = `${index === 0 ? "z" : "a"}-child-${process.pid}-${calls}`;
      children.set(child, { parent: sessionId, work: hold ? "hold" : "report", prompt: entry.Prompt });
      writeFirstMessage(child, sessionId, toolCallId, entry.Prompt);
    }
    peer.update(sessionId, { sessionUpdate: "tool_call_update", ...call, status: "completed", rawInput });
    return;
  }
  const child = `child-${process.pid}-${calls}`;
  const rawInput = { TypeName: "self", Role: "Runner", Prompt: SHELL_PROMPT, Model: "inherit" };
  const call = { toolCallId, name: "invoke_subagent", title: "Run invoke_subagent", kind: "other" as const };
  peer.update(sessionId, { sessionUpdate: "tool_call", ...call, status: "in_progress", rawInput });
  children.set(child, { parent: sessionId, work: text === "spawn-idle" ? "idle" : "shell", prompt: SHELL_PROMPT });
  if (text === "spawn-idle") idleChild = child;
  writeFirstMessage(child, sessionId, text === "spawn-other" ? `${toolCallId}-other` : toolCallId, SHELL_PROMPT);
  peer.update(sessionId, { sessionUpdate: "tool_call_update", ...call, status: "completed", rawInput });
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
    void listOpenBotTools(request.params.mcpServers ?? []).then(() =>
      peer.reply(request, { sessionId, models: MODELS }),
    );
  },
  "session/resume": (request, peer) => open(request, peer, "resume"),
  "session/load": (request, peer) => open(request, peer, "load"),
  "session/list": (request, peer) => peer.reply(request, { sessions: [] }),
  "session/prompt": (request, peer) => {
    const sessionId = request.params.sessionId ?? "";
    const text = promptText(request);
    logEntry({ event: "prompt", sessionId, text });
    if (text.startsWith("spawn")) {
      spawn(peer, sessionId, text);
      peer.say(sessionId, "Launched the subagent.");
    } else if (text === "kill") {
      const rawInput = { Action: "kill", ConversationIds: JSON.stringify([idleChild]) };
      const call = { toolCallId: `call_kill_${process.pid}`, name: "manage_subagents", title: "Run manage_subagents" };
      peer.update(sessionId, { sessionUpdate: "tool_call", ...call, kind: "other", status: "in_progress", rawInput });
      peer.update(sessionId, {
        sessionUpdate: "tool_call_update",
        ...call,
        kind: "other",
        status: "completed",
        rawInput,
      });
      peer.say(sessionId, "Stopped the subagent.");
    } else {
      peer.say(sessionId, "ok");
    }
    peer.reply(request, { stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } });
  },
});
