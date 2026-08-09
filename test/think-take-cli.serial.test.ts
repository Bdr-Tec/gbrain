/**
 * #2556 — `gbrain think --take` CLI exit-honesty pins.
 *
 * The shipped tests cover persistThinkTake (the core) and the MCP op
 * handler, but nothing drives src/commands/think.ts's take path — the two
 * exit(1) branches ("--take requires --anchor" and "--take requested but no
 * take row was written") were untested. An explicit --take that writes
 * nothing MUST be loud (same honesty contract as --save / #1698 F2).
 *
 * Serial: spies on process.exit + console.error (process-global), and the
 * no-LLM path mutates ANTHROPIC_API_KEY/GBRAIN_HOME via withoutAnthropicKey.
 */
import { test, expect, beforeAll, afterAll, spyOn } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runThinkCli } from '../src/commands/think.ts';
import { withoutAnthropicKey } from './helpers/no-anthropic-key.ts';

let engine: PGLiteEngine;
let anchorPageId: number;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  const p = await engine.putPage('notes/cli-take-anchor-example', {
    title: 'CLI take anchor', type: 'note',
    compiled_truth: 'A safe placeholder page for the CLI take exit tests.',
  });
  anchorPageId = p.id;
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

/**
 * Run runThinkCli with process.exit + console.error captured. The exit spy
 * throws a sentinel so control flow actually stops at the exit site (a
 * non-throwing mock would let the command keep running past exit(1)).
 * Note: an exit(1) inside the runThink try-block is caught by the #1698
 * catch, which console.errors the sentinel message and exits again — the
 * FIRST captured code is the one asserted.
 */
async function runExpectingExit(args: string[]): Promise<{ code: number | null; stderr: string }> {
  const errors: string[] = [];
  let code: number | null = null;
  const errSpy = spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    errors.push(a.map(String).join(' '));
  });
  const exitSpy = spyOn(process, 'exit').mockImplementation(((c?: number) => {
    if (code === null) code = c ?? 0;
    throw new Error(`EXIT:${c}`);
  }) as never);
  try {
    await runThinkCli(engine, args);
  } catch (e) {
    if (!(e instanceof Error) || !e.message.startsWith('EXIT:')) throw e;
  } finally {
    exitSpy.mockRestore();
    errSpy.mockRestore();
  }
  return { code, stderr: errors.join('\n') };
}

test('--take without --anchor exits 1 with the actionable message (parse-time guard)', async () => {
  const { code, stderr } = await runExpectingExit(['what do we know', '--take']);
  expect(code).toBe(1);
  expect(stderr).toContain('--take requires --anchor');
});

test('--take with no LLM (empty synthesis) exits 1 loudly and persists NOTHING', async () => {
  const { code, stderr } = await withoutAnthropicKey(() =>
    runExpectingExit(['what do we know about this page', '--take', '--anchor', 'notes/cli-take-anchor-example']),
  );
  // #2556 honesty contract: explicit --take that wrote nothing → exit 1
  // with the take-specific message, not a silent 0.
  expect(code).toBe(1);
  expect(stderr).toContain('--take requested but no take row was written');
  // And the DB really is untouched — no blank/stub take row.
  expect(await engine.listTakes({ page_id: anchorPageId })).toHaveLength(0);
}, 30_000);
