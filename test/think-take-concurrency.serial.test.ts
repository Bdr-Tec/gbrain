/**
 * #2556 — persistThinkTake concurrency pin.
 *
 * The function's doc-comment CLAIMS the MAX(row_num)+1 computation + insert
 * are serialized under withPageLock(anchor) so two concurrent `think --take`
 * calls (or a takes add racing a think --take) can't produce duplicate
 * row_nums. The shipped tests only exercise SEQUENTIAL calls (row 1 then
 * row 2), which passes even with no lock at all. This test drives the two
 * calls CONCURRENTLY via Promise.all and asserts they land on distinct
 * consecutive rows — the behavioral proof the lock is actually keyed and
 * actually serializes.
 *
 * Serial: the page lock is a real file under $GBRAIN_HOME/.gbrain/page-locks
 * (process-global fs + env), and the loser of the race polls at 200ms.
 */
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { persistThinkTake } from '../src/core/think/index.ts';
import { withEnv, emptyHome } from './helpers/with-env.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

function synthResult(answer: string): any {
  return {
    question: 'what should this page remember?',
    answer, citations: [], gaps: [], pagesGathered: 0, takesGathered: 0,
    graphHits: 0, modelUsed: 'stub', rounds: 1, warnings: [], synthesisOk: true,
    diagnostics: { pagesFromHybrid: 0, takesFromKeyword: 0, takesFromVector: 0, graphHits: 0 },
  };
}

test('two CONCURRENT persistThinkTake calls on the same anchor serialize to rows 1 and 2 (no duplicate row_num)', async () => {
  const page = await engine.putPage('notes/think-take-race-example', {
    title: 'Think take race target', type: 'note',
    compiled_truth: 'A safe placeholder page for concurrent think take persistence.',
  });

  // GBRAIN_HOME → fresh temp dir so the page-lock files land in a hermetic
  // location (gbrainPath honors GBRAIN_HOME) instead of the user's ~/.gbrain.
  await withEnv({ GBRAIN_HOME: emptyHome() }, async () => {
    const [a, b] = await Promise.all([
      persistThinkTake(engine, synthResult('first concurrent synthesized insight'), {
        anchor: 'notes/think-take-race-example',
      }),
      persistThinkTake(engine, synthResult('second concurrent synthesized insight'), {
        anchor: 'notes/think-take-race-example',
      }),
    ]);

    // Both persisted and the row numbers are EXACTLY {1, 2} — a lost lock
    // would yield {1, 1} (duplicate) or a failed insert. Wave-4 dual-plane
    // contract: no brain repo is configured on this hermetic engine, so both
    // appends fall back to DB-only allocation and surface
    // TAKE_FILE_PLANE_UNAVAILABLE (still serialized under the page lock).
    expect(a.inserted).toBe(1);
    expect(b.inserted).toBe(1);
    expect(a.warnings).toEqual(['TAKE_FILE_PLANE_UNAVAILABLE']);
    expect(b.warnings).toEqual(['TAKE_FILE_PLANE_UNAVAILABLE']);
    expect([a.rowNum, b.rowNum].sort()).toEqual([1, 2]);
  });

  // DB ground truth: two rows, distinct row_nums, both holder=brain.
  const takes = await engine.listTakes({ page_id: page.id });
  expect(takes).toHaveLength(2);
  expect(new Set(takes.map(t => t.row_num)).size).toBe(2);
  const dupCheck = await engine.executeRaw<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM takes
      WHERE page_id = $1
      GROUP BY row_num HAVING COUNT(*) > 1`,
    [page.id],
  );
  expect(dupCheck).toHaveLength(0);
}, 15_000);
