// Load test for the `openbot.db` schema and the shared `agent-data.db`. It seeds a synthetic database
// at 1x, 10x, 100x and 1000x of a baseline user, then runs the app's own read and write paths
// (`OpenBotDatabase` and the stores, not copies of their SQL) and times each one.
//
//   node_modules/.bin/tsx scripts/db-load-test.ts --label=before [--scales=1,10,100,1000] [--reps=30]
//     [--warmup=5] [--ops=chat.,search.] [--reseed] [--build=<dir>] [--results=<dir>]
//
// For each scale:
// - The seed is made once with the schema of this checkout and kept under
//   `.openbot-build/db-load-test/seed-<scale>/` as a template. Each run clones the template (APFS
//   clone, so it costs no disk), opens the clone with `OpenBotDatabase`, and so runs every pending
//   migration on it. The time of that open is the upgrade time a user with that much data would see.
// - Each operation runs `--warmup` times, then `--reps` times, timed one by one. A write runs inside
//   `BEGIN` ... `ROLLBACK`, so every repeat sees the same data; the store's own transaction nests
//   in it, as `DatabaseCore.dispatch` allows.
// - One more run of each operation records every SQL statement that it prepares. Each statement then
//   gets `EXPLAIN QUERY PLAN`. A `SCAN` of a table with more than `SCAN_FLAG_ROWS` rows is flagged.
// - Every foreign key whose child columns no index leads with is listed: a parent delete scans the child.
//
// Writes `perf/results/<label>.json` with every sample. `scripts/db-load-test-report.ts` compares two.
// It never opens the app's own data directory: every database is a new file under `.openbot-build`.
import { execFileSync, spawn } from "node:child_process";
import { constants, copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { cpus, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import type { AgentSummary, AttachmentSummary, ConversationMessage } from "@openbot/contracts/ipc";
import { isAttachmentSummary } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import type {
  AgentDatabaseHostMessage,
  AgentDatabaseHostProcess,
} from "../src/backend/agent-data/agent-database-protocol";
import type { AgentDatabaseSupervisor } from "../src/backend/agent-data/agent-database-supervisor";
import { AgentRoutineStore } from "../src/backend/agent-routine-store";
import {
  databaseRow,
  databaseRows,
  decodeConversationMessageJson,
  requiredNumberColumn,
  requiredStringColumn,
} from "../src/backend/database/database-rows";
import { refreshThreadOrder } from "../src/backend/database/thread-message-order";
import { OpenBotDatabase } from "../src/backend/openbot-database";

const ROOT = resolve(import.meta.dirname, "..");
const argument = (name: string) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
// Both can point at another checkout, so a run of the code before a change shares the seeds of the run after it.
const BUILD = resolve(argument("build") ?? join(ROOT, ".openbot-build/db-load-test"));
const RESULTS = resolve(argument("results") ?? join(ROOT, "perf/results"));
/** Bump when the seed changes, so an old template is not reused. */
const SEED_VERSION = 6;
const SCAN_FLAG_ROWS = 10_000;
const NOW = Date.parse("2026-11-01T12:00:00.000Z");

// ---------------------------------------------------------------------------------------------------
// The baseline (1x): one person who has used OpenBot daily for about three months.
// Each relationship grows so that every table holds N times its baseline rows. A chain of three
// (agent -> thread -> message) grows N^(1/3) per link; a chain of two (agent -> memory) grows the
// child by N^(2/3). The main chat of an agent, its longest-lived thread, takes the N^(2/3) share.
// ---------------------------------------------------------------------------------------------------
export const BASELINE = {
  agents: 8,
  mainChatMessagesPerAgent: 400,
  sideThreadsPerAgent: 5,
  messagesPerSideThread: 40,
  memoriesPerAgent: 30,
  /** The highest per-agent memory limit that settings offer (`AGENT_MEMORY_LIMITS`). */
  memoryCap: 512,
  routinesPerAgent: 2,
  runsPerRoutine: 30,
  /** A user message at a thread position that is a multiple of twice this has a file: about 1 message in 60. */
  attachmentEvery: 30,
  dataTables: 4,
  dataRowsPerTable: 250,
} as const;

export interface ScalePlan {
  scale: number;
  agents: number;
  mainChatMessagesPerAgent: number;
  sideThreadsPerAgent: number;
  messagesPerSideThread: number;
  memoriesPerAgent: number;
  routinesPerAgent: number;
  runsPerRoutine: number;
  dataRowsPerTable: number;
}

export function planFor(scale: number): ScalePlan {
  const s1 = scale ** (1 / 3);
  const s2 = scale ** (2 / 3);
  return {
    scale,
    agents: Math.round(BASELINE.agents * s1),
    mainChatMessagesPerAgent: Math.round(BASELINE.mainChatMessagesPerAgent * s2),
    sideThreadsPerAgent: Math.round(BASELINE.sideThreadsPerAgent * s1),
    messagesPerSideThread: Math.round(BASELINE.messagesPerSideThread * s1),
    memoriesPerAgent: Math.min(BASELINE.memoryCap, Math.round(BASELINE.memoriesPerAgent * s2)),
    routinesPerAgent: Math.round(BASELINE.routinesPerAgent * s1),
    runsPerRoutine: Math.round(BASELINE.runsPerRoutine * s1),
    dataRowsPerTable: BASELINE.dataRowsPerTable * scale,
  };
}

// ---------------------------------------------------------------------------------------------------
// Deterministic text: the same seed gives the same database on every machine.
// ---------------------------------------------------------------------------------------------------
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Common words often, rare words seldom, as in real text (a Zipf-like draw).
const WORDS = (
  "the a to and of in is it that for on with as this be at by from or have are not you we your can will " +
  "file build test run code fix change agent message thread routine memory task plan check update open " +
  "user data table schema query index page list search result error log report deploy release branch commit " +
  "review design note meeting schedule weekly invoice budget customer email draft summary video edit render " +
  "timeline export frame audio caption script import config server client token cache sync backup restore " +
  "migration latency throughput benchmark sqlite cursor window badge sidebar kraków quarterly reconcile ledger " +
  "photosynthesis zeppelin quokka marzipan"
).split(" ");

function text(random: () => number, words: number): string {
  const out: string[] = [];
  for (let i = 0; i < words; i += 1) {
    const r = random();
    out.push(WORDS[Math.floor(r * r * r * WORDS.length)] ?? "the");
  }
  const sentence = out.join(" ");
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

// ---------------------------------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------------------------------
function agentSummary(index: number): AgentSummary {
  const id = `agent-${String(index).padStart(4, "0")}`;
  return {
    id,
    provider: index % 3 === 0 ? "claude" : "codex",
    name: `Agent ${index}`,
    title: "Assistant",
    description: "",
    notifications: true,
    model: index % 3 === 0 ? "claude-opus-5-5" : "gpt-5.6-luna",
    reasoningEffort: "medium",
    threadId: `openbot-thread-${id}`,
    workspacePath: `/tmp/openbot-load/${id}`,
    preview: "",
    updatedAt: iso(NOW - index * 60_000),
    avatarSeed: id,
    avatarHue: null,
    avatarUrl: null,
  };
}

interface SeedContext {
  db: DatabaseSync;
  random: () => number;
  sequence: number;
  insertMessage: ReturnType<DatabaseSync["prepare"]>;
  insertEvent: ReturnType<DatabaseSync["prepare"]>;
  insertReceipt: ReturnType<DatabaseSync["prepare"]>;
  insertActivity: ReturnType<DatabaseSync["prepare"]>;
  insertTurn: ReturnType<DatabaseSync["prepare"]>;
  insertAttachment: ReturnType<DatabaseSync["prepare"]>;
  insertSession: ReturnType<DatabaseSync["prepare"]>;
}

/** A provider session lasts this many turns: a model change, a compaction or a reset starts a new one. */
const TURNS_PER_PROVIDER_SESSION = 200;

/**
 * One thread of `count` messages, in turns of a user message, sometimes a commentary row, and the
 * answer. Every message also leaves the append event, its receipt and an activity row, as
 * `appendConversationMessage` and `persistConversationChanges` do; those are not compacted away.
 */
function seedThreadMessages(context: SeedContext, threadId: string, count: number, startMs: number): void {
  const { random } = context;
  let written = 0;
  let turn = 0;
  let at = startMs;
  let sessionId: string | null = null;
  while (written < count) {
    turn += 1;
    const turnId = `${threadId}:turn-${turn}`;
    if ((turn - 1) % TURNS_PER_PROVIDER_SESSION === 0) {
      sessionId = `session-${threadId}-${turn}`;
      context.insertSession.run(sessionId, threadId, `external-${sessionId}`, iso(at), iso(at), context.sequence);
    }
    const turnStart = at;
    const rows: { author: ConversationMessage["author"]; itemType: string | null; words: number }[] = [
      { author: "user", itemType: null, words: 12 + Math.floor(random() * 30) },
    ];
    if (random() < 0.5)
      rows.push({ author: "assistant", itemType: "commentary", words: 20 + Math.floor(random() * 40) });
    rows.push({ author: "assistant", itemType: null, words: 60 + Math.floor(random() * 220) });
    for (const row of rows) {
      if (written >= count) break;
      at += 1_000 + Math.floor(random() * 20_000);
      context.sequence += 1;
      const messageId = `m-${threadId.slice(-12)}-${written}`;
      const message: ConversationMessage = {
        id: messageId,
        turnId,
        author: row.author,
        text: text(random, row.words),
        createdAt: iso(at),
        status: "completed",
        source: row.author === "user" ? "user" : "assistant",
      };
      if (row.itemType) message.itemType = row.itemType;
      if (row.author === "user" && written % (BASELINE.attachmentEvery * 2) === 0) {
        const attachment: AttachmentSummary = {
          id: `att-${written}`,
          name: `${text(random, 2).toLowerCase().replace(/ /g, "-")}-report-${written}.pdf`,
          size: 20_000 + Math.floor(random() * 2_000_000),
          kind: "file",
          mimeType: "application/pdf",
          previewKind: "pdf",
          previewUrl: null,
        };
        message.attachments = [attachment];
        context.insertAttachment.run(
          `${threadId}:${messageId}:${attachment.id}`,
          `${threadId}:${messageId}`,
          attachment.name,
          JSON.stringify(attachment),
          iso(at),
          context.sequence,
        );
      }
      const json = JSON.stringify(message);
      context.insertMessage.run(
        threadId,
        messageId,
        turnId,
        row.author,
        "completed",
        row.itemType,
        iso(at),
        written,
        json,
        context.sequence,
      );
      const commandId = `conversation:message-appended:${threadId}:${written}`;
      context.insertEvent.run(
        `event-${context.sequence}`,
        commandId,
        threadId,
        "conversation.message-appended",
        iso(at),
        JSON.stringify({ detail: {}, appendedMessage: message, activeTurnId: turnId }),
      );
      context.insertReceipt.run(commandId, iso(at), context.sequence, context.sequence);
      context.insertActivity.run(
        `activity-${context.sequence}`,
        threadId,
        turnId,
        "conversation.message-appended",
        "{}",
        iso(at),
        context.sequence,
      );
      written += 1;
    }
    context.insertTurn.run(turnId, threadId, sessionId, "completed", iso(turnStart), iso(at), context.sequence);
    at += 60_000 + Math.floor(random() * 3_600_000);
  }
  // The newest session of a thread is the one that the next turn resumes.
  if (sessionId)
    context.db.prepare("UPDATE projection_provider_sessions SET state = 'active' WHERE id = ?").run(sessionId);
}

async function seed(plan: ScalePlan, directory: string): Promise<{ seconds: number }> {
  const started = performance.now();
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  const database = new OpenBotDatabase(directory);
  await Effect.runPromise(database.initialize());
  const agents = Array.from({ length: plan.agents }, (_, index) => agentSummary(index));
  database.replaceAgents("seed:agents", agents, "agents.replaced");
  const db = database.connection;
  const random = prng(plan.scale * 7919 + SEED_VERSION);
  const context: SeedContext = {
    db,
    random,
    sequence: Number(databaseRow(db.prepare("SELECT MAX(sequence) AS s FROM orchestration_events").get())?.s ?? 0) + 10,
    insertMessage: db.prepare(
      `INSERT INTO projection_thread_messages (thread_id, message_id, turn_id, author, status, item_type, created_at,
         ordinal, message_json, last_event_sequence) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    insertEvent: db.prepare(
      `INSERT INTO orchestration_events (event_id, command_id, aggregate_type, aggregate_id, event_type, occurred_at, payload_json)
       VALUES (?, ?, 'thread', ?, ?, ?, ?)`,
    ),
    insertReceipt: db.prepare(
      `INSERT INTO orchestration_command_receipts (command_id, accepted_at, first_sequence, last_sequence, result_json)
       VALUES (?, ?, ?, ?, '{}')`,
    ),
    insertActivity: db.prepare(
      `INSERT INTO projection_thread_activities (activity_id, thread_id, turn_id, activity_type, payload_json, created_at,
         last_event_sequence) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ),
    insertTurn: db.prepare(
      `INSERT INTO projection_turns (turn_id, thread_id, provider_session_id, status, started_at, completed_at, last_event_sequence)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ),
    insertAttachment: db.prepare(
      `INSERT INTO projection_attachments (attachment_id, owner_kind, owner_id, name, path, metadata_json, created_at, last_event_sequence)
       VALUES (?, 'thread-message', ?, ?, '', ?, ?, ?)`,
    ),
    insertSession: db.prepare(
      `INSERT INTO projection_provider_sessions (id, thread_id, provider, external_session_id, model, effort, state,
         created_at, updated_at, resume_cursor, last_event_sequence)
       VALUES (?, ?, 'codex', ?, 'gpt-5.6-luna', 'medium', 'inactive', ?, ?, NULL, ?)`,
    ),
  };
  const insertThread = db.prepare(
    `INSERT OR IGNORE INTO projection_threads (thread_id, agent_id, title, active_turn_id, created_at, updated_at, last_event_sequence)
     VALUES (?, ?, ?, NULL, ?, ?, ?)`,
  );
  const insertSideThread = db.prepare(
    `INSERT INTO projection_agent_threads (thread_id, agent_id, legacy_task_id, origin, title, title_source, outcome, error,
       created_at, updated_at, archived_at, last_event_sequence) VALUES (?, ?, NULL, ?, ?, 'auto', ?, NULL, ?, ?, ?, ?)`,
  );
  const insertMemory = db.prepare(
    `INSERT INTO projection_agent_memories (memory_id, agent_id, text, normalized_text, origin, source_turn_id, created_at,
       updated_at, last_event_sequence) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
  );
  const insertRoutine = db.prepare(
    `INSERT INTO projection_agent_routines (routine_id, agent_id, name, instruction, active, timezone, created_at, updated_at,
       last_event_sequence) VALUES (?, ?, ?, ?, ?, 'Europe/Warsaw', ?, ?, ?)`,
  );
  const insertTrigger = db.prepare(
    `INSERT INTO projection_routine_triggers (trigger_id, routine_id, schedule_json, next_run_at, created_at, updated_at,
       last_event_sequence) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertRun = db.prepare(
    `INSERT INTO projection_routine_runs (run_id, routine_id, agent_id, trigger_id, run_kind, scheduled_for, routine_name,
       instruction, delivery_id, status, error, created_at, updated_at, last_event_sequence, run_source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
  );
  const historyStart = NOW - 90 * 86_400_000 * Math.max(1, plan.scale ** (1 / 3));
  const threadIds: string[] = [];
  for (const agent of agents) {
    db.exec("BEGIN");
    const threadId = agent.threadId ?? "";
    insertThread.run(threadId, agent.id, agent.name, iso(historyStart), iso(NOW), context.sequence);
    threadIds.push(threadId);
    seedThreadMessages(context, threadId, plan.mainChatMessagesPerAgent, historyStart);
    for (let side = 0; side < plan.sideThreadsPerAgent; side += 1) {
      const sideId = `side-${agent.id}-${String(side).padStart(4, "0")}`;
      const created = historyStart + Math.floor(random() * (NOW - historyStart));
      insertThread.run(sideId, agent.id, `Side ${side}`, iso(created), iso(created), context.sequence);
      insertSideThread.run(
        sideId,
        agent.id,
        side % 3 === 0 ? "agent" : "user",
        text(random, 4),
        side % 4 === 0 ? "completed" : null,
        iso(created),
        iso(created + 3_600_000),
        side % 2 === 0 ? iso(created + 7_200_000) : null,
        context.sequence,
      );
      threadIds.push(sideId);
      seedThreadMessages(context, sideId, plan.messagesPerSideThread, created);
    }
    for (let memory = 0; memory < plan.memoriesPerAgent; memory += 1) {
      const body = `${text(random, 8 + Math.floor(random() * 20))}.`;
      const created = iso(historyStart + Math.floor(random() * (NOW - historyStart)));
      context.sequence += 1;
      insertMemory.run(
        `memory-${agent.id}-${memory}`,
        agent.id,
        body,
        `${body.toLowerCase()} ${memory}`,
        memory % 4 === 0 ? "manual" : "automatic",
        created,
        created,
        context.sequence,
      );
    }
    for (let routine = 0; routine < plan.routinesPerAgent; routine += 1) {
      const routineId = `routine-${agent.id}-${routine}`;
      const triggerId = `trigger-${routineId}`;
      const name = `Routine ${routine}`;
      const instruction = text(random, 15);
      insertRoutine.run(
        routineId,
        agent.id,
        name,
        instruction,
        routine % 5 === 4 ? 0 : 1,
        iso(historyStart),
        iso(historyStart),
        context.sequence,
      );
      insertTrigger.run(
        triggerId,
        routineId,
        JSON.stringify({ kind: "weekly", weekday: routine % 7, time: "09:00" }),
        iso(NOW + (routine + 1) * 3_600_000),
        iso(historyStart),
        iso(historyStart),
        context.sequence,
      );
      for (let run = 0; run < plan.runsPerRoutine; run += 1) {
        const scheduled = iso(NOW - (plan.runsPerRoutine - run) * 86_400_000);
        const status =
          run === plan.runsPerRoutine - 1 && routine === 0 ? "queued" : random() < 0.08 ? "failed" : "succeeded";
        insertRun.run(
          `run-${routineId}-${run}`,
          routineId,
          agent.id,
          triggerId,
          "scheduled",
          scheduled,
          name,
          instruction,
          `delivery-${routineId}-${run}`,
          status,
          scheduled,
          scheduled,
          context.sequence,
          null,
        );
      }
    }
    db.exec("COMMIT");
  }
  // The shown-order keys come from the app's own code, as every write computes them.
  db.exec("BEGIN");
  for (const threadId of threadIds) refreshThreadOrder(db, threadId);
  db.exec("COMMIT");
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  // The app's own decoders must accept every seeded row, or a read fails or skips work.
  for (const row of databaseRows(db.prepare("SELECT message_json FROM projection_thread_messages LIMIT 20000").all())) {
    decodeConversationMessageJson(requiredStringColumn(row, "message_json"));
  }
  for (const row of databaseRows(db.prepare("SELECT metadata_json FROM projection_attachments LIMIT 1000").all())) {
    if (!isAttachmentSummary(JSON.parse(requiredStringColumn(row, "metadata_json"))))
      throw new Error("A seeded attachment is not an AttachmentSummary.");
  }
  for (const agent of agents) new AgentRoutineStore(database).list(agent.id);
  database.close();
  seedAgentData(plan, directory);
  return { seconds: (performance.now() - started) / 1000 };
}

/** The shared tables that agents keep with the openbot-data skill: people, tasks, messages, results. */
function seedAgentData(plan: ScalePlan, directory: string): void {
  const dataDirectory = join(directory, "shared/Data");
  mkdirSync(dataDirectory, { recursive: true });
  const db = new DatabaseSync(join(dataDirectory, "agent-data.db"));
  const random = prng(plan.scale * 104_729);
  db.exec(`PRAGMA journal_mode = WAL;
    CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT, company TEXT, notes TEXT, created_at TEXT NOT NULL);
    CREATE TABLE tasks (id INTEGER PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL, owner TEXT, due_at TEXT, created_at TEXT NOT NULL);
    CREATE TABLE handled_messages (id INTEGER PRIMARY KEY, channel TEXT NOT NULL, sender TEXT, summary TEXT, handled_at TEXT NOT NULL);
    CREATE TABLE results (id INTEGER PRIMARY KEY, run TEXT NOT NULL, metric TEXT NOT NULL, value REAL, recorded_at TEXT NOT NULL);`);
  const statements = [
    db.prepare("INSERT INTO people (name, email, company, notes, created_at) VALUES (?, ?, ?, ?, ?)"),
    db.prepare("INSERT INTO tasks (title, status, owner, due_at, created_at) VALUES (?, ?, ?, ?, ?)"),
    db.prepare("INSERT INTO handled_messages (channel, sender, summary, handled_at) VALUES (?, ?, ?, ?)"),
    db.prepare("INSERT INTO results (run, metric, value, recorded_at) VALUES (?, ?, ?, ?)"),
  ] as const;
  db.exec("BEGIN");
  for (let row = 0; row < plan.dataRowsPerTable; row += 1) {
    const at = iso(NOW - Math.floor(random() * 365 * 86_400_000));
    statements[0].run(`Person ${row}`, `person${row}@example.com`, text(random, 2), text(random, 10), at);
    statements[1].run(text(random, 6), ["open", "done", "blocked"][row % 3] ?? "open", `agent-${row % 8}`, at, at);
    statements[2].run(["slack", "email", "telegram"][row % 3] ?? "email", `sender-${row % 500}`, text(random, 14), at);
    statements[3].run(
      `run-${Math.floor(row / 10)}`,
      ["latency", "tokens", "cost"][row % 3] ?? "cost",
      random() * 1000,
      at,
    );
  }
  db.exec("COMMIT");
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
}

// ---------------------------------------------------------------------------------------------------
// Measuring
// ---------------------------------------------------------------------------------------------------
interface Operation {
  name: string;
  area: string;
  description: string;
  write?: boolean;
  run: () => unknown | Promise<unknown>;
}

interface PlanEntry {
  sql: string;
  plan: string[];
  flagged: string[];
}

export interface OperationResult {
  area: string;
  description: string;
  write: boolean;
  samplesMs: number[];
  p50: number;
  p95: number;
  mean: number;
  statements: number;
  plans: PlanEntry[];
}

export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const rank = (p / 100) * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  const lowValue = sorted[low] ?? Number.NaN;
  const highValue = sorted[high] ?? Number.NaN;
  return lowValue + (highValue - lowValue) * (rank - low);
}

function log(line: string): void {
  process.stdout.write(`${line}\n`);
}

let capture: string[] | null = null;
const originalPrepare = DatabaseSync.prototype.prepare;
DatabaseSync.prototype.prepare = function prepare(this: DatabaseSync, ...args: Parameters<DatabaseSync["prepare"]>) {
  capture?.push(args[0]);
  return originalPrepare.apply(this, args);
};

function explain(db: DatabaseSync, sql: string, rowCounts: Record<string, number>): PlanEntry {
  try {
    const rows = databaseRows(originalPrepare.call(db, `EXPLAIN QUERY PLAN ${sql}`).all());
    const plan = rows.map((row) => requiredStringColumn(row, "detail"));
    const flagged = plan.filter((detail) => {
      const match = /^SCAN (\w+)/.exec(detail);
      if (!match?.[1]) return false;
      // An alias names the table in the plan; look it up by the alias's table in the SQL.
      const name = match[1];
      const table = rowCounts[name] !== undefined ? name : aliasTable(sql, name);
      return table !== null && (rowCounts[table] ?? 0) > SCAN_FLAG_ROWS;
    });
    return { sql: compact(sql), plan, flagged };
  } catch (error) {
    return {
      sql: compact(sql),
      plan: [`(no plan: ${String(error instanceof Error ? error.message : error)})`],
      flagged: [],
    };
  }
}

function aliasTable(sql: string, alias: string): string | null {
  const match = new RegExp(`(\\w+)\\s+(?:AS\\s+)?${alias}\\b`, "i").exec(sql.replace(/\s+/g, " "));
  return match?.[1] ?? null;
}

function compact(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

async function timeOnce(operation: Operation, db: DatabaseSync): Promise<number> {
  if (operation.write) db.exec("BEGIN");
  const started = process.hrtime.bigint();
  try {
    await operation.run();
    return Number(process.hrtime.bigint() - started) / 1e6;
  } finally {
    if (operation.write) db.exec("ROLLBACK");
  }
}

function rowCountsOf(db: DatabaseSync): Record<string, number> {
  const counts: Record<string, number> = {};
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND sql NOT LIKE 'CREATE VIRTUAL%'",
    )
    .all();
  for (const name of databaseRows(tables).map((row) => requiredStringColumn(row, "name"))) {
    const row = databaseRow(db.prepare(`SELECT COUNT(*) AS c FROM "${name}"`).get());
    counts[name] = row ? requiredNumberColumn(row, "c") : 0;
  }
  return counts;
}

/** Foreign keys whose child columns no index starts with. A delete of a parent row scans the child table. */
function unindexedForeignKeys(db: DatabaseSync, rowCounts: Record<string, number>) {
  const result: { child: string; columns: string[]; parent: string; onDelete: string; childRows: number }[] = [];
  for (const table of Object.keys(rowCounts)) {
    const keys = databaseRows(db.prepare("SELECT * FROM pragma_foreign_key_list(?)").all(table));
    const byId = new Map<number, { parent: string; columns: string[]; onDelete: string }>();
    for (const key of keys) {
      const id = requiredNumberColumn(key, "id");
      const entry = byId.get(id) ?? {
        parent: requiredStringColumn(key, "table"),
        columns: [],
        onDelete: requiredStringColumn(key, "on_delete"),
      };
      entry.columns.push(requiredStringColumn(key, "from"));
      byId.set(id, entry);
    }
    const names = (sql: string, name: string) =>
      databaseRows(db.prepare(sql).all(name)).map((row) => requiredStringColumn(row, "name"));
    const indexes = names("SELECT name FROM pragma_index_list(?)", table).map((index) =>
      names("SELECT name FROM pragma_index_info(?) ORDER BY seqno", index),
    );
    // A rowid alias or INTEGER PRIMARY KEY is not in the index list; a TEXT PRIMARY KEY is (autoindex).
    for (const entry of byId.values()) {
      const covered = indexes.some((columns) => entry.columns.every((column, index) => columns[index] === column));
      if (!covered)
        result.push({
          child: table,
          columns: entry.columns,
          parent: entry.parent,
          onDelete: entry.onDelete,
          childRows: rowCounts[table] ?? 0,
        });
    }
  }
  return result;
}

function stdioHost(host: string): AgentDatabaseHostProcess {
  const child = spawn("node", [host], { stdio: ["pipe", "pipe", "inherit"] });
  const listeners: ((message: AgentDatabaseHostMessage) => void)[] = [];
  createInterface({ input: child.stdout }).on("line", (line) => {
    const message: AgentDatabaseHostMessage = JSON.parse(line);
    for (const listener of listeners) listener(message);
  });
  return {
    send: (request) => child.stdin.write(`${JSON.stringify(request)}\n`),
    onMessage: (listener) => listeners.push(listener),
    onExit: (listener) => child.once("exit", () => listener()),
    kill: () => child.kill("SIGKILL"),
  };
}

/**
 * The app modules of one checkout. Each checkout is its own module graph, with its own `effect`, so the code before
 * a change and the code after it run in one process, side by side.
 */
async function loadModules(root: string) {
  const load = (path: string) => import(pathToFileURL(join(root, path)).href);
  const effect: typeof import("effect") = await import(
    pathToFileURL(createRequire(join(root, "src/backend/index.ts")).resolve("effect")).href
  );
  const database: typeof import("../src/backend/openbot-database") = await load("src/backend/openbot-database.ts");
  const threads: typeof import("../src/backend/agent-threads/agent-thread-store") = await load(
    "src/backend/agent-threads/agent-thread-store.ts",
  );
  const memories: typeof import("../src/backend/agent-memory-store") = await load("src/backend/agent-memory-store.ts");
  const routines: typeof import("../src/backend/agent-routine-store") = await load(
    "src/backend/agent-routine-store.ts",
  );
  const reads: typeof import("../src/backend/conversation-read-store") = await load(
    "src/backend/conversation-read-store.ts",
  );
  const tables: typeof import("../src/backend/agent-data/agent-tables") = await load(
    "src/backend/agent-data/agent-tables.ts",
  );
  const supervisor: typeof import("../src/backend/agent-data/agent-database-supervisor") = await load(
    "src/backend/agent-data/agent-database-supervisor.ts",
  );
  return {
    root,
    runPromise: (value: Effect.Effect<unknown, unknown>): Promise<unknown> => effect.Effect.runPromise(value),
    OpenBotDatabase: database.OpenBotDatabase,
    AgentThreadStore: threads.AgentThreadStore,
    AgentMemoryStore: memories.AgentMemoryStore,
    AgentRoutineStore: routines.AgentRoutineStore,
    ConversationReadStore: reads.ConversationReadStore,
    AgentTables: tables.AgentTables,
    AgentDatabaseSupervisor: supervisor.AgentDatabaseSupervisor,
  };
}

type Modules = Awaited<ReturnType<typeof loadModules>>;

/** A clone of the seed opened by one checkout's code: its upgrade runs here, and its open time is measured. */
async function openArm(modules: Modules, plan: ScalePlan, seedDirectory: string, work: string) {
  rmSync(work, { recursive: true, force: true });
  mkdirSync(join(work, "shared/Data"), { recursive: true });
  // An APFS clone: instant, and the template stays as it is.
  copyFileSync(join(seedDirectory, "openbot.db"), join(work, "openbot.db"), constants.COPYFILE_FICLONE);
  copyFileSync(
    join(seedDirectory, "shared/Data/agent-data.db"),
    join(work, "shared/Data/agent-data.db"),
    constants.COPYFILE_FICLONE,
  );
  const fileBytes = statSync(join(work, "openbot.db")).size;
  const database = new modules.OpenBotDatabase(work);
  const openStarted = performance.now();
  await modules.runPromise(database.initialize());
  const openMs = performance.now() - openStarted;
  const db = database.connection;
  const schemaVersion = Number(databaseRow(db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get())?.v);
  const rowCounts = rowCountsOf(db);
  const supervisor = new modules.AgentDatabaseSupervisor({
    spawnHost: () => stdioHost(join(modules.root, "src/backend/agent-data/agent-database-host.ts")),
  });
  const operations = buildOperations(modules, plan, database, supervisor, work);
  return { database, db, supervisor, operations, openMs, schemaVersion, fileBytes, rowCounts };
}

type Arm = Awaited<ReturnType<typeof openArm>>;

function buildOperations(
  modules: Modules,
  plan: ScalePlan,
  database: OpenBotDatabase,
  supervisor: AgentDatabaseSupervisor,
  work: string,
): Operation[] {
  const db = database.connection;
  const threads = new modules.AgentThreadStore(database);
  const memories = new modules.AgentMemoryStore(database, () => 512);
  const routines = new modules.AgentRoutineStore(database);
  const reads = new modules.ConversationReadStore(database);
  const tables = new modules.AgentTables({ sharedRoot: join(work, "shared"), supervisor });

  const agents = database.listAgents();
  const agent = agents[0];
  if (!agent?.threadId) throw new Error("The seed has no agent.");
  const mainThread = agent.threadId;
  const side = threads.list(agent.id)[0];
  if (!side) throw new Error("The seed has no side thread.");
  const middle = databaseRow(
    db
      .prepare(
        "SELECT message_id FROM projection_thread_messages WHERE thread_id = ? ORDER BY created_at LIMIT 1 OFFSET ?",
      )
      .get(mainThread, Math.floor(plan.mainChatMessagesPerAgent / 2)),
  );
  if (!middle) throw new Error("The main chat has no middle message.");
  const middleId = requiredStringColumn(middle, "message_id");
  const aroundPage = database.readConversationPage(agent.id, mainThread, { type: "around", messageId: middleId }, 50);
  const middleCursor = aroundPage.pageInfo.olderCursor;
  if (!middleCursor) throw new Error("The middle of the main chat has no older page.");
  const routine = routines.list(agent.id)[0];
  if (!routine) throw new Error("The seed has no routine.");
  const sideSnapshot = database.readConversation(agent.id, side.threadId);
  const streamedId = sideSnapshot.messages.at(-1)?.id ?? "";
  let appended = 0;
  // A person reads their chats: each agent's chat is read up to 10 messages before its end, through the app's API.
  const READER = "load-test-member";
  const readThrough = db.prepare(
    "SELECT message_id FROM projection_thread_messages WHERE thread_id = ? ORDER BY created_at DESC, ordinal DESC LIMIT 1 OFFSET 10",
  );
  for (const each of agents) {
    const row = databaseRow(readThrough.get(each.threadId));
    if (row) reads.markReadForThread(READER, each.threadId, requiredStringColumn(row, "message_id"));
  }
  const selectionChanges = memories
    .listSelections(agent.id)
    .slice(0, 10)
    .map((selection) => ({
      memoryId: selection.memoryId,
      inclusion: "searchable" as const,
      expectedRevision: selection.revision,
    }));
  const run = (effect: Effect.Effect<unknown, unknown>) => modules.runPromise(effect);
  return [
    // Sidebar and agent lists: what the window shows first.
    {
      area: "sidebar",
      name: "sidebar.listAgents",
      description: "Agent roster (listAgents)",
      run: () => database.listAgents(),
    },
    {
      area: "sidebar",
      name: "sidebar.unreadStates",
      description: "Unread badge of every agent chat, each read up to 10 messages ago (listStates)",
      run: () => reads.listStates(READER, agents),
    },
    {
      area: "sidebar",
      name: "sidebar.unreadNeverRead",
      description: "Unread badge of every agent chat, none ever read: worst case (listStates)",
      run: () => reads.listStates("load-test-new-device", agents),
    },
    {
      area: "sidebar",
      name: "sidebar.sideThreads",
      description: "Side threads of one agent (AgentThreadStore.list)",
      run: () => threads.list(agent.id),
    },
    {
      area: "sidebar",
      name: "sidebar.openSideThreads",
      description: "Open side threads of all agents, boot (openExecutionThreads)",
      run: () => threads.openExecutionThreads(),
    },
    // Chat and message history.
    {
      area: "chat",
      name: "chat.openLatestPage",
      description: "Open the main chat: newest page of 50",
      run: () => database.readConversationPage(agent.id, mainThread, { type: "latest" }, 50),
    },
    {
      area: "chat",
      name: "chat.scrollOlderPage",
      description: "Scroll up from the middle of the main chat (before cursor)",
      run: () => database.readConversationPage(agent.id, mainThread, { type: "before", cursor: middleCursor }, 50),
    },
    {
      area: "chat",
      name: "chat.jumpToMessage",
      description: "Open a search result in the middle of the chat (around anchor)",
      run: () => database.readConversationPage(agent.id, mainThread, { type: "around", messageId: middleId }, 50),
    },
    {
      area: "chat",
      name: "chat.runtime",
      description: "Active turn and latest answer (readConversationRuntime)",
      run: () => database.readConversationRuntime(agent.id, mainThread),
    },
    {
      area: "chat",
      name: "chat.fullSnapshot",
      description: "Whole main chat (readConversation)",
      run: () => database.readConversation(agent.id, mainThread),
    },
    {
      area: "chat",
      name: "chat.recoveryMessages",
      description: "Restart recovery read of the main chat (readConversationRecoveryMessages)",
      run: () => database.readConversationRecoveryMessages(agent.id, mainThread, null),
    },
    {
      area: "chat",
      name: "chat.turnAnswer",
      description: "Answer of one turn for a routine flow (readTurnAssistantMessages)",
      run: () => database.readTurnAssistantMessages(agent.id, `${mainThread}:turn-2`),
    },
    {
      area: "chat",
      name: "boot.runningTurns",
      description: "Turns still running, boot (readRunningTurnIds)",
      run: () => database.readRunningTurnIds(),
    },
    {
      area: "chat",
      name: "stats.sentMessages",
      description: "Messages sent by the user (readSentMessageStats)",
      run: () => database.readSentMessageStats(),
    },
    // Search.
    {
      area: "search",
      name: "search.messagesAll",
      description: "Search all chats for a word",
      run: () => database.searchConversationMessages("quarterly"),
    },
    {
      area: "search",
      name: "search.messagesAgent",
      description: "Search one agent's chats for a word",
      run: () => database.searchConversationMessages("quarterly", agent.id),
    },
    {
      area: "search",
      name: "search.files",
      description: "Search files by name",
      run: () => database.searchConversationFiles("report"),
    },
    // Memories.
    {
      area: "memory",
      name: "memory.list",
      description: "Memories of one agent (list)",
      run: () => memories.list(agent.id),
    },
    {
      area: "memory",
      name: "memory.search",
      description: "search_memories tool (FTS5)",
      run: () => memories.search(agent.id, "weekly schedule deploy", 5),
    },
    {
      area: "memory",
      name: "memory.listPage",
      description: "list_memories tool, first page",
      run: () => memories.listPage(agent.id),
    },
    {
      area: "memory",
      name: "memory.selectionState",
      description: "Memory settings panel (selectionState)",
      run: () => memories.selectionState(agent.id),
    },
    {
      area: "memory",
      name: "memory.setInclusions",
      description: "Change the inclusion of 10 memories (setInclusions)",
      write: true,
      run: () => memories.setInclusions(agent.id, selectionChanges, "user"),
    },
    // Routines and runs.
    {
      area: "routines",
      name: "routines.list",
      description: "Routines of one agent",
      run: () => routines.list(agent.id),
    },
    {
      area: "routines",
      name: "routines.runs",
      description: "Run history of one routine (listRuns 50)",
      run: () => routines.listRuns(agent.id, routine.id, 50),
    },
    {
      area: "routines",
      name: "routines.pendingRuns",
      description: "Queued and running runs, boot (pendingRuns)",
      run: () => routines.pendingRuns(),
    },
    {
      area: "routines",
      name: "routines.due",
      description: "Scheduler tick (due)",
      run: () => routines.due(new Date(NOW)),
    },
    // Events.
    {
      area: "events",
      name: "events.hasAggregate",
      description: "Has a thread any event (hasAggregateEvents)",
      run: () => database.hasAggregateEvents("thread", mainThread),
    },
    // Shared tables (openbot-data), through the real host process.
    {
      area: "tables",
      name: "tables.list",
      description: "list_tables / settings: tables with row counts",
      run: () => run(tables.list()),
    },
    {
      area: "tables",
      name: "tables.query",
      description: "query_data: open tasks of one owner",
      run: () =>
        run(
          tables.query(
            "SELECT id, title, due_at FROM tasks WHERE status = ? AND owner = ? ORDER BY due_at DESC LIMIT 50",
            ["open", "agent-1"],
          ),
        ),
    },
    // Writes, rolled back after each repeat.
    {
      area: "writes",
      name: "write.appendMessage",
      description: "Send a message to the main chat (appendConversationMessage)",
      write: true,
      run: () => {
        appended += 1;
        return database.appendConversationMessage({
          agentId: agent.id,
          threadId: mainThread,
          activeTurnId: null,
          eventType: "conversation.user-message",
          message: {
            id: `load-${appended}`,
            author: "user",
            text: "Load test message",
            createdAt: iso(NOW + appended),
            status: "completed",
          },
        });
      },
    },
    {
      area: "writes",
      name: "write.streamFlush",
      description: "Streamed text flush of a side-thread answer (persistStreamingMessage)",
      write: true,
      run: () =>
        database.persistStreamingMessage({
          snapshot: sideSnapshot,
          messageId: streamedId,
          eventType: "conversation.message-streamed",
        }),
    },
    {
      area: "writes",
      name: "write.snapshotPersist",
      description: "Whole-snapshot write of a side thread (persistConversation)",
      write: true,
      run: () => database.persistConversation(sideSnapshot, "conversation.snapshot"),
    },
    {
      area: "writes",
      name: "write.deleteSideThread",
      description: "Delete one side thread with its history (AgentThreadStore.delete)",
      write: true,
      run: () => threads.delete(side.taskId),
    },
  ];
}

interface ArmResult {
  samplesMs: number[];
  p50: number;
  p95: number;
  mean: number;
  statements: number;
  plans: PlanEntry[];
}

function armResult(
  samplesMs: number[],
  statements: string[],
  db: DatabaseSync,
  rowCounts: Record<string, number>,
): ArmResult {
  const sorted = [...samplesMs].sort((a, b) => a - b);
  return {
    samplesMs,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    mean: samplesMs.reduce((sum, value) => sum + value, 0) / samplesMs.length,
    statements: statements.length,
    plans: statements.map((sql) => explain(db, sql, rowCounts)),
  };
}

async function captured(operation: Operation, db: DatabaseSync): Promise<string[]> {
  capture = [];
  await timeOnce(operation, db);
  const statements = [...new Set(capture)];
  capture = null;
  return statements;
}

function seedDirectoryFor(plan: ScalePlan): string {
  return join(BUILD, `seed-v${SEED_VERSION}-${plan.scale}`);
}

async function ensureSeed(plan: ScalePlan, options: Options): Promise<number | null> {
  const seedDirectory = seedDirectoryFor(plan);
  if (!options.reseed && existsSync(join(seedDirectory, "openbot.db"))) return null;
  // The seed takes the schema of the checkout that makes it, so the code before a change has to make it.
  if (options.compare) throw new Error(`No seed for ${plan.scale}x: make it first with a run of the before checkout.`);
  log(`[${plan.scale}x] seeding ${JSON.stringify(plan)}`);
  const seconds = (await seed(plan, seedDirectory)).seconds;
  log(`[${plan.scale}x] seeded in ${seconds.toFixed(1)} s`);
  return seconds;
}

function closeArm(arm: Arm, work: string) {
  arm.supervisor.dispose();
  const unindexed = unindexedForeignKeys(arm.db, arm.rowCounts);
  arm.database.close();
  rmSync(work, { recursive: true, force: true });
  return {
    openMs: arm.openMs,
    schemaVersion: arm.schemaVersion,
    fileBytes: arm.fileBytes,
    rowCounts: arm.rowCounts,
    unindexedForeignKeys: unindexed,
  };
}

function selected(options: Options, name: string): boolean {
  return options.ops.length === 0 || options.ops.some((prefix) => name.startsWith(prefix));
}

function report(scale: number, name: string, arm: string, result: ArmResult): void {
  const flagged = [...new Set(result.plans.flatMap((entry) => entry.flagged))];
  log(
    `[${scale}x] ${`${name}${arm ? ` ${arm}` : ""}`.padEnd(33)} p50 ${result.p50.toFixed(3).padStart(10)} ms  p95 ${result.p95
      .toFixed(3)
      .padStart(10)} ms${flagged.length ? `  SCAN: ${flagged.join("; ")}` : ""}`,
  );
}

/** One checkout: the operations one after another. */
async function measureScale(plan: ScalePlan, options: Options) {
  const seedSeconds = await ensureSeed(plan, options);
  const work = join(BUILD, `run-${options.label}-${plan.scale}`);
  const arm = await openArm(await loadModules(ROOT), plan, seedDirectoryFor(plan), work);
  const operations: Record<string, OperationResult> = {};
  for (const operation of arm.operations) {
    if (!selected(options, operation.name)) continue;
    const statements = await captured(operation, arm.db);
    for (let i = 0; i < options.warmup; i += 1) await timeOnce(operation, arm.db);
    const samplesMs: number[] = [];
    for (let i = 0; i < options.reps; i += 1) samplesMs.push(await timeOnce(operation, arm.db));
    const result = armResult(samplesMs, statements, arm.db, arm.rowCounts);
    operations[operation.name] = {
      area: operation.area,
      description: operation.description,
      write: operation.write === true,
      ...result,
    };
    report(plan.scale, operation.name, "", result);
  }
  return { plan, seedSeconds, ...closeArm(arm, work), operations };
}

/**
 * Two checkouts in one process, each on its own clone of the same seed. Each repeat runs the operation in both, in
 * alternating order (before-after, then after-before), so a change in the load of the computer falls on both arms.
 */
async function compareScale(plan: ScalePlan, options: Options, beforeRoot: string) {
  await ensureSeed(plan, options);
  const roots = { before: beforeRoot, after: ROOT };
  const works = {
    before: join(BUILD, `run-${options.label}-${plan.scale}-before`),
    after: join(BUILD, `run-${options.label}-${plan.scale}-after`),
  };
  const before = await openArm(await loadModules(roots.before), plan, seedDirectoryFor(plan), works.before);
  const after = await openArm(await loadModules(roots.after), plan, seedDirectoryFor(plan), works.after);
  log(
    `[${plan.scale}x] open: before v${before.schemaVersion} ${before.openMs.toFixed(0)} ms, after v${after.schemaVersion} ${after.openMs.toFixed(0)} ms (with the upgrade)`,
  );
  const operations: Record<
    string,
    { area: string; description: string; write: boolean; before: ArmResult; after: ArmResult }
  > = {};
  for (const [index, operation] of before.operations.entries()) {
    const twin = after.operations[index];
    if (!twin || twin.name !== operation.name)
      throw new Error(`The checkouts disagree on operation ${operation.name}.`);
    if (!selected(options, operation.name)) continue;
    const beforeStatements = await captured(operation, before.db);
    const afterStatements = await captured(twin, after.db);
    for (let i = 0; i < options.warmup; i += 1) {
      await timeOnce(operation, before.db);
      await timeOnce(twin, after.db);
    }
    const samples: { before: number[]; after: number[] } = { before: [], after: [] };
    for (let i = 0; i < options.reps; i += 1) {
      if (i % 2 === 0) {
        samples.before.push(await timeOnce(operation, before.db));
        samples.after.push(await timeOnce(twin, after.db));
      } else {
        samples.after.push(await timeOnce(twin, after.db));
        samples.before.push(await timeOnce(operation, before.db));
      }
    }
    const beforeResult = armResult(samples.before, beforeStatements, before.db, before.rowCounts);
    const afterResult = armResult(samples.after, afterStatements, after.db, after.rowCounts);
    operations[operation.name] = {
      area: operation.area,
      description: operation.description,
      write: operation.write === true,
      before: beforeResult,
      after: afterResult,
    };
    report(plan.scale, operation.name, "before", beforeResult);
    report(plan.scale, operation.name, "after", afterResult);
  }
  return {
    plan,
    roots,
    arms: { before: closeArm(before, works.before), after: closeArm(after, works.after) },
    operations,
  };
}

interface Options {
  label: string;
  scales: number[];
  reps: number;
  warmup: number;
  ops: string[];
  reseed: boolean;
  compare: string | null;
}

function parseOptions(argv: readonly string[]): Options {
  const value = (name: string) => argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  const label = value("label");
  if (!label || !/^[\w.-]+$/.test(label)) throw new Error("Pass --label=<name>, for example --label=before.");
  const compare = value("compare");
  return {
    label,
    scales: (value("scales") ?? "1,10,100,1000").split(",").map(Number),
    reps: Number(value("reps") ?? 30),
    warmup: Number(value("warmup") ?? 5),
    ops: (value("ops") ?? "").split(",").filter(Boolean),
    reseed: argv.includes("--reseed"),
    compare: compare ? resolve(compare) : null,
  };
}

function gitOf(root: string) {
  return {
    sha: execFileSync("git", ["-C", root, "rev-parse", "--short", "HEAD"]).toString().trim(),
    dirty: execFileSync("git", ["-C", root, "status", "--porcelain", "--", "src"]).toString().trim().length > 0,
  };
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  if (options.reps < 30) log("Fewer than 30 repeats in this run.");
  mkdirSync(BUILD, { recursive: true });
  mkdirSync(RESULTS, { recursive: true });
  const sqlite = new DatabaseSync(":memory:");
  const sqliteVersion = String(databaseRow(sqlite.prepare("SELECT sqlite_version() AS v").get())?.v);
  sqlite.close();
  const scales: Record<string, Awaited<ReturnType<typeof measureScale>> | Awaited<ReturnType<typeof compareScale>>> =
    {};
  const output = {
    label: options.label,
    mode: options.compare ? "compare" : "single",
    createdAt: new Date().toISOString(),
    git: gitOf(ROOT).sha,
    gitDirty: gitOf(ROOT).dirty,
    before: options.compare ? gitOf(options.compare) : null,
    node: process.version,
    sqlite: sqliteVersion,
    machine: { cpu: cpus()[0]?.model ?? "unknown", cores: cpus().length, memoryGb: Math.round(totalmem() / 2 ** 30) },
    baseline: BASELINE,
    reps: options.reps,
    warmup: options.warmup,
    scales,
  };
  const path = join(RESULTS, `${options.label}.json`);
  for (const scale of options.scales) {
    scales[String(scale)] = options.compare
      ? await compareScale(planFor(scale), options, options.compare)
      : await measureScale(planFor(scale), options);
    // Written after every scale, so a long run that stops keeps what it measured.
    writeFileSync(path, `${JSON.stringify(output, null, 1)}\n`);
  }
  // Remove run directories that a stopped run left.
  for (const entry of readdirSync(BUILD))
    if (entry.startsWith(`run-${options.label}-`)) rmSync(join(BUILD, entry), { recursive: true, force: true });
  log(`Wrote ${path}`);
}

await main();
