// Compares the load test runs of two code versions and writes the tables and the chart of `perf/REPORT.md`.
//
//   node_modules/.bin/tsx scripts/db-load-test-report.ts --paired=<prefix> [--explore=<label>]
//
// Every `perf/results/<prefix>*.json` file is one `--compare` run of `scripts/db-load-test.ts`: both code versions
// in one process, each repeat timed in both, in alternating order. The samples of all the files are pooled per arm,
// operation and scale. `--explore` names a single-checkout run whose p50/p95 and flagged scans per scale go in a
// table of their own.
//
// For each operation and scale: p50 and p95 of each arm, the after/before ratio of the medians with a 95%
// bootstrap interval, and a two-sided Mann-Whitney U test. The p-values are adjusted with Holm's method over
// every comparison. A change counts only when the adjusted p is below 0.05 and the interval excludes 1.
//
// Writes `perf/results/summary.json`, `perf/results/tables.md`, `perf/chart.html` (self-contained) and, when
// Playwright's Chromium is installed, `perf/chart.png`.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const RESULTS = join(ROOT, "perf/results");
const PERF = join(ROOT, "perf");
const BOOTSTRAP_RESAMPLES = 4000;
const ALPHA = 0.05;

interface OperationResult {
  area: string;
  description: string;
  write: boolean;
  samplesMs: number[];
  plans: { sql: string; plan: string[]; flagged: string[] }[];
}

interface ScaleResult {
  openMs: number;
  schemaVersion: number;
  fileBytes: number;
  rowCounts: Record<string, number>;
  plan: Record<string, number>;
  operations: Record<string, OperationResult>;
}

interface PairedOperation {
  area: string;
  description: string;
  write: boolean;
  before: { samplesMs: number[]; plans: OperationResult["plans"] };
  after: { samplesMs: number[]; plans: OperationResult["plans"] };
}

interface PairedFile {
  label: string;
  git: string;
  gitDirty: boolean;
  before: { sha: string; dirty: boolean };
  node: string;
  sqlite: string;
  machine: { cpu: string; cores: number; memoryGb: number };
  createdAt: string;
  scales: Record<
    string,
    {
      plan: Record<string, number>;
      arms: Record<"before" | "after", Omit<ScaleResult, "plan" | "operations">>;
      operations: Record<string, PairedOperation>;
    }
  >;
}

/** One arm of a paired file, in the shape of a single-checkout run. */
function armView(file: PairedFile, arm: "before" | "after"): RunFile {
  return {
    label: `${file.label}:${arm}`,
    git: arm === "before" ? file.before.sha : file.git,
    gitDirty: arm === "before" ? file.before.dirty : file.gitDirty,
    node: file.node,
    sqlite: file.sqlite,
    machine: file.machine,
    createdAt: file.createdAt,
    scales: Object.fromEntries(
      Object.entries(file.scales).map(([scale, result]) => [
        scale,
        {
          ...result.arms[arm],
          plan: result.plan,
          operations: Object.fromEntries(
            Object.entries(result.operations).map(([name, operation]) => [
              name,
              {
                area: operation.area,
                description: operation.description,
                write: operation.write,
                samplesMs: operation[arm].samplesMs,
                plans: operation[arm].plans,
              },
            ]),
          ),
        },
      ]),
    ),
  };
}

interface RunFile {
  label: string;
  git: string;
  gitDirty: boolean;
  node: string;
  sqlite: string;
  machine: { cpu: string; cores: number; memoryGb: number };
  createdAt: string;
  scales: Record<string, ScaleResult>;
}

function argument(name: string): string | undefined {
  return process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
}

function pairedRuns(prefix: string): PairedFile[] {
  const files = readdirSync(RESULTS).filter((name) => name.startsWith(prefix) && name.endsWith(".json"));
  if (files.length === 0) throw new Error(`No result file starts with ${prefix}.`);
  return files.sort().map((name) => JSON.parse(readFileSync(join(RESULTS, name), "utf8")));
}

/** The pooled samples of one arm: scale -> operation -> samples, and the open times and versions. */
function pool(files: RunFile[]) {
  const samples = new Map<string, Map<string, number[]>>();
  const meta = new Map<
    string,
    {
      openMs: number[];
      schemaVersion: number;
      fileBytes: number;
      rowCounts: Record<string, number>;
      plan: Record<string, number>;
    }
  >();
  const operations = new Map<string, OperationResult>();
  for (const file of files) {
    for (const [scale, result] of Object.entries(file.scales)) {
      const byOperation = samples.get(scale) ?? new Map<string, number[]>();
      samples.set(scale, byOperation);
      for (const [name, operation] of Object.entries(result.operations)) {
        byOperation.set(name, [...(byOperation.get(name) ?? []), ...operation.samplesMs]);
        operations.set(`${scale}:${name}`, operation);
      }
      const entry = meta.get(scale) ?? {
        openMs: [],
        schemaVersion: result.schemaVersion,
        fileBytes: result.fileBytes,
        rowCounts: result.rowCounts,
        plan: result.plan,
      };
      entry.openMs.push(result.openMs);
      meta.set(scale, entry);
    }
  }
  return { samples, meta, operations };
}

function sorted(values: readonly number[]): number[] {
  return [...values].sort((a, b) => a - b);
}

function percentile(values: readonly number[], p: number): number {
  const ordered = sorted(values);
  const rank = (p / 100) * (ordered.length - 1);
  const low = ordered[Math.floor(rank)] ?? Number.NaN;
  const high = ordered[Math.ceil(rank)] ?? Number.NaN;
  return low + (high - low) * (rank - Math.floor(rank));
}

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

/** 95% percentile bootstrap interval of median(after) / median(before), each arm resampled on its own. */
function bootstrapRatio(before: readonly number[], after: readonly number[], seed: number): [number, number] {
  const random = prng(seed);
  const resampleMedian = (values: readonly number[]) => {
    const draw = Array.from({ length: values.length }, () => values[Math.floor(random() * values.length)] ?? 0);
    return percentile(draw, 50);
  };
  const ratios: number[] = [];
  for (let i = 0; i < BOOTSTRAP_RESAMPLES; i += 1) ratios.push(resampleMedian(after) / resampleMedian(before));
  return [percentile(ratios, 2.5), percentile(ratios, 97.5)];
}

/** Two-sided Mann-Whitney U, normal approximation with the tie correction and a continuity correction. */
function mannWhitney(a: readonly number[], b: readonly number[]): { u: number; p: number } {
  const all = [...a.map((value) => ({ value, group: 0 })), ...b.map((value) => ({ value, group: 1 }))].sort(
    (x, y) => x.value - y.value,
  );
  const ranks = new Array<number>(all.length);
  let tieTerm = 0;
  for (let i = 0; i < all.length; ) {
    let j = i;
    while (j + 1 < all.length && all[j + 1]?.value === all[i]?.value) j += 1;
    const rank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k += 1) ranks[k] = rank;
    const ties = j - i + 1;
    tieTerm += ties ** 3 - ties;
    i = j + 1;
  }
  const n1 = a.length;
  const n2 = b.length;
  const rankSum = all.reduce((sum, entry, index) => (entry.group === 0 ? sum + (ranks[index] ?? 0) : sum), 0);
  const u1 = rankSum - (n1 * (n1 + 1)) / 2;
  const mean = (n1 * n2) / 2;
  const n = n1 + n2;
  const variance = ((n1 * n2) / 12) * (n + 1 - tieTerm / (n * (n - 1)));
  if (variance <= 0) return { u: u1, p: 1 };
  const z = (Math.abs(u1 - mean) - 0.5) / Math.sqrt(variance);
  return { u: u1, p: Math.min(1, 2 * (1 - normalCdf(Math.max(0, z)))) };
}

function normalCdf(z: number): number {
  // Abramowitz and Stegun 26.2.17, error below 7.5e-8.
  const t = 1 / (1 + 0.2316419 * z);
  const d = 0.3989422804014327 * Math.exp((-z * z) / 2);
  const tail = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return 1 - tail;
}

function holm(pValues: readonly number[]): number[] {
  const order = pValues.map((p, index) => ({ p, index })).sort((x, y) => x.p - y.p);
  const adjusted = new Array<number>(pValues.length);
  let running = 0;
  order.forEach(({ p, index }, rank) => {
    running = Math.max(running, Math.min(1, (pValues.length - rank) * p));
    adjusted[index] = running;
  });
  return adjusted;
}

function ms(value: number): string {
  if (!Number.isFinite(value)) return "-";
  if (value >= 1000) return `${(value / 1000).toFixed(2)} s`;
  if (value >= 100) return `${value.toFixed(0)} ms`;
  if (value >= 10) return `${value.toFixed(1)} ms`;
  if (value >= 1) return `${value.toFixed(2)} ms`;
  return `${value.toFixed(3)} ms`;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function pValue(value: number): string {
  return value < 1e-6 ? "<1e-6" : value.toPrecision(2);
}

interface Comparison {
  scale: number;
  operation: string;
  area: string;
  description: string;
  nBefore: number;
  nAfter: number;
  before: { p50: number; p95: number };
  after: { p50: number; p95: number };
  ratio: number;
  ci: [number, number];
  u: number;
  p: number;
  pHolm: number;
  verdict: "faster" | "slower" | "no change";
  flaggedBefore: string[];
  flaggedAfter: string[];
}

function main(): void {
  const prefix = argument("paired");
  if (!prefix) throw new Error("Pass --paired=<prefix>.");
  const paired = pairedRuns(prefix);
  const beforeRuns = paired.map((file) => armView(file, "before"));
  const afterRuns = paired.map((file) => armView(file, "after"));
  const before = pool(beforeRuns);
  const after = pool(afterRuns);
  const comparisons: Comparison[] = [];
  let seed = 1;
  for (const [scale, operations] of before.samples) {
    for (const [operation, beforeSamples] of operations) {
      const afterSamples = after.samples.get(scale)?.get(operation);
      if (!afterSamples) continue;
      const info = before.operations.get(`${scale}:${operation}`);
      const infoAfter = after.operations.get(`${scale}:${operation}`);
      const test = mannWhitney(beforeSamples, afterSamples);
      seed += 1;
      comparisons.push({
        scale: Number(scale),
        operation,
        area: info?.area ?? "",
        description: info?.description ?? "",
        nBefore: beforeSamples.length,
        nAfter: afterSamples.length,
        before: { p50: percentile(beforeSamples, 50), p95: percentile(beforeSamples, 95) },
        after: { p50: percentile(afterSamples, 50), p95: percentile(afterSamples, 95) },
        ratio: percentile(afterSamples, 50) / percentile(beforeSamples, 50),
        ci: bootstrapRatio(beforeSamples, afterSamples, seed),
        u: test.u,
        p: test.p,
        pHolm: 1,
        verdict: "no change",
        flaggedBefore: [...new Set(info?.plans.flatMap((plan) => plan.flagged) ?? [])],
        flaggedAfter: [...new Set(infoAfter?.plans.flatMap((plan) => plan.flagged) ?? [])],
      });
    }
  }
  const adjusted = holm(comparisons.map((comparison) => comparison.p));
  comparisons.forEach((comparison, index) => {
    comparison.pHolm = adjusted[index] ?? 1;
    if (comparison.pHolm < ALPHA && comparison.ci[1] < 1) comparison.verdict = "faster";
    else if (comparison.pHolm < ALPHA && comparison.ci[0] > 1) comparison.verdict = "slower";
  });
  comparisons.sort((x, y) => x.operation.localeCompare(y.operation) || x.scale - y.scale);

  const scales = [...new Set(comparisons.map((comparison) => comparison.scale))].sort((a, b) => a - b);
  const open = scales.map((scale) => ({
    scale,
    beforeVersion: before.meta.get(String(scale))?.schemaVersion,
    afterVersion: after.meta.get(String(scale))?.schemaVersion,
    beforeOpenMs: before.meta.get(String(scale))?.openMs ?? [],
    afterOpenMs: after.meta.get(String(scale))?.openMs ?? [],
    fileBytes: before.meta.get(String(scale))?.fileBytes ?? 0,
    rowCounts: before.meta.get(String(scale))?.rowCounts ?? {},
  }));
  const summary = {
    before: beforeRuns.map((run) => ({
      label: run.label,
      git: run.git,
      dirty: run.gitDirty,
      createdAt: run.createdAt,
    })),
    after: afterRuns.map((run) => ({ label: run.label, git: run.git, dirty: run.gitDirty, createdAt: run.createdAt })),
    environment: { node: beforeRuns[0]?.node, sqlite: beforeRuns[0]?.sqlite, machine: beforeRuns[0]?.machine },
    alpha: ALPHA,
    bootstrapResamples: BOOTSTRAP_RESAMPLES,
    open,
    comparisons,
  };
  writeFileSync(join(RESULTS, "summary.json"), `${JSON.stringify(summary, null, 1)}\n`);
  const explore = argument("explore");
  writeFileSync(
    join(RESULTS, "tables.md"),
    tables(comparisons, scales, open) + (explore ? exploreTable(exploreRun(explore.split(","), beforeRuns)) : ""),
  );
  const html = chart(comparisons, scales);
  writeFileSync(join(PERF, "chart.html"), html);
  process.stdout.write(
    `Wrote ${join(RESULTS, "summary.json")}, ${join(RESULTS, "tables.md")}, ${join(PERF, "chart.html")}\n`,
  );
  void renderPng(join(PERF, "chart.html"), join(PERF, "chart.png"));
}

function tables(
  comparisons: Comparison[],
  scales: number[],
  open: {
    scale: number;
    beforeVersion?: number;
    afterVersion?: number;
    beforeOpenMs: number[];
    afterOpenMs: number[];
    fileBytes: number;
  }[],
): string {
  const lines: string[] = [];
  const byOperation = new Map<string, Comparison[]>();
  for (const comparison of comparisons)
    byOperation.set(comparison.operation, [...(byOperation.get(comparison.operation) ?? []), comparison]);
  lines.push(
    "| Operation | Scale | n (B/A) | Before p50 | Before p95 | After p50 | After p95 | After/before p50 (95% CI) | Holm p | Result |",
  );
  lines.push("|---|---:|---:|---:|---:|---:|---:|---:|---:|---|");
  for (const [operation, rows] of byOperation) {
    for (const row of rows) {
      lines.push(
        `| \`${operation}\` | ${row.scale}x | ${row.nBefore}/${row.nAfter} | ${ms(row.before.p50)} | ${ms(row.before.p95)} | ${ms(row.after.p50)} | ${ms(row.after.p95)} | ${row.ratio.toFixed(3)} (${row.ci[0].toFixed(3)}-${row.ci[1].toFixed(3)}) | ${pValue(row.pHolm)} | ${row.verdict === "faster" ? "**faster**" : row.verdict} |`,
      );
    }
  }
  lines.push("");
  lines.push("| Scale | DB file | Open before (schema) | Open after, with the upgrade (schema) |");
  lines.push("|---:|---:|---:|---:|");
  for (const row of open) {
    const median = (values: number[]) => (values.length ? percentile(values, 50) : Number.NaN);
    lines.push(
      `| ${row.scale}x | ${(row.fileBytes / 2 ** 20).toFixed(0)} MiB | ${ms(median(row.beforeOpenMs))} (v${row.beforeVersion}) | ${ms(median(row.afterOpenMs))} (v${row.afterVersion}) |`,
    );
  }
  lines.push("");
  void scales;
  return `${lines.join("\n")}\n`;
}

/**
 * One view of the code before the change at every scale: the before arm of the paired runs first, then the named
 * single-checkout runs for an operation and scale that the paired runs do not hold.
 */
function exploreRun(labels: string[], pairedBefore: RunFile[]): RunFile {
  const runs: RunFile[] = [
    ...pairedBefore,
    ...labels.map((label): RunFile => JSON.parse(readFileSync(join(RESULTS, `${label}.json`), "utf8"))),
  ];
  const first = runs[0];
  if (!first) throw new Error("No run to explore.");
  const merged: RunFile = { ...first, label: labels.join("+"), scales: {} };
  for (const run of runs) {
    for (const [scale, result] of Object.entries(run.scales)) {
      const target = merged.scales[scale] ?? { ...result, operations: {} };
      for (const [name, operation] of Object.entries(result.operations)) target.operations[name] ??= operation;
      merged.scales[scale] = target;
    }
  }
  return merged;
}

/** The code before the change: p50/p95 of each operation at each scale, and the scans its plans flag. */
function exploreTable(run: RunFile): string {
  const scales = Object.keys(run.scales).sort((a, b) => Number(a) - Number(b));
  const names = [...new Set(scales.flatMap((scale) => Object.keys(run.scales[scale]?.operations ?? {})))];
  const lines = [
    `| Operation | ${scales.map((scale) => `${scale}x p50 / p95`).join(" | ")} | Full scans flagged at the largest scale |`,
    `|---|${scales.map(() => "---:").join("|")}|---|`,
  ];
  for (const name of names) {
    const cells = scales.map((scale) => {
      const samples = run.scales[scale]?.operations[name]?.samplesMs;
      return samples ? `${ms(percentile(samples, 50))} / ${ms(percentile(samples, 95))}` : "-";
    });
    const last = run.scales[scales.at(-1) ?? ""]?.operations[name];
    const flagged = [...new Set(last?.plans.flatMap((plan) => plan.flagged) ?? [])];
    lines.push(`| \`${name}\` | ${cells.join(" | ")} | ${flagged.map((scan) => `\`${scan}\``).join(", ")} |`);
  }
  return `\n${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------------------------------
// The chart: one small multiple per changed operation, p50 against scale on log-log axes, before and after,
// with a thin p95 whisker. One shared y-scale per panel; never two axes. Hover shows the numbers.
// ---------------------------------------------------------------------------------------------------
function chart(comparisons: Comparison[], scales: number[]): string {
  const changed = [...new Set(comparisons.filter((c) => c.verdict !== "no change").map((c) => c.operation))];
  const unchanged = [...new Set(comparisons.map((c) => c.operation))].filter(
    (operation) => !changed.includes(operation),
  );
  const panel = (operation: string) => {
    const rows = comparisons.filter((c) => c.operation === operation).sort((a, b) => a.scale - b.scale);
    const width = 300;
    const height = 200;
    const left = 52;
    const right = 12;
    const top = 14;
    const bottom = 30;
    const values = rows
      .flatMap((row) => [row.before.p50, row.before.p95, row.after.p50, row.after.p95])
      .filter((value) => value > 0);
    const minLog = Math.floor(Math.log10(Math.min(...values)));
    const maxLog = Math.ceil(Math.log10(Math.max(...values)));
    const span = Math.max(1, maxLog - minLog);
    const inner = 16;
    const x = (scale: number) =>
      left +
      inner +
      ((Math.log10(scale) - Math.log10(scales[0] ?? 1)) /
        Math.max(1, Math.log10((scales.at(-1) ?? 1000) / (scales[0] ?? 1)))) *
        (width - left - right - 2 * inner);
    const y = (value: number) => top + (1 - (Math.log10(value) - minLog) / span) * (height - top - bottom);
    const grid: string[] = [];
    for (let tick = minLog; tick <= maxLog; tick += 1) {
      const value = 10 ** tick;
      grid.push(`<line class="grid" x1="${left}" x2="${width - right}" y1="${y(value)}" y2="${y(value)}"/>`);
      grid.push(
        `<text class="tick" x="${left - 6}" y="${y(value) + 4}" text-anchor="end">${ms(value).replace(".000", "").replace(".00 ", " ")}</text>`,
      );
    }
    for (const scale of scales)
      grid.push(`<text class="tick" x="${x(scale)}" y="${height - 10}" text-anchor="middle">${scale}x</text>`);
    const series = (arm: "before" | "after") => {
      const cls = arm === "before" ? "s1" : "s2";
      const path = rows
        .map((row, index) => `${index === 0 ? "M" : "L"}${x(row.scale).toFixed(1)},${y(row[arm].p50).toFixed(1)}`)
        .join(" ");
      const marks = rows
        .map((row) => {
          const cx = x(row.scale) + (arm === "before" ? -3 : 3);
          const tip = `${operation} at ${row.scale}x, ${arm}: p50 ${ms(row[arm].p50)}, p95 ${ms(row[arm].p95)}${arm === "after" ? `; after/before ${row.ratio.toFixed(3)} (95% CI ${row.ci[0].toFixed(3)}-${row.ci[1].toFixed(3)}), Holm p ${pValue(row.pHolm)}` : ""}`;
          return `<g class="pt"><line class="whisker ${cls}" x1="${cx}" x2="${cx}" y1="${y(row[arm].p50)}" y2="${y(row[arm].p95)}"/><circle class="${cls}" cx="${cx}" cy="${y(row[arm].p50)}" r="4"/><circle class="hit" cx="${cx}" cy="${y(row[arm].p50)}" r="11" data-tip="${escapeHtml(tip)}"/></g>`;
        })
        .join("");
      return `<path class="line ${cls}${arm === "after" ? " dashed" : ""}" d="${path}"/>${marks}`;
    };
    const last = rows.at(-1);
    const label = last
      ? `<text class="direct" x="${width - right}" y="${y(last.before.p50) - 8}" text-anchor="end">before</text><text class="direct" x="${width - right}" y="${y(last.after.p50) + 16}" text-anchor="end">after</text>`
      : "";
    const description = rows[0]?.description ?? "";
    return `<figure class="panel"><figcaption><code>${operation}</code><span>${description}</span></figcaption><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${operation}: p50 latency by scale, before and after">${grid.join("")}${series("before")}${series("after")}${label}</svg></figure>`;
  };
  const tableRows = comparisons
    .map(
      (row) =>
        `<tr><td><code>${row.operation}</code></td><td>${row.scale}x</td><td>${ms(row.before.p50)}</td><td>${ms(row.before.p95)}</td><td>${ms(row.after.p50)}</td><td>${ms(row.after.p95)}</td><td>${row.ratio.toFixed(3)} (${row.ci[0].toFixed(3)}-${row.ci[1].toFixed(3)})</td><td>${escapeHtml(pValue(row.pHolm))}</td><td>${row.verdict}</td></tr>`,
    )
    .join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>OpenBot database load test: before and after</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
.viz-root { background: var(--surface-1); color: var(--text-primary); font: 14px/1.4 -apple-system, "Inter", system-ui, sans-serif; padding: 24px; }
.viz-root { color-scheme: light; --surface-1: #fcfcfb; --text-primary: #0b0b0b; --text-secondary: #52514e; --text-muted: #7a7974;
  --grid: #e6e5e1; --series-1: #2a78d6; --series-2: #eb6834; }
@media (prefers-color-scheme: dark) { :root:where(:not([data-theme="light"])) .viz-root { color-scheme: dark; --surface-1: #1a1a19;
  --text-primary: #f0efec; --text-secondary: #c3c2b7; --text-muted: #9a998f; --grid: #33332f; --series-1: #3987e5; --series-2: #d95926; } }
:root[data-theme="dark"] .viz-root { color-scheme: dark; --surface-1: #1a1a19; --text-primary: #f0efec; --text-secondary: #c3c2b7;
  --text-muted: #9a998f; --grid: #33332f; --series-1: #3987e5; --series-2: #d95926; }
body { margin: 0; }
h1 { font-size: 20px; margin: 0 0 4px; } p.sub { color: var(--text-secondary); margin: 0 0 16px; max-width: 70em; }
.legend { display: flex; gap: 20px; margin: 0 0 16px; color: var(--text-secondary); }
.legend span::before { content: ""; display: inline-block; width: 18px; height: 0; border-top: 2px solid; margin-right: 6px; vertical-align: middle; }
.legend .b::before { border-color: var(--series-1); } .legend .a::before { border-color: var(--series-2); border-top-style: dashed; }
.grid-panels { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 16px; }
.panel { margin: 0; } figcaption { display: flex; flex-direction: column; margin-bottom: 4px; }
figcaption code { font-size: 13px; } figcaption span { color: var(--text-secondary); font-size: 12px; }
svg { width: 100%; height: auto; overflow: visible; }
.grid { stroke: var(--grid); stroke-width: 1; } .tick { fill: var(--text-muted); font-size: 10px; }
.line { fill: none; stroke-width: 2; } .line.s1 { stroke: var(--series-1); } .line.s2 { stroke: var(--series-2); } .dashed { stroke-dasharray: 5 3; }
circle.s1 { fill: var(--series-1); stroke: var(--surface-1); stroke-width: 2; } circle.s2 { fill: var(--series-2); stroke: var(--surface-1); stroke-width: 2; }
.whisker { stroke-width: 1.5; opacity: .55; } .whisker.s1 { stroke: var(--series-1); } .whisker.s2 { stroke: var(--series-2); }
.hit { fill: transparent; cursor: default; } .direct { fill: var(--text-secondary); font-size: 11px; }
#tip { position: fixed; pointer-events: none; background: var(--surface-1); color: var(--text-primary); border: 1px solid var(--grid);
  padding: 6px 8px; border-radius: 6px; font-size: 12px; max-width: 320px; display: none; box-shadow: 0 2px 8px rgb(0 0 0 / .12); }
h2 { font-size: 16px; margin: 28px 0 8px; } p.note { color: var(--text-secondary); }
table { border-collapse: collapse; font-size: 12px; } th, td { padding: 3px 8px; border-bottom: 1px solid var(--grid); text-align: right; }
th:first-child, td:first-child { text-align: left; }
</style></head>
<body><div class="viz-root">
<div id="figure">
<h1>OpenBot database load test: p50 latency by data scale</h1>
<p class="sub">Each panel is one app operation with a significant change, in either direction, at one scale or more. Dots: p50; thin whiskers reach p95. Log scale on both axes.
The baseline (1x) is one person who has used OpenBot daily for about three months; every table grows N times. Before and after ran in one process on clones of the same seed, each repeat timed in both in alternating order.</p>
<div class="legend"><span class="b">before (main, 01f1b907e)</span><span class="a">after (this branch)</span></div>
<div class="grid-panels">${changed.map(panel).join("")}</div>
</div>
<h2>Operations with no significant change</h2>
<p class="note">${unchanged.map((operation) => `<code>${operation}</code>`).join(", ") || "None."}</p>
<h2>Table view</h2>
<table><thead><tr><th>Operation</th><th>Scale</th><th>Before p50</th><th>Before p95</th><th>After p50</th><th>After p95</th><th>After/before (95% CI)</th><th>Holm p</th><th>Result</th></tr></thead>
<tbody>${tableRows}</tbody></table>
<div id="tip" role="tooltip"></div>
</div>
<script>
const tip = document.getElementById("tip");
for (const hit of document.querySelectorAll(".hit")) {
  hit.addEventListener("pointerenter", () => { tip.textContent = hit.dataset.tip; tip.style.display = "block"; });
  hit.addEventListener("pointermove", (event) => { tip.style.left = \`\${event.clientX + 14}px\`; tip.style.top = \`\${event.clientY + 14}px\`; });
  hit.addEventListener("pointerleave", () => { tip.style.display = "none"; });
}
</script>
</body></html>
`;
}

/** The newest headless shell in Playwright's cache, when the one this playwright-core wants is not installed. */
function installedHeadlessShell(): string | undefined {
  const cache = join(homedir(), "Library/Caches/ms-playwright");
  if (!existsSync(cache)) return undefined;
  const shells = readdirSync(cache)
    .filter((name) => name.startsWith("chromium_headless_shell-"))
    .sort()
    .map((name) => join(cache, name, "chrome-headless-shell-mac-arm64/chrome-headless-shell"))
    .filter((path) => existsSync(path));
  return shells.at(-1);
}

async function renderPng(htmlPath: string, pngPath: string): Promise<void> {
  try {
    const { chromium } = await import("playwright-core");
    const browser = await chromium.launch({ executablePath: installedHeadlessShell() });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
    await page.goto(`file://${htmlPath}`);
    await page.locator("#figure").screenshot({ path: pngPath });
    await browser.close();
    process.stdout.write(`Wrote ${pngPath}\n`);
  } catch (error) {
    process.stderr.write(`No PNG: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

main();
