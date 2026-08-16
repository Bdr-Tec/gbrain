// coverage-baseline-gate.test.ts — behavioral, fixture-locked tests for
// scripts/coverage-baseline-gate.ts, plus unit coverage of the pure section
// builder in scripts/update-coverage-baseline.ts.
//
// The git-show source is injected via the documented test seam
// COVERAGE_BASELINE_JSON_OVERRIDE (literal JSON; sentinels ABSENT_ON_MASTER
// and GIT_FAILURE), so tests never depend on the real origin/master.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareCorpus } from "../../scripts/coverage-baseline-gate.ts";
import { buildCorpusSection } from "../../scripts/update-coverage-baseline.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "coverage-baseline-gate-test-"));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

let fixtureSeq = 0;
function writeSummary(total: { pct: number }, dirs: Record<string, { pct: number }>, degraded = false): string {
  const p = join(tmp, `summary-${fixtureSeq++}.json`);
  const expand = (x: { pct: number }) => ({ lines: 1000, covered: Math.round(x.pct * 10), pct: x.pct });
  writeFileSync(
    p,
    JSON.stringify({
      corpus: "prCorpus",
      degraded,
      total: expand(total),
      dirs: Object.fromEntries(Object.entries(dirs).map(([k, v]) => [k, expand(v)])),
    }) + "\n",
    "utf8",
  );
  return p;
}

const BASELINE = {
  provisional: false,
  prCorpus: {
    global: { lines: 1000, covered: 800, pct: 80 },
    dirs: { "src/core": { lines: 500, covered: 350, pct: 70 } },
    files: {},
  },
  fullCorpus: null,
  watchlist: [],
};

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runGate(opts: {
  summary: string;
  corpus?: string;
  baseline?: string;
  enforce?: string;
  worktreePath?: string;
}): RunResult {
  const res = Bun.spawnSync(
    [
      "bun",
      join(REPO_ROOT, "scripts", "coverage-baseline-gate.ts"),
      "--summary",
      opts.summary,
      "--corpus",
      opts.corpus ?? "prCorpus",
    ],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        COVERAGE_BASELINE_JSON_OVERRIDE: opts.baseline ?? JSON.stringify(BASELINE),
        COVERAGE_GATE_ENFORCE: opts.enforce ?? "0",
        ...(opts.worktreePath ? { COVERAGE_BASELINE_WORKTREE_PATH: opts.worktreePath } : {}),
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  return { code: res.exitCode, stdout: res.stdout.toString(), stderr: res.stderr.toString() };
}

describe("regression thresholds", () => {
  it("within thresholds → PASS (report-only WOULD PASS; enforcing PASS)", () => {
    const summary = writeSummary({ pct: 79.6 }, { "src/core": { pct: 69.1 } });
    const reportOnly = runGate({ summary });
    expect(reportOnly.code).toBe(0);
    expect(reportOnly.stdout).toContain("WOULD PASS");

    const enforcing = runGate({ summary, enforce: "1" });
    expect(enforcing.code).toBe(0);
    expect(enforcing.stdout).toContain("PASS: no coverage regression");
  });

  it("global drop of exactly 0.5pp is NOT a regression (strictly-greater rule)", () => {
    const summary = writeSummary({ pct: 79.5 }, { "src/core": { pct: 70 } });
    const res = runGate({ summary, enforce: "1" });
    expect(res.code).toBe(0);
  });

  it("global regression > 0.5pp → WOULD FAIL report-only (exit 0), FAIL enforcing (exit 1)", () => {
    const summary = writeSummary({ pct: 79.0 }, { "src/core": { pct: 70 } });
    const reportOnly = runGate({ summary });
    expect(reportOnly.code).toBe(0);
    expect(reportOnly.stdout).toContain("WOULD FAIL");
    expect(reportOnly.stdout).toContain("REGRESSION: global");

    const enforcing = runGate({ summary, enforce: "1" });
    expect(enforcing.code).toBe(1);
    expect(enforcing.stdout).toContain("FAIL: coverage regression");
  });

  it("per-dir regression > 1.0pp fails even when global holds", () => {
    const summary = writeSummary({ pct: 80 }, { "src/core": { pct: 68.9 } });
    const res = runGate({ summary, enforce: "1" });
    expect(res.code).toBe(1);
    expect(res.stdout).toContain("REGRESSION: src/core");
  });

  it("per-dir drop of exactly 1.0pp passes", () => {
    const summary = writeSummary({ pct: 80 }, { "src/core": { pct: 69 } });
    const res = runGate({ summary, enforce: "1" });
    expect(res.code).toBe(0);
  });
});

describe("report-only downgrades", () => {
  it("provisional baseline → report-only even with a regression under enforcement", () => {
    const summary = writeSummary({ pct: 70 }, { "src/core": { pct: 60 } });
    const res = runGate({
      summary,
      enforce: "1",
      baseline: JSON.stringify({ ...BASELINE, provisional: true }),
    });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("REPORT-ONLY (baseline is provisional)");
    expect(res.stdout).toContain("WOULD FAIL");
  });

  it("degraded summary → report-only even with a regression under enforcement", () => {
    const summary = writeSummary({ pct: 70 }, { "src/core": { pct: 60 } }, true);
    const res = runGate({ summary, enforce: "1" });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("DEGRADED");
    expect(res.stdout).toContain("WOULD FAIL");
  });
});

describe("ungated first landings", () => {
  it("null corpus section → ungated, exit 0", () => {
    const summary = writeSummary({ pct: 10 }, {});
    const res = runGate({ summary, corpus: "fullCorpus", enforce: "1" });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("ungated first landing");
  });

  it("baseline absent on master → ungated, exit 0", () => {
    const summary = writeSummary({ pct: 10 }, {});
    const res = runGate({ summary, enforce: "1", baseline: "ABSENT_ON_MASTER" });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("ungated first landing");
  });
});

describe("infrastructure errors", () => {
  it("unresolvable ref → exit 2", () => {
    const summary = writeSummary({ pct: 80 }, {});
    const res = runGate({ summary, baseline: "GIT_FAILURE" });
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("infrastructure error");
  });

  it("deletion defense: baseline on master but working-tree copy missing → exit 2", () => {
    const summary = writeSummary({ pct: 80 }, { "src/core": { pct: 70 } });
    const res = runGate({ summary, worktreePath: join(tmp, "deleted-baseline.json") });
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("working-tree copy is missing");
  });

  it("missing summary → exit 2; bad --corpus → exit 2", () => {
    const missing = runGate({ summary: join(tmp, "nope.json") });
    expect(missing.code).toBe(2);
    const badCorpus = runGate({ summary: writeSummary({ pct: 80 }, {}), corpus: "weekendCorpus" });
    expect(badCorpus.code).toBe(2);
  });
});

describe("compareCorpus (unit)", () => {
  it("ignores dirs absent from the summary and reports both regression kinds", () => {
    const report = compareCorpus(
      {
        global: { lines: 100, covered: 80, pct: 80 },
        dirs: {
          "src/core": { lines: 50, covered: 35, pct: 70 },
          "src/gone": { lines: 10, covered: 9, pct: 90 },
        },
        files: {},
      },
      { pct: 79 },
      { "src/core": { pct: 68 } },
    );
    expect(report.pass).toBe(false);
    expect(report.regressions.length).toBe(2); // global + src/core; src/gone skipped
  });
});

describe("buildCorpusSection (unit, update-coverage-baseline.ts)", () => {
  it("limits files to watchlist entries present in the summary", () => {
    const section = buildCorpusSection(
      {
        total: { lines: 10, covered: 5, pct: 50 },
        dirs: { src: { lines: 10, covered: 5, pct: 50 } },
        files: {
          "src/cli.ts": { lines: 5, covered: 1, pct: 20 },
          "src/unwatched.ts": { lines: 5, covered: 4, pct: 80 },
        },
      },
      ["src/cli.ts", "src/core/migrate.ts"],
    );
    expect(section.global.pct).toBe(50);
    expect(Object.keys(section.files)).toEqual(["src/cli.ts"]);
  });
});
