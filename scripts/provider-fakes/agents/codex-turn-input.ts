import { appendFileSync } from "node:fs";

const NL = "\n";
const log = process.env.FAKE_LOG ?? "";
let input = "";
let threads = 0;
let turns = 0;

function write(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}${NL}`);
}

interface Incoming {
  id: number | string;
  method: string;
  params?: { threadId?: string; input?: unknown };
}

function answer(message: Incoming): void {
  const params = message.params ?? {};
  if (message.method === "thread/start") {
    threads += 1;
    appendFileSync(log, `${JSON.stringify({ method: message.method, params })}${NL}`);
    write({ id: message.id, result: { thread: { id: `thread-${threads}`, turns: [] } } });
    return;
  }
  if (message.method === "thread/resume") {
    appendFileSync(log, `${JSON.stringify({ method: message.method, params })}${NL}`);
    write({ id: message.id, result: { thread: { id: params.threadId, turns: [] } } });
    return;
  }
  if (message.method === "turn/start") {
    turns += 1;
    const turnId = `turn-${turns}`;
    appendFileSync(log, `${JSON.stringify({ method: message.method, input: params.input })}${NL}`);
    write({ id: message.id, result: { turn: { id: turnId, status: "inProgress", items: [] } } });
    write({ method: "turn/started", params: { threadId: params.threadId, turn: { id: turnId } } });
    write({
      method: "turn/completed",
      params: { threadId: params.threadId, turn: { id: turnId, status: "completed" } },
    });
    return;
  }
  write({ id: message.id, result: {} });
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  input += chunk;
  for (let index = input.indexOf(NL); index >= 0; index = input.indexOf(NL)) {
    const line = input.slice(0, index);
    input = input.slice(index + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.id !== undefined && typeof message.method === "string") answer(message);
  }
});
process.stdin.on("end", () => process.exit(0));
