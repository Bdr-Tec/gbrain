/**
 * Pins for the strict PR usefulness gate (#3698):
 * - .github/workflows/pr-gate.yml security invariants (never checks out PR
 *   head, exact permissions block, env-bound interpolations, SHA-pinned
 *   actions, trigger shape, 120KB diff cap).
 * - scripts/pr-gate.mjs rubric carries the load-bearing phrases.
 * - Unit coverage for the exported title rule + mechanical red-flag detector
 *   (importing the script must not execute main — side-effect guard).
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { checkTitle, detectRedFlags } from '../scripts/pr-gate.mjs';

const WORKFLOW_PATH = join(import.meta.dir, '..', '.github', 'workflows', 'pr-gate.yml');
const SCRIPT_PATH = join(import.meta.dir, '..', 'scripts', 'pr-gate.mjs');
const WORKFLOW = readFileSync(WORKFLOW_PATH, 'utf8');
const SCRIPT = readFileSync(SCRIPT_PATH, 'utf8');

/** Collect every line that belongs to a `run:` script (block or single-line). */
function runBlockLines(yaml: string): string[] {
  const lines = yaml.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const block = lines[i].match(/^(\s*)(?:-\s+)?run:\s*\|/);
    if (block) {
      const baseIndent = block[1].length;
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].trim() === '') continue;
        const indent = lines[j].match(/^\s*/)![0].length;
        if (indent <= baseIndent) break;
        out.push(lines[j]);
      }
      continue;
    }
    const single = lines[i].match(/^\s*(?:-\s+)?run:\s*(\S.*)$/);
    if (single && single[1] !== '|') out.push(single[1]);
  }
  return out;
}

describe('pr-gate workflow security pins', () => {
  test('never checks out or references the PR head', () => {
    // No `ref:` at all — checkout must default to the base repo (master).
    expect(WORKFLOW).not.toMatch(/^\s*ref:/m);
    expect(WORKFLOW).not.toContain('github.event.pull_request.head');
    expect(WORKFLOW).not.toContain('head.sha');
    expect(WORKFLOW).not.toContain('head.ref');
    expect(WORKFLOW).not.toContain('merge_commit_sha');
  });

  test('permissions block is exactly contents:read + pull-requests:write + issues:write', () => {
    expect(WORKFLOW).toContain(
      'permissions:\n  contents: read\n  pull-requests: write\n  issues: write\n',
    );
    const grants = [...WORKFLOW.matchAll(/^\s+([a-z-]+):\s*(read|write)\s*$/gm)].map((m) => m[1]);
    expect(new Set(grants)).toEqual(new Set(['contents', 'pull-requests', 'issues']));
    expect(WORKFLOW).not.toMatch(/write-all|read-all/);
  });

  test('run: scripts contain no ${{ }} interpolation (attacker-controlled values stay env-bound)', () => {
    const runLines = runBlockLines(WORKFLOW);
    expect(runLines.length).toBeGreaterThan(0);
    for (const line of runLines) {
      expect(line).not.toContain('${{');
    }
  });

  test('all actions are SHA-pinned', () => {
    const uses = [...WORKFLOW.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]);
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) {
      expect(u).toMatch(/@[0-9a-f]{40}\b/);
    }
  });

  test('triggers on pull_request_target (opened/edited/synchronize/reopened) against master', () => {
    expect(WORKFLOW).toContain('pull_request_target:');
    expect(WORKFLOW).toMatch(/types:\s*\[opened, edited, synchronize, reopened\]/);
    expect(WORKFLOW).toMatch(/branches:\s*\[master\]/);
    // Not the unsafe habit of also running plain pull_request with secrets.
    expect(WORKFLOW).not.toMatch(/^\s*pull_request:\s*$/m);
  });

  test('concurrency group per PR with cancel-in-progress', () => {
    expect(WORKFLOW).toMatch(/concurrency:\s*\n\s*group: pr-gate-\$\{\{ github\.event\.pull_request\.number \}\}/);
    expect(WORKFLOW).toContain('cancel-in-progress: true');
  });

  test('diff is fetched via the API .diff media type and capped at 120KB', () => {
    expect(WORKFLOW).toContain('application/vnd.github.diff');
    expect(WORKFLOW).toContain('122880');
    expect(WORKFLOW).toContain('TRUNCATED');
  });

  test('workflow invokes the gate script from the base checkout', () => {
    expect(WORKFLOW).toContain('node scripts/pr-gate.mjs');
  });
});

describe('pr-gate script rubric pins', () => {
  test('script exists and carries the load-bearing rubric phrases', () => {
    expect(existsSync(SCRIPT_PATH)).toBe(true);
    expect(SCRIPT).toContain('CLOSE LANE');
    expect(SCRIPT).toContain('MERGE LANE');
    expect(SCRIPT).toContain('NEEDS_MAINTAINER');
    expect(SCRIPT).toContain('merge-lane');
    expect(SCRIPT).toContain('close-lane');
    expect(SCRIPT).toContain('needs-maintainer');
    expect(SCRIPT).toContain('The default answer is NO');
    expect(SCRIPT).toContain('reviewer_checklist');
  });

  test('version-first title regex is present verbatim', () => {
    expect(SCRIPT).toContain(String.raw`^v\d+\.\d+\.\d+\.\d+ `);
  });

  test('uses claude-sonnet-5 and the sticky-comment marker', () => {
    expect(SCRIPT).toContain('claude-sonnet-5');
    expect(SCRIPT).toContain('<!-- gbrain-pr-gate -->');
  });

  test('never passes sampling params (rejected with 400 on claude-sonnet-5)', () => {
    expect(SCRIPT).not.toMatch(/["']?temperature["']?\s*:/);
    expect(SCRIPT).not.toMatch(/["']?top_p["']?\s*:/);
  });
});

describe('checkTitle (version-first rule)', () => {
  test('accepts version-first titles', () => {
    expect(
      checkTitle('v0.42.3.0 feat(search): autocut — score-discontinuity result-sizing (#1663 wave 1)').ok,
    ).toBe(true);
    expect(checkTitle('v0.31.4.1 fix: dot-suffix follow-up channel').ok).toBe(true);
  });

  test('accepts plain conventional-commit subjects without a version', () => {
    expect(checkTitle('fix(sync): resume from checkpoint after pool exhaustion').ok).toBe(true);
    expect(checkTitle('test(cli): cover import side-effect guard').ok).toBe(true);
    expect(checkTitle('feat!: breaking flag flip').ok).toBe(true);
  });

  test('rejects the documented WRONG form — parenthesized version at the END', () => {
    const r = checkTitle('feat(search): autocut — score-discontinuity result-sizing (v0.42.3.0)');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('WRONG form');
    // Also without the leading v, and with 3 segments.
    expect(checkTitle('fix: some fix (0.42.3)').ok).toBe(false);
  });

  test('rejects non-conventional, non-versioned titles', () => {
    expect(checkTitle('Update README.md').ok).toBe(false);
    expect(checkTitle('Added some improvements').ok).toBe(false);
    // 3-segment version prefix is not the mandated 4-segment form.
    expect(checkTitle('v0.42.3 fix: three segments only').ok).toBe(false);
  });
});

describe('detectRedFlags (mechanical, no LLM)', () => {
  const base = { changedFiles: 2, files: [], diff: '' };
  const ids = (r: ReturnType<typeof detectRedFlags>) => r.map((f) => f.id);

  test('clean small PR has no flags', () => {
    expect(
      detectRedFlags({
        changedFiles: 2,
        files: [
          { filename: 'src/core/progress.ts', status: 'modified' },
          { filename: 'test/progress.test.ts', status: 'modified' },
        ],
        diff: 'diff --git a/src/core/progress.ts b/src/core/progress.ts\n+const x = 1;\n',
      }),
    ).toEqual([]);
  });

  test('flags >40 changed files', () => {
    expect(ids(detectRedFlags({ ...base, changedFiles: 41 }))).toContain('too_many_files');
    expect(ids(detectRedFlags({ ...base, changedFiles: 40 }))).not.toContain('too_many_files');
  });

  test('flags node_modules additions', () => {
    expect(
      ids(
        detectRedFlags({
          ...base,
          files: [{ filename: 'node_modules/left-pad/index.js', status: 'added' }],
        }),
      ),
    ).toContain('adds_node_modules');
  });

  test('flags symlinks via file mode 120000', () => {
    expect(
      ids(detectRedFlags({ ...base, diff: 'diff --git a/x b/x\nnew file mode 120000\n' })),
    ).toContain('adds_symlink');
  });

  test('flags workflow modifications', () => {
    expect(
      ids(
        detectRedFlags({
          ...base,
          files: [{ filename: '.github/workflows/test.yml', status: 'modified' }],
        }),
      ),
    ).toContain('modifies_workflows');
  });

  test('flags a new package.json dependency, but not a version bump', () => {
    const added = detectRedFlags({
      ...base,
      files: [
        {
          filename: 'package.json',
          status: 'modified',
          patch: '@@ -10,6 +10,7 @@\n   "dependencies": {\n+    "left-pad": "^1.3.0",\n     "zod": "^3.0.0"',
        },
      ],
    });
    expect(ids(added)).toContain('adds_dependency');

    const bumped = detectRedFlags({
      ...base,
      files: [
        {
          filename: 'package.json',
          status: 'modified',
          patch: '@@ -10,6 +10,6 @@\n-    "zod": "^3.0.0"\n+    "zod": "^3.1.0"',
        },
      ],
    });
    expect(ids(bumped)).not.toContain('adds_dependency');
  });

  test('flags deleted tests', () => {
    const r = detectRedFlags({
      ...base,
      files: [
        { filename: 'test/engine-parity.test.ts', status: 'removed' },
        { filename: 'src/foo.spec.ts', status: 'removed' },
        { filename: 'src/other.ts', status: 'removed' },
      ],
    });
    expect(ids(r)).toContain('deletes_tests');
    expect(r.find((f) => f.id === 'deletes_tests')!.detail).toContain('test/engine-parity.test.ts');
  });
});
