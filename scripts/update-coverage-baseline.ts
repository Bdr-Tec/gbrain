#!/usr/bin/env bun
/**
 * scripts/update-coverage-baseline.ts — rewrite one corpus section of
 * scripts/coverage-baseline.json from a real merged-summary run
 * (containment sprint).
 *
 * Usage:
 *   bun scripts/update-coverage-baseline.ts --summary <json> \
 *     --corpus <prCorpus|fullCorpus> [--promote]
 *
 * Behavior:
 *   - Reads the working-tree scripts/coverage-baseline.json (this is the
 *     WRITE side; the gate reads origin/master's copy, so an update only
 *     takes effect when it lands on master).
 *   - Replaces baseline[<corpus>] with {global, dirs, files} derived from
 *     the summary; `files` is limited to the watchlist paths listed in the
 *     baseline file itself (the 8 containment-sprint watchlist modules),
 *     never the full file map.
 *   - --promote clears "provisional" (sets it to false), turning both
 *     gates from report-only into real gates once COVERAGE_GATE_ENFORCE=1.
 *
 * Exit codes: 0 success; 2 usage/IO error.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface CovTriple {
  lines: number;
  covered: number;
  pct: number;
}

export interface SummaryForBaseline {
  total: CovTriple;
  dirs: Record<string, CovTriple>;
  files: Record<string, CovTriple>;
}

export interface BaselineCorpusSection {
  global: CovTriple;
  dirs: Record<string, CovTriple>;
  files: Record<string, CovTriple>;
}

/**
 * Pure section builder: global + dirs from the summary, files limited to
 * the watchlist entries that actually appear in the summary.
 */
export function buildCorpusSection(summary: SummaryForBaseline, watchlist: string[]): BaselineCorpusSection {
  const files: Record<string, CovTriple> = {};
  for (const path of watchlist) {
    const entry = summary.files[path];
    if (entry) files[path] = entry;
  }
  return { global: summary.total, dirs: summary.dirs, files };
}

function fail(msg: string): never {
  process.stderr.write(`update-coverage-baseline: ${msg}\n`);
  process.exit(2);
}

function main(): void {
  const argv = process.argv.slice(2);
  let summaryPath = "";
  let corpus = "";
  let promote = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--summary") summaryPath = argv[++i] ?? "";
    else if (a === "--corpus") corpus = argv[++i] ?? "";
    else if (a === "--promote") promote = true;
    else fail(`unknown argument: ${a}`);
  }
  if (!summaryPath) fail("--summary <json> is required");
  if (corpus !== "prCorpus" && corpus !== "fullCorpus") fail("--corpus must be prCorpus or fullCorpus");
  if (!existsSync(summaryPath)) fail(`summary JSON not found: ${summaryPath}`);

  let summary: SummaryForBaseline;
  try {
    summary = JSON.parse(readFileSync(summaryPath, "utf8")) as SummaryForBaseline;
  } catch (err) {
    fail(`summary JSON unparseable: ${String(err)}`);
  }
  if (!summary.total || !summary.dirs || !summary.files) fail("summary JSON missing total/dirs/files sections");

  const baselinePath = process.env.COVERAGE_BASELINE_WORKTREE_PATH || join(import.meta.dir, "coverage-baseline.json");
  if (!existsSync(baselinePath)) fail(`baseline file not found: ${baselinePath}`);
  let baseline: Record<string, unknown>;
  try {
    baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as Record<string, unknown>;
  } catch (err) {
    fail(`baseline JSON unparseable: ${String(err)}`);
  }

  const watchlist = Array.isArray(baseline.watchlist) ? (baseline.watchlist as string[]) : [];
  const section = buildCorpusSection(summary, watchlist);
  baseline[corpus] = section;
  if (promote) baseline.provisional = false;

  writeFileSync(baselinePath, JSON.stringify(baseline, null, 2) + "\n", "utf8");
  process.stderr.write(
    `update-coverage-baseline: wrote ${corpus} section (global ${summary.total.pct}%, ` +
      `${Object.keys(summary.dirs).length} dirs, ${Object.keys(section.files).length} watchlist files)` +
      `${promote ? ", provisional cleared" : ""}\n`,
  );
}

if (import.meta.main) main();
