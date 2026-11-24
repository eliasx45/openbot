import { closeSync, openSync, readSync, statSync } from "node:fs";

const NL = "\n";
const control = process.env.FAKE_CONTROL ?? "";
let offset = 0;
let buffer = "";
let input = "";

function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

type Outgoing =
  | { id: number | string; result: unknown }
  | { id: number | string; error: { code: number; message: string } }
  | { method: string; params: unknown };

function write(message: Outgoing): void {
  process.stdout.write(`${JSON.stringify(message)}${NL}`);
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
    if (line.trim()) write(JSON.parse(line));
  }
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  input += chunk;
  for (let index = input.indexOf(NL); index >= 0; index = input.indexOf(NL)) {
    const line = input.slice(0, index);
    input = input.slice(index + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.id === undefined || typeof message.method !== "string") continue;
    const turnId = message.params?.expectedTurnId;
    if (message.method === "turn/steer" && turnId === "ended-turn")
      write({ id: message.id, error: { code: -32600, message: "no active turn to steer" } });
    else if (message.method === "turn/steer") write({ id: message.id, result: { turnId } });
    else write({ id: message.id, result: {} });
  }
});
process.stdin.on("end", () => process.exit(0));
setInterval(readControl, 10);
