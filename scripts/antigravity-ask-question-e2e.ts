// Runs the real `antigravity` provider driver over a fake `agy acp` 1.5.15
// (`provider-fakes/agents/antigravity-ask-question.ts`) to check the card of Antigravity's
// `ask_question` tool. Antigravity sends one `elicitation/create` with the generic message "The agent has
// 3 questions.", one field per question titled with the question, and a `<id>_other` free-text field for
// each. The card showed that message on 6 pages and no options for a multi-select (Chopper, 23 Nov 2026).
// Checks: 3 pages, each with its own question and options, the multi-select as one; a pick answers
// with the schema's consts; a typed answer goes to `<id>_other`; no answer declines.
// `bun run test:antigravity-ask-question`. Writes .openbot-build/antigravity-ask-question-e2e/report.json.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentClient } from "../src/backend/agent-client";
import { getArray, getString, isRecord } from "../src/backend/protocol";
import { NO_PROVIDER_CREDENTIALS, requireProviderDriver } from "../src/backend/provider-drivers";
import { installFakeAgent, readJsonl, runTurn, startThread, stopClients } from "./provider-fakes/host";

const OUT = resolve(import.meta.dirname, "../.openbot-build/antigravity-ask-question-e2e");

interface Asked {
  id: string | null;
  question: string | null;
  detail: string | null;
  options: string[];
  multiSelect: boolean;
}

interface Case {
  reply: unknown;
  status: string | null;
}

interface Report {
  passed: boolean;
  asked?: Asked[];
  picked?: Case;
  typed?: Case;
  skipped?: Case;
  failure?: string;
}

const root = await mkdtemp(join(tmpdir(), "openbot-antigravity-ask-question-e2e-"));
const report: Report = { passed: false };
const clients: AgentClient[] = [];

try {
  const executable = join(root, "bin", "antigravity");
  const log = join(root, "agent.jsonl");
  await installFakeAgent(executable, "antigravity-ask-question", { FAKE_LOG: log });
  const client = requireProviderDriver("antigravity").createClient(
    { executable, version: "1.5.15", source: "managed" },
    10_000,
    NO_PROVIDER_CREDENTIALS,
  );
  clients.push(client);
  /** The answers of the next card, by question id, as the app sends them: labels, or typed text. */
  let answers: Readonly<Record<string, readonly string[]>> = {};
  let asked: Asked[] = [];
  client.on("request", (request) => {
    if (request.method !== "item/tool/requestUserInput") {
      client.respondError(request.id, { code: -32601, message: `The test does not answer ${request.method}.` });
      return;
    }
    asked = getArray(request.params, "questions")
      .filter(isRecord)
      .map((question) => ({
        id: getString(question, "id"),
        question: getString(question, "question"),
        detail: getString(question, "detail"),
        options: getArray(question, "options")
          .filter(isRecord)
          .map((option) => getString(option, "label") ?? ""),
        multiSelect: question.multiSelect === true,
      }));
    client.respond(request.id, {
      answers: Object.fromEntries(
        Object.entries(answers)
          .filter(([, values]) => values.length > 0)
          .map(([id, values]) => [id, { answers: values }]),
      ),
    });
  });
  client.start();
  const thread = await startThread(client, { cwd: root });

  const run = async (given: Readonly<Record<string, readonly string[]>>): Promise<Case> => {
    answers = given;
    const before = (await readJsonl<{ event: string; text?: string }>(log)).length;
    const turn = await runTurn(client, thread, { timeoutMs: 20_000 });
    const entry = (await readJsonl<{ event: string; text?: string }>(log))
      .slice(before)
      .find((e) => e.event === "reply");
    assert.ok(entry?.text, "The agent must get a reply to its questions.");
    assert.equal(turn.status, "completed");
    return { reply: JSON.parse(entry.text), status: turn.status };
  };

  report.picked = await run({ q1: ["Green"], q2: ["Banana", "Cherry"], q3: ["Anonymous"] });
  report.asked = asked;
  assert.deepEqual(
    asked.map(({ id, question, options, multiSelect }) => ({ id, question, options, multiSelect })),
    [
      { id: "q1", question: "Which color?", options: ["Red", "Green", "Blue"], multiSelect: false },
      {
        id: "q2",
        question: "Which fruits do you like?",
        options: ["Apple", "Banana", "Cherry", "Durian"],
        multiSelect: true,
      },
      { id: "q3", question: "What is your name?", options: ["Anonymous", "Prefer not to say"], multiSelect: false },
    ],
    "Each question must be one page with its own words and options; the `_other` fields make no page.",
  );
  // The request's "The agent has 3 questions." only counts the pages: no page shows it as its line.
  assert.deepEqual(
    asked.map(({ detail }) => detail),
    [null, null, null],
    "The generic count line must not show under a question.",
  );
  assert.deepEqual(report.picked.reply, { action: "accept", content: { q1: "2", q2: ["2", "3"], q3: "1" } });

  // "Something else": the typed text goes to `<id>_other`; the multi-select keeps its picked const.
  report.typed = await run({ q1: ["Purple"], q2: ["Apple", "Mango"], q3: ["Zed"] });
  assert.deepEqual(report.typed.reply, {
    action: "accept",
    content: { q1_other: "Purple", q2: ["1"], q2_other: "Mango", q3_other: "Zed" },
  });

  report.skipped = await run({});
  assert.deepEqual(report.skipped.reply, { action: "decline" });

  report.passed = true;
} catch (error) {
  report.failure = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.exitCode = 1;
} finally {
  await stopClients(clients);
  await mkdir(OUT, { recursive: true });
  await writeFile(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await rm(root, { recursive: true, force: true });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
