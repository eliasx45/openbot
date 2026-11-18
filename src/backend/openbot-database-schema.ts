import type { DatabaseSync } from "node:sqlite";
import { isDynamicRecord, isNumber } from "@openbot/contracts/runtime-values";
import { sourceText } from "@openbot/i18n/source";
import { createOpenBotLogger, toLogValue } from "@openbot/logging";
import { withTransaction } from "./database/sqlite-transaction";
import { MESSAGING_PINGS_SCHEMA_SQL } from "./migrations/0059-messaging-pings";
import type { OpenBotMigration } from "./migrations/migration";
import { MIGRATIONS } from "./migrations/registry";

const BASELINE_SCHEMA_VERSION = 8;

// Fork (docs/fork/FEATURES.md #43): indexes the child keys that a thread delete follows. A delete of a thread removes its turns and
// activities by ON DELETE CASCADE, and each provider session it removes clears its turns by ON DELETE SET NULL.
// SQLite finds those rows through an index that starts with the child key, or else reads the whole child table
// once for each parent row. Both tables grow by a row for each turn or message of every thread, so a delete of
// one side thread read every turn and activity ever stored. A whole-snapshot write also deletes the activities of
// its thread by thread and sequence, which is the second column. A turn without a session never needs the
// session index, so it is partial. Restart recovery reads the running turns of every thread, which without an
// index is a read of every turn; that index holds only running turns, so a finished turn leaves it.
// The fork shipped these as migration 59 (6 Nov 2026); upstream then took 59 for the messaging pings table
// and 60 for the memory site. So they are no numbered migration any more: `applyForkSchema` makes them on
// every start (IF NOT EXISTS), and upstream's numbers stay free for the next sync.
const FORK_THREAD_CHILD_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS thread_activities_thread
    ON projection_thread_activities(thread_id, last_event_sequence);
  CREATE INDEX IF NOT EXISTS turns_thread ON projection_turns(thread_id);
  CREATE INDEX IF NOT EXISTS turns_provider_session ON projection_turns(provider_session_id)
    WHERE provider_session_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS turns_running ON projection_turns(thread_id, turn_id) WHERE status = 'running';
`;

/** Fork: the indexes of `FORK_THREAD_CHILD_INDEX_SQL`, which the migration history leaves out. */
export const FORK_SCHEMA_INDEX_NAMES: ReadonlySet<string> = new Set([
  "thread_activities_thread",
  "turns_thread",
  "turns_provider_session",
  "turns_running",
]);

// Each migration and the SQL it runs is in its own frozen file under `migrations/`. This module runs them.
// A new database runs the same migrations as an existing one, from the version 8 baseline, so a new
// install and an upgraded install cannot get different schemas.

export interface OpenBotMigrationOptions {
  appliedAt?: string;
  warn?: (message: string, error: unknown) => void;
  /** The last connection closed cleanly, so SQLite removed the write-ahead log. */
  closedCleanly?: boolean;
  /**
   * Stops the database after this version. Tests use it to make the database of an older release
   * (`src/backend/migration-harness.ts`).
   */
  throughVersion?: number;
}

const logger = createOpenBotLogger("openbot-database-schema");

/** The highest schema version that this build can open. */
export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? BASELINE_SCHEMA_VERSION;

/**
 * True when `migrateOpenBotDatabase` will run a migration, also on a new database. It ends with the full
 * check on this connection, so a check elsewhere before it would only read the file twice.
 */
export function openBotDatabaseNeedsMigration(db: DatabaseSync): boolean {
  if (!hasExistingSchema(db)) return true;
  const currentVersion = latestAppliedVersion(readAppliedVersions(db));
  return MIGRATIONS.some((migration) => migration.version > currentVersion);
}

export function migrateOpenBotDatabase(db: DatabaseSync, options: OpenBotMigrationOptions = {}): void {
  validateMigrationRegistry();
  const appliedAt = options.appliedAt ?? new Date().toISOString();
  const isNewDatabase = !hasExistingSchema(db);
  const appliedVersions = readAppliedVersions(db);
  validateAppliedVersions(appliedVersions);
  const currentVersion = latestAppliedVersion(appliedVersions);
  const throughVersion = options.throughVersion ?? LATEST_SCHEMA_VERSION;
  repairForkVersion59(db, currentVersion);
  const pending = MIGRATIONS.filter(
    (migration) => migration.version > currentVersion && migration.version <= throughVersion,
  );
  // A database can hold broken references from before this upgrade. A migration that does not touch them must not
  // stop on them, and deleting them would lose rows, so each migration is checked only for the ones it adds.
  let violations: Map<string, number> | undefined;

  for (const migration of pending) {
    try {
      // Read inside the try, so that a failed read names the migration that it stops, as a failed check did before.
      violations ??= readOldForeignKeyViolations(db);
      violations = runMigration(db, migration, appliedAt, violations);
    } catch (error) {
      // The startup log keeps only the message, so the cause is logged here.
      logger.error(`OpenBot database migration to version ${migration.version} failed.`, toLogValue(error));
      throw new Error(`OpenBot database migration to version ${migration.version} failed.`, {
        cause: error,
      });
    }

    // A new database has no free pages to give back.
    if (migration.vacuumAfterCommit && !isNewDatabase) {
      try {
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        db.exec("VACUUM");
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      } catch (error) {
        const warn = options.warn ?? ((message: string, cause: unknown) => logger.warn(message, toLogValue(cause)));
        warn(`OpenBot database migration to version ${migration.version} succeeded, but VACUUM failed.`, error);
      }
    }
  }

  // Fork: a test that makes the database of an older release stops before the latest version, and an
  // upstream release has no fork indexes, so only a full upgrade adds them.
  if (throughVersion >= LATEST_SCHEMA_VERSION) applyForkSchema(db);
  // The check reads every page, which takes minutes on a large file. Only a migration, or a stop that
  // did not close the file (a crash, a kill, a disk save while it ran), can leave a damaged page.
  if (pending.length > 0 || !options.closedCleanly) assertQuickCheck(db);
}

/**
 * Fork: a database that the fork's own migration 59 (the thread child indexes, 6 Nov 2026) took to version
 * 59 never ran upstream's migration 59, the messaging pings table. Makes that table, as migration 59 would.
 */
function repairForkVersion59(db: DatabaseSync, currentVersion: number): void {
  if (currentVersion < 59) return;
  const table = db
    .prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'projection_messaging_pings'")
    .get();
  if (!table) db.exec(MESSAGING_PINGS_SCHEMA_SQL);
}

/** Fork: the schema that the fork adds outside the numbered migrations. Each statement is IF NOT EXISTS. */
function applyForkSchema(db: DatabaseSync): void {
  db.exec(FORK_THREAD_CHILD_INDEX_SQL);
}

function validateMigrationRegistry(): void {
  let expectedVersion = BASELINE_SCHEMA_VERSION;
  for (const migration of MIGRATIONS) {
    if (!Number.isInteger(migration.version) || migration.version !== expectedVersion) {
      throw new Error(
        `OpenBot database migrations must be contiguous from version ${BASELINE_SCHEMA_VERSION}; expected ${expectedVersion}.`,
      );
    }
    expectedVersion += 1;
  }
}

function hasExistingSchema(db: DatabaseSync): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' LIMIT 1").get(),
  );
}

function readAppliedVersions(db: DatabaseSync): number[] {
  const hasMigrationTable = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .get();
  if (!hasMigrationTable) return [];
  return db
    .prepare("SELECT version FROM schema_migrations ORDER BY version")
    .all()
    .map((row) => {
      if (!isDynamicRecord(row) || !isNumber(row.version) || !Number.isInteger(row.version)) {
        throw new Error("OpenBot database contains an invalid schema migration version.");
      }
      return row.version;
    });
}

/**
 * A newer OpenBot migrated the database. This build stops before it writes anything; the start can
 * recover by installing a release that knows the version (`src/main/newer-database-recovery.ts`).
 */
export class NewerDatabaseError extends Error {
  constructor(databaseVersion: number, supportedVersion: number) {
    super(`OpenBot database version ${databaseVersion} is newer than this application supports (${supportedVersion}).`);
  }
}

function validateAppliedVersions(versions: number[]): void {
  const newestVersion = versions.at(-1) ?? 0;
  if (newestVersion > LATEST_SCHEMA_VERSION) {
    throw new NewerDatabaseError(newestVersion, LATEST_SCHEMA_VERSION);
  }

  const baselineAndLater = versions.filter((version) => version >= BASELINE_SCHEMA_VERSION);
  if (baselineAndLater.length === 0) return;
  const applied = new Set(baselineAndLater);
  for (let version = BASELINE_SCHEMA_VERSION; version <= newestVersion; version += 1) {
    if (!applied.has(version)) {
      throw new Error(`OpenBot database migration history is missing version ${version}.`);
    }
  }
}

function latestAppliedVersion(versions: number[]): number {
  const baselineAndLater = versions.filter((version) => version >= BASELINE_SCHEMA_VERSION);
  return baselineAndLater.at(-1) ?? BASELINE_SCHEMA_VERSION - 1;
}

function runMigration(
  db: DatabaseSync,
  migration: OpenBotMigration,
  appliedAt: string,
  violationsBefore: ReadonlyMap<string, number>,
): Map<string, number> {
  if (migration.disableForeignKeys) db.exec("PRAGMA foreign_keys = OFF");
  try {
    return withTransaction(db, () => {
      migration.up(db, appliedAt);
      db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(migration.version, appliedAt);
      return assertForeignKeys(db, violationsBefore);
    });
  } finally {
    if (migration.disableForeignKeys) db.exec("PRAGMA foreign_keys = ON");
  }
}

function assertForeignKeys(db: DatabaseSync, before: ReadonlyMap<string, number>): Map<string, number> {
  const violations = readForeignKeyViolations(db);
  const added = [...violations]
    .map(([reference, count]) => [reference, count - (before.get(reference) ?? 0)] as const)
    .filter(([, count]) => count > 0);
  if (added.length > 0) {
    const total = added.reduce((sum, [, count]) => sum + count, 0);
    const references = added.map(([reference]) => reference).join(", ");
    throw new Error(`OpenBot database migration produced ${total} foreign-key violation(s) in ${references}.`);
  }
  return violations;
}

/**
 * Counts the broken references per child and parent table. A rebuild gives the rows new rowids and the table new
 * foreign-key ids, so only the table names identify a violation from one migration to the next.
 */
function readForeignKeyViolations(db: DatabaseSync): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of db.prepare("PRAGMA foreign_key_check").all()) {
    // Every row counts, also one of an unexpected shape, so that the check cannot miss a violation.
    const reference = isDynamicRecord(row) ? `${String(row.table)} -> ${String(row.parent)}` : "unknown";
    counts.set(reference, (counts.get(reference) ?? 0) + 1);
  }
  return counts;
}

function readOldForeignKeyViolations(db: DatabaseSync): Map<string, number> {
  const violations = readForeignKeyViolations(db);
  if (violations.size > 0) {
    logger.warn("The OpenBot database has foreign-key violations from before this upgrade. They stay as they are.", {
      violations: Object.fromEntries(violations),
    });
  }
  return violations;
}

function assertQuickCheck(db: DatabaseSync): void {
  assertQuickCheckResult(
    db
      .prepare("PRAGMA quick_check(20)")
      .all()
      .map((row) => (isDynamicRecord(row) ? row.quick_check : row)),
  );
}

/** Throws the integrity error unless the lines of a `PRAGMA quick_check` are the one line "ok". */
export function assertQuickCheckResult(problems: readonly unknown[]): void {
  if (problems.length === 1 && problems[0] === "ok") return;
  // The lines name the damaged pages and tables, which tell a page left by a disk save from a bad index.
  logger.error("The OpenBot database failed its integrity check.", { problems });
  throw new Error(sourceText("error.backend.databaseIntegrity"));
}
