// @vitest-environment node
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { migrateOpenBotDatabase } from "./openbot-database-schema";

// Fork (docs/fork/FEATURES.md #43): the thread child indexes are no numbered migration any more
// (`applyForkSchema`). Failure modes: an upgrade loses or changes a thread, turn, activity or provider session;
// a database that the fork's old migration 59 took to version 59 misses upstream's messaging pings table;
// a newer or incomplete history is changed; a thread delete or a session delete stops removing or clearing
// the rows that point to it.
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function databaseAt(version: number): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec(`CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    CREATE TEMP TRIGGER stop_at_version BEFORE INSERT ON schema_migrations WHEN new.version > ${version}
    BEGIN SELECT RAISE(ABORT, 'fixture stop'); END;`);
  expect(() => migrateOpenBotDatabase(db)).toThrow(`migration to version ${version + 1} failed`);
  db.exec("DROP TRIGGER stop_at_version");
  return db;
}

// Two threads. Both sessions are inactive: migrations 9 to 14 end an active one, which is not this migration.
// The chat has a turn with a provider session and a turn from before the session; each turn has an
// activity. The side thread has its own session, turn and activity.
function seedThreads(db: DatabaseSync): void {
  db.exec(`INSERT INTO projection_threads (thread_id, agent_id, title, active_turn_id, created_at, updated_at, last_event_sequence)
    VALUES
      ('openbot-thread-chief', 'chief', 'Chief', NULL, '2026-10-01T10:00:00.000Z', '2026-10-01T10:05:00.000Z', 6),
      ('side-1', 'chief', 'Side', NULL, '2026-10-01T11:00:00.000Z', '2026-10-01T11:05:00.000Z', 9);
    INSERT INTO projection_provider_sessions (id, thread_id, provider, external_session_id, model, effort, state,
        created_at, updated_at, resume_cursor, last_event_sequence)
    VALUES
      ('session-1', 'openbot-thread-chief', 'codex', 'external-1', 'gpt-5.6-luna', 'medium', 'inactive',
        '2026-10-01T10:01:00.000Z', '2026-10-01T10:01:00.000Z', NULL, 3),
      ('session-2', 'side-1', 'claude', 'external-2', 'claude-opus-5-5', 'high', 'inactive',
        '2026-10-01T11:01:00.000Z', '2026-10-01T11:01:00.000Z', 'cursor-2', 7);
    INSERT INTO projection_turns (turn_id, thread_id, provider_session_id, status, started_at, completed_at, last_event_sequence)
    VALUES
      ('turn-0', 'openbot-thread-chief', NULL, 'completed', '2026-10-01T10:00:30.000Z', '2026-10-01T10:00:50.000Z', 2),
      ('turn-1', 'openbot-thread-chief', 'session-1', 'running', '2026-10-01T10:02:00.000Z', NULL, 5),
      ('turn-2', 'side-1', 'session-2', 'completed', '2026-10-01T11:02:00.000Z', '2026-10-01T11:03:00.000Z', 8);
    INSERT INTO projection_thread_activities (activity_id, thread_id, turn_id, activity_type, payload_json, created_at,
        last_event_sequence)
    VALUES
      ('activity-0', 'openbot-thread-chief', 'turn-0', 'turn.completed', '{"turnId":"turn-0"}', '2026-10-01T10:00:50.000Z', 2),
      ('activity-1', 'openbot-thread-chief', 'turn-1', 'conversation.snapshot', '{}', '2026-10-01T10:02:00.000Z', 6),
      ('activity-2', 'side-1', 'turn-2', 'turn.completed', '{"turnId":"turn-2"}', '2026-10-01T11:03:00.000Z', 9);`);
}

function contents(db: DatabaseSync) {
  return {
    threads: db.prepare("SELECT * FROM projection_threads ORDER BY thread_id").all(),
    sessions: db.prepare("SELECT * FROM projection_provider_sessions ORDER BY id").all(),
    turns: db.prepare("SELECT * FROM projection_turns ORDER BY turn_id").all(),
    activities: db.prepare("SELECT * FROM projection_thread_activities ORDER BY activity_id").all(),
  };
}

const INDEXES = {
  thread_activities_thread: ["thread_id", "last_event_sequence"],
  turns_thread: ["thread_id"],
  turns_provider_session: ["provider_session_id"],
  turns_running: ["thread_id", "turn_id"],
};

function indexColumns(db: DatabaseSync) {
  return Object.fromEntries(
    Object.keys(INDEXES).map((name) => [
      name,
      db
        .prepare("SELECT name FROM pragma_index_info(?) ORDER BY seqno")
        .all(name)
        .map((column) => column.name),
    ]),
  );
}

const NO_INDEXES = { thread_activities_thread: [], turns_thread: [], turns_provider_session: [], turns_running: [] };

function plan(db: DatabaseSync, sql: string): string {
  return db
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all()
    .map((row) => String(row.detail))
    .join("; ");
}

function expectHealthy(db: DatabaseSync): void {
  expect(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: 60 });
  expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
}

function hasPingsTable(db: DatabaseSync): boolean {
  return (
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'projection_messaging_pings'").get() !==
    undefined
  );
}

describe("fork thread child indexes", () => {
  // The three tables keep their columns from the v8 baseline on, so the oldest and the newest released schema bound it.
  it.each([8, 58])("upgrades v%i and keeps every thread, session, turn and activity", (version) => {
    const db = databaseAt(version);
    seedThreads(db);
    const before = contents(db);
    migrateOpenBotDatabase(db);
    expect(contents(db)).toEqual(before);
    expect(indexColumns(db)).toEqual(INDEXES);
    expectHealthy(db);
  });

  it("gives a new install the indexes", () => {
    const db = new DatabaseSync(":memory:");
    databases.push(db);
    migrateOpenBotDatabase(db);
    expect(indexColumns(db)).toEqual(INDEXES);
    expectHealthy(db);
  });

  it("repairs a database that the fork's old migration 59 took to version 59", () => {
    const db = databaseAt(58);
    seedThreads(db);
    const before = contents(db);
    // What the fork's migration 59 did: the four indexes and the version 59 marker, no pings table.
    db.exec(`CREATE INDEX thread_activities_thread ON projection_thread_activities(thread_id, last_event_sequence);
      CREATE INDEX turns_thread ON projection_turns(thread_id);
      CREATE INDEX turns_provider_session ON projection_turns(provider_session_id) WHERE provider_session_id IS NOT NULL;
      CREATE INDEX turns_running ON projection_turns(thread_id, turn_id) WHERE status = 'running';
      INSERT INTO schema_migrations VALUES(59, 'now');`);
    expect(hasPingsTable(db)).toBe(false);
    migrateOpenBotDatabase(db);
    expect(hasPingsTable(db)).toBe(true);
    expect(
      db
        .prepare("PRAGMA table_info(projection_agent_memories)")
        .all()
        .map((column) => column.name),
    ).toContain("site");
    expect(contents(db)).toEqual(before);
    expect(indexColumns(db)).toEqual(INDEXES);
    expectHealthy(db);
  });

  it("serves the lookups of a thread delete, a session delete and restart recovery from the indexes", () => {
    const db = databaseAt(58);
    seedThreads(db);
    migrateOpenBotDatabase(db);
    // The ON DELETE actions run these lookups; a whole-snapshot write runs the activity delete itself.
    expect(plan(db, "SELECT 1 FROM projection_turns WHERE thread_id = ?")).toContain(
      "USING COVERING INDEX turns_thread",
    );
    expect(plan(db, "SELECT 1 FROM projection_turns WHERE provider_session_id = ?")).toContain(
      "USING COVERING INDEX turns_provider_session",
    );
    expect(
      plan(db, "DELETE FROM projection_thread_activities WHERE thread_id = ? AND last_event_sequence IN (1, 2)"),
    ).toContain("USING COVERING INDEX thread_activities_thread");
    expect(plan(db, "SELECT thread_id, turn_id FROM projection_turns WHERE status = 'running'")).toContain(
      "USING COVERING INDEX turns_running",
    );
    expect(db.prepare("SELECT thread_id, turn_id FROM projection_turns WHERE status = 'running'").all()).toEqual([
      { thread_id: "openbot-thread-chief", turn_id: "turn-1" },
    ]);

    db.prepare("DELETE FROM projection_provider_sessions WHERE id = ?").run("session-1");
    expect(db.prepare("SELECT turn_id, provider_session_id FROM projection_turns ORDER BY turn_id").all()).toEqual([
      { turn_id: "turn-0", provider_session_id: null },
      { turn_id: "turn-1", provider_session_id: null },
      { turn_id: "turn-2", provider_session_id: "session-2" },
    ]);
    db.prepare("DELETE FROM projection_threads WHERE thread_id = ?").run("side-1");
    expect(db.prepare("SELECT turn_id FROM projection_turns ORDER BY turn_id").all()).toEqual([
      { turn_id: "turn-0" },
      { turn_id: "turn-1" },
    ]);
    expect(db.prepare("SELECT activity_id FROM projection_thread_activities ORDER BY activity_id").all()).toEqual([
      { activity_id: "activity-0" },
      { activity_id: "activity-1" },
    ]);
    expect(db.prepare("SELECT id FROM projection_provider_sessions").all()).toEqual([]);
    expectHealthy(db);
  });

  it("rejects newer and incomplete migration histories before it adds an index", () => {
    const db = databaseAt(58);
    seedThreads(db);
    const before = contents(db);
    db.exec("INSERT INTO schema_migrations VALUES(61, 'now')");
    expect(() => migrateOpenBotDatabase(db)).toThrow("newer than this application supports");
    db.exec("DELETE FROM schema_migrations WHERE version = 61; DELETE FROM schema_migrations WHERE version = 20");
    expect(() => migrateOpenBotDatabase(db)).toThrow("missing version 20");
    expect(contents(db)).toEqual(before);
    expect(indexColumns(db)).toEqual(NO_INDEXES);
  });

  it("refuses to open a version 60 database in an older application", () => {
    const db = databaseAt(58);
    seedThreads(db);
    migrateOpenBotDatabase(db);
    const after = contents(db);
    // An application one release older knows versions up to 60 at most: version 61 is newer than it supports.
    db.exec("INSERT INTO schema_migrations VALUES(61, 'now')");
    expect(() => migrateOpenBotDatabase(db)).toThrow("newer than this application supports");
    expect(contents(db)).toEqual(after);
    expect(indexColumns(db)).toEqual(INDEXES);
  });
});
