// Fork: the Antigravity agent of `antigravity-subagent-permissions-e2e.ts`. It starts a subagent as
// `agy acp` 1.5.14 did in a live probe: a `spawn` prompt sends `invoke_subagent` as a tool call that
// completes at once with no output, writes the subagent's first message to
// `<gemini dir>/<app data dir>/brain/<child>/.system_generated/messages/`, and answers `end_turn`.
// The subagent's command asks for its approval only after a client opened the child's session with
// `session/resume` or `session/load`, on that connection and with the child's session id; the agent
// does not name the child over ACP and leaves it out of `session/list`. `spawn-other` writes a
// message whose call id is another one, which no client may take as the call's subagent.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AcpPeer, type AcpRequest, logEntry, serveFakeAcpAgent } from "../acp-agent";

const MODELS = { availableModels: [{ modelId: "gemini-fake", name: "Gemini Fake" }], currentModelId: "gemini-fake" };
const flag = (name: string) => process.argv.find((arg) => arg.startsWith(name))?.slice(name.length);
const brain = join(flag("--gemini-dir=") ?? ".", flag("--app-data-dir=") ?? "antigravity-acp", "brain");
let sessions = 0;
let calls = 0;
/** The subagents that run, with the session that started them. */
const children = new Map<string, string>();

function promptText(request: AcpRequest): string {
  return (request.params.prompt ?? [])
    .map((block) => block.text ?? "")
    .join("")
    .replace(/^[\s\S]*<\/openbot-developer-instructions>/u, "")
    .trim();
}

function writeFirstMessage(child: string, parent: string, toolCallId: string): void {
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
      content: "Run `pwd && echo shell-ok`.",
      sourceMetadata: { tool: { conversationId: parent, toolCall: { id: toolCallId, name: "invoke_subagent" } } },
    }),
  );
}

/** The subagent's one command, which waits for an approval as the CLI's harness does. */
function runChild(peer: AcpPeer, child: string): void {
  const toolCall = { toolCallId: `${child}-cmd`, title: "pwd && echo shell-ok", kind: "execute" as const };
  peer.update(child, { sessionUpdate: "tool_call", ...toolCall, status: "in_progress" });
  void peer
    .ask("session/request_permission", {
      sessionId: child,
      toolCall: { ...toolCall, status: "pending", rawInput: { CommandLine: "pwd && echo shell-ok" } },
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "reject", name: "Reject", kind: "reject_once" },
      ],
    })
    .then((reply) => {
      logEntry({ event: "child-permission", sessionId: child, text: JSON.stringify(reply) });
      peer.update(child, { sessionUpdate: "tool_call_update", toolCallId: toolCall.toolCallId, status: "completed" });
      peer.say(child, "shell-ok");
    });
}

function open(request: AcpRequest, peer: AcpPeer, method: string): void {
  const sessionId = request.params.sessionId ?? "";
  logEntry({
    event: method,
    sessionId,
    text: request.params.cwd,
    mcp: (request.params.mcpServers ?? []).map((server) => server.name),
  });
  peer.reply(request, { models: MODELS });
  if (children.has(sessionId)) setTimeout(() => runChild(peer, sessionId), 50);
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
    peer.reply(request, { sessionId: `agy-${process.pid}-${sessions}`, models: MODELS });
  },
  "session/resume": (request, peer) => open(request, peer, "resume"),
  "session/load": (request, peer) => open(request, peer, "load"),
  "session/list": (request, peer) => peer.reply(request, { sessions: [] }),
  "session/prompt": (request, peer) => {
    const sessionId = request.params.sessionId ?? "";
    const text = promptText(request);
    logEntry({ event: "prompt", sessionId, text });
    if (text === "spawn" || text === "spawn-other") {
      calls += 1;
      const toolCallId = `call_${process.pid}_${calls}`;
      const child = `child-${process.pid}-${calls}`;
      const rawInput = { TypeName: "self", Role: "Runner", Prompt: "Run `pwd && echo shell-ok`." };
      const call = { toolCallId, name: "invoke_subagent", title: "Run invoke_subagent", kind: "other" as const };
      peer.update(sessionId, { sessionUpdate: "tool_call", ...call, status: "in_progress", rawInput });
      children.set(child, sessionId);
      writeFirstMessage(child, sessionId, text === "spawn" ? toolCallId : `${toolCallId}-other`);
      peer.update(sessionId, { sessionUpdate: "tool_call_update", ...call, status: "completed", rawInput });
      peer.say(sessionId, "Launched the subagent.");
    } else {
      peer.say(sessionId, "ok");
    }
    peer.reply(request, { stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } });
  },
});
