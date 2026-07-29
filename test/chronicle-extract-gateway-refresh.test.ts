/**
 * #3387: `chronicle_extract` must re-resolve models from the ENGINE before it runs.
 *
 * `registerBuiltinJob` wraps a handler with `refreshGatewayForJob(engine)` only
 * when its name is in `GATEWAY_REFRESH_JOB_NAMES`. That refresh calls
 * `reconfigureGatewayWithEngine`, which resolves `models.chat` from the DB
 * config plane (`resolveModel(engine, { configKey: 'models.chat', … })`),
 * falling back to the file/env plane.
 *
 * Without the entry the job sees only the connect-time file/env config, so a
 * chat model set with `gbrain config set` is silently ignored and
 * `extract-events.ts` returns a silent `no_events`.
 *
 * WHY THE TEST IS SHAPED THIS WAY: the bug is invisible when the model comes
 * from an environment variable, because the connect-time config already carries
 * it. A reviewer ran the reporter's repro live, it passed, and they concluded
 * not-a-bug for exactly that reason. Set membership IS the mechanism, so that
 * is what this pins.
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const JOBS_SRC = readFileSync(resolve(import.meta.dir, '../src/commands/jobs.ts'), 'utf-8');

/**
 * Members of the GATEWAY_REFRESH_JOB_NAMES set literal.
 * Scans only quoted entries on their own line, so prose in comments (which may
 * legitimately contain quoted identifiers) cannot be mistaken for a member.
 */
function refreshSetMembers(): string[] {
  const start = JOBS_SRC.indexOf('const GATEWAY_REFRESH_JOB_NAMES = new Set([');
  if (start === -1) throw new Error('GATEWAY_REFRESH_JOB_NAMES not found — declaration moved?');
  const end = JOBS_SRC.indexOf(']);', start);
  if (end === -1) throw new Error('GATEWAY_REFRESH_JOB_NAMES has no terminator');
  return JOBS_SRC.slice(start, end)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => !line.startsWith('//'))
    .map((line) => /^'([^']+)',$/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => m[1]);
}

describe('#3387: chronicle_extract re-resolves models from the engine', () => {
  test('chronicle_extract is in GATEWAY_REFRESH_JOB_NAMES', () => {
    // Fails on master: 13 members, this is not one of them.
    expect(refreshSetMembers()).toContain('chronicle_extract');
  });

  test('the refresh wrapper is what consults the DB config plane', () => {
    // Pins the mechanism, so a refactor that drops the engine-aware refresh
    // shows up here rather than as a mystery `no_events`.
    expect(JOBS_SRC).toContain('GATEWAY_REFRESH_JOB_NAMES.has(name)');
    expect(JOBS_SRC).toContain('refreshGatewayForJob(engine)');
  });

  test('every chat-calling job stays in the set', () => {
    // Regression floor: each of these invokes a chat/expansion model and would
    // silently ignore DB-plane model config if dropped from the set.
    const members = refreshSetMembers();
    const required = [
      'chronicle_extract',
      'extract_facts',
      'extract-conversation-facts',
      'synthesize',
      'patterns',
      'consolidate',
      'extract-takes-from-pages',
      'enrich',
    ];
    const missing = required.filter((n) => !members.includes(n));
    expect(missing).toEqual([]);
  });
});
