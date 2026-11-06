# OpenBot database load test — report (6 Nov 2026)

Branch `perf/db-load-test`, commit `7215c5fc4`. The data is in `perf/results/tables.md` (per-scale p50/p95), `perf/results/summary.json`, `perf/chart.png` and `perf/chart.html`, with raw samples in `perf/results/*.json`.

## Before → after at 1000× (p50, n=30 per side, Holm-adjusted p < 1e-6)

| Operation | Before | After |
|---|---:|---:|
| Delete a side thread with its history | 1.42 s (p95 26.9 s) | 5.9 ms |
| Whole-snapshot write of a side thread | 528 ms | 10.7 ms |
| Running turns at startup (`readRunningTurnIds`) | 210 ms | 0.075 ms |
| A turn's answer (`readTurnAssistantMessages`) | 17.8 ms | 0.095 ms |
| `list_memories` first page | 14.7 ms | 0.81 ms |
| Change the inclusion of 10 memories | 8.4 ms | 2.9 ms |
| `search_memories` | 8.4 ms | 5.8 ms |

At 100× the same operations improve about 12× to 500×.

## Fixes
1. Migration 59 adds four indexes: thread activities, turns by thread, and turns by provider session (unindexed foreign-key children, so every delete read the whole child table), plus a partial index of running turns for the startup read. It adds a migration test and updates the existing ones (58→59).
2. `readTurnAssistantMessages` now uses the turn index (`+` on the first ORDER BY term) and returns the same rows.
3. `AgentMemoryStore.getSelection` reads one row by key instead of reloading every selection once per memory.
4. FEATURES.md entry 42.

## Migration risk
On first start, the app builds the indexes and then runs its usual full integrity check, as after any migration. That took 316 s on a 15.6 GB database and 3.9 s on 1.4 GB. The live `openbot.db` is about 66 MB (checked 6 Nov), so the upgrade should be well under a second there. The indexes add about 2% to the file and change no rows. A failed migration rolls back cleanly (tested). Older builds refuse the upgraded database because its version is newer.

## Not fixed (needs a decision)
- **Message search** reads every message: 32.8 s p50 at 1000× and 1.0 s at 100×. A trigram FTS prototype cut the time from 2,983 ms to 26 ms on 100×. The cost is +32% disk, about 37 s of indexing at 100× during the upgrade, and slightly different matching.
- **Unread badge of a chat never opened** counts its whole history on every sidebar refresh: 3.3 s at 1000×. Capping it would change a value the Team API returns.
- **Sent-message stats** (839 ms at 1000×) and the legacy whole-chat read (135 ms) also grow with history.
- Six more foreign-key children have no index. Their tables are empty in the seed, so they weren't measured.

## Method
- **Data:** synthetic seeds at 1×, 10×, 100× and 1000× of about three months of daily use (8 agents with 400-message chats at 1×), with every relationship scaled. Memories stop at the 512-per-agent cap.
- **Code paths:** the harness calls the app's real store methods, records every SQL statement and runs `EXPLAIN QUERY PLAN` on each.
- **Comparison:** the old and new code run in one process on copies of the same seed, in alternating order. Separate processes were tried first and failed the controls.
- **Statistics:** Mann-Whitney U with Holm correction, plus a bootstrap 95% CI on the median ratio.
- **Controls:** about 100 unchanged operations show no change, except two microsecond-level flags.
- **Limits:** the system load average was about 90 from other apps during the runs. The 1000× paired runs skip four slow unchanged operations. The tests used SQLite 3.53.3, and Electron's bundled SQLite version was not checked.
- **Tests:** backend 36 files and 929 tests pass, `typecheck:node` passes, and the pre-commit hooks pass.
