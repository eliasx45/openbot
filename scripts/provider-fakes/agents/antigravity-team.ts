// Fork (docs/fork/FEATURES.md #135, "Team watchdogs and guards"): a fake `agy acp` 1.5.14 for a team
// of agents that message each other through OpenBot's own MCP server (`openbot` send_message, as the
// real CLI calls it). The prompt's words choose what an agent does:
// - `team-delegate` (to the lead): sends Chopper `team-quiet-work`, Nami `team-loop-work`, Usopp
//   `team-ask-back` and c1 `team-chain 1`, all requests (expectsReply true);
// - `team-quiet-work`: starts one long command and then sends nothing more (a quiet teammate);
// - `team-loop-work`: runs the same command again and again, every `FAKE_LOOP_MS` (a looping teammate);
// - `team-ask-back`: asks its lead back with expectsReply true (a mutual wait), then answers blocked;
// - `team-chain N`: sends c(N+1) `team-chain N+1`, so the 9th hop is refused;
// - the team watchdog's wake: ends quietly with `routine_no_update`.
// Every OpenBot tool result is logged to `FAKE_LOG` (`event: "tool"`).
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
const LOOP_MS = Number(process.env.FAKE_LOOP_MS) > 0 ? Number(process.env.FAKE_LOOP_MS) : 3_000;
const servers = new Map<string, McpServers>();
let sessions = 0;
let calls = 0;

function promptText(request: AcpRequest): string {
  return (request.params.prompt ?? [])
    .map((block) => block.text ?? "")
    .join("")
    .replace(/^[\s\S]*<\/openbot-developer-instructions>/u, "")
    .trim();
}

interface ToolAnswer {
  isError: boolean;
  text: string;
}

/** The text of an MCP `tools/call` answer, which comes as JSON or as server-sent events. */
function toolAnswer(body: string): ToolAnswer {
  const data = body.trim().startsWith("{")
    ? body
    : body
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .at(-1);
  let parsed: { result?: { isError?: boolean; content?: Array<{ text?: string }> } } | null = null;
  try {
    parsed = JSON.parse(data ?? "null");
  } catch {}
  const result = parsed?.result;
  const text = (result?.content ?? []).map((item) => item.text ?? "").join("\n");
  return { isError: !result || result.isError === true, text: text || body.slice(0, 500) };
}

type ToolArgs = Readonly<Record<string, string | number | boolean | readonly string[]>>;

/** Lists the OpenBot tools as the CLI does when a session opens; OpenBot counts that as the tools reached. */
async function listOpenBotTools(list: McpServers): Promise<void> {
  for (const server of list) {
    if (server.type !== "http" || !server.name.startsWith("openbot") || !server.url) continue;
    const headers = new Headers({ "content-type": "application/json", accept: "application/json, text/event-stream" });
    for (const header of server.headers ?? []) headers.set(header.name, header.value);
    for (const [id, method] of [
      [1, "initialize"],
      [2, "tools/list"],
    ] as const) {
      const params =
        method === "initialize"
          ? { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake-agy", version: "1" } }
          : {};
      await fetch(server.url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) })
        .then((answer) => answer.text())
        .catch(() => "");
    }
  }
}

async function openBotTool(sessionId: string, tool: string, args: ToolArgs): Promise<ToolAnswer> {
  const server = (servers.get(sessionId) ?? []).find((entry) => entry.type === "http" && entry.name === "openbot");
  if (!server?.url) return { isError: true, text: "no openbot MCP server" };
  const headers = new Headers({ "content-type": "application/json", accept: "application/json, text/event-stream" });
  for (const header of server.headers ?? []) headers.set(header.name, header.value);
  calls += 1;
  const body = await fetch(server.url, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: calls, method: "tools/call", params: { name: tool, arguments: args } }),
  })
    .then((answer) => answer.text())
    .catch((error: Error) => error.message);
  const answer = toolAnswer(body);
  logEntry({
    event: "tool",
    sessionId,
    tool,
    text: answer.text.slice(0, 2_000),
    error: answer.isError,
    args: JSON.stringify(args),
  });
  return answer;
}

/** A tool step of the agent's own, shown in its turn. */
function step(
  peer: AcpPeer,
  sessionId: string,
  id: string,
  title: string,
  rawInput: { CommandLine: string },
  done: boolean,
): void {
  const call = { toolCallId: id, title, kind: "execute" as const };
  peer.update(sessionId, { sessionUpdate: "tool_call", ...call, status: "in_progress", rawInput });
  if (done) peer.update(sessionId, { sessionUpdate: "tool_call_update", ...call, status: "completed", rawInput });
}

const send = (sessionId: string, recipient: string, text: string, extra: ToolArgs = {}) =>
  openBotTool(sessionId, "send_message", { recipientAgentIds: [recipient], text, expectsReply: true, ...extra });

function end(peer: AcpPeer, request: AcpRequest): void {
  peer.reply(request, { stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } });
}

function open(request: AcpRequest, peer: AcpPeer, method: string): void {
  const sessionId = request.params.sessionId ?? "";
  servers.set(sessionId, request.params.mcpServers ?? []);
  logEntry({ event: method, sessionId, text: request.params.cwd });
  void listOpenBotTools(request.params.mcpServers ?? []).then(() => peer.reply(request, { models: MODELS }));
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
    logEntry({ event: "new", sessionId, text: request.params.cwd });
    void listOpenBotTools(request.params.mcpServers ?? []).then(() =>
      peer.reply(request, { sessionId, models: MODELS }),
    );
  },
  "session/resume": (request, peer) => open(request, peer, "resume"),
  "session/load": (request, peer) => open(request, peer, "load"),
  "session/list": (request, peer) => peer.reply(request, { sessions: [] }),
  "session/prompt": (request, peer) => {
    const sessionId = request.params.sessionId ?? "";
    const whole = promptText(request);
    logEntry({ event: "prompt", sessionId, text: whole });
    // Only the current message: a new session's prompt starts with excerpts of the earlier conversation.
    const marker = ["--- current message ---", "--- collaborator message ---"]
      .map((mark) => whole.lastIndexOf(mark))
      .reduce((left, right) => Math.max(left, right), -1);
    const text = marker >= 0 ? whole.slice(marker) : whole;
    void (async () => {
      if (text.includes("[OpenBot: 🐕 team watchdog]")) {
        await openBotTool(sessionId, "routine_no_update", {});
        end(peer, request);
        return;
      }
      if (text.includes("team-delegate")) {
        await send(sessionId, "chopper", "team-quiet-work: render the 30 s promo at 4K and send me the path.", {
          dueMinutes: 60,
          doneWhen: "promo-4k.mp4 exists in your renders folder",
        });
        await send(sessionId, "nami", "team-loop-work: list the new renders and pick the sharpest.");
        await send(sessionId, "usopp", "team-ask-back: check the style pack.");
        await send(sessionId, "c1", "team-chain 1: pass this on down the chain.");
        peer.say(sessionId, "Sent the four requests.");
        end(peer, request);
        return;
      }
      if (text.includes("team-quiet-work")) {
        peer.say(sessionId, "Starting the render.");
        step(
          peer,
          sessionId,
          `render-${process.pid}-${Date.now()}`,
          "python render.py --4k",
          { CommandLine: "python render.py --4k" },
          false,
        );
        return; // The turn stays open and sends nothing more.
      }
      if (text.includes("team-loop-work")) {
        peer.say(sessionId, "Looking at the renders.");
        let index = 0;
        const loop = () => {
          index += 1;
          step(
            peer,
            sessionId,
            `ls-${process.pid}-${index}`,
            "ls /renders/out",
            { CommandLine: "ls /renders/out" },
            true,
          );
        };
        loop();
        setInterval(loop, LOOP_MS);
        return; // Never ends: it keeps listing the same folder.
      }
      if (text.includes("team-ask-back")) {
        const asked = await send(sessionId, "vegapunk", "Which style pack do you mean?");
        peer.say(
          sessionId,
          asked.isError
            ? "Status: blocked\nResult: I need to know which style pack.\nEvidence: none\nUnblock: name the style pack."
            : "Asked back.",
        );
        end(peer, request);
        return;
      }
      const chain = /team-chain (\d+)/u.exec(text);
      if (chain?.[1]) {
        const next = Number(chain[1]) + 1;
        const sent = await send(sessionId, `c${next}`, `team-chain ${next}: pass this on down the chain.`);
        peer.say(
          sessionId,
          sent.isError ? `Status: blocked\nResult: ${sent.text.slice(0, 200)}` : `Passed it to c${next}.`,
        );
        end(peer, request);
        return;
      }
      peer.say(sessionId, "ok");
      end(peer, request);
    })();
  },
});
