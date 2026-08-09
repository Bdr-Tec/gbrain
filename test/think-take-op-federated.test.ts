/**
 * #2556 — think op handler: the scope-dialect mapping under a FEDERATED ctx.
 *
 * The op handler maps thinkSourceScopeOpts's `allowedSources` (runThink's
 * dialect) onto persistThinkTake's `sourceIds` (the engine's getPage
 * dialect). The inline comment warns that spreading thinkScope would
 * "silently drop the federated array and unscope the anchor lookup" — but
 * no shipped test constructs a ctx with `auth.allowedSources`, so that exact
 * regression (a cross-source take write) would land green.
 *
 * These tests drive the FULL op handler to a successful synthesis using the
 * gateway chat-transport test seam (no real LLM call), with the anchor page
 * living in tenant-a:
 *   - grant includes tenant-a  → take row lands (mapping threads the array)
 *   - grant is tenant-b only   → TAKE_ANCHOR_NOT_FOUND, nothing written
 *     (fail-closed; an unscoped getPage would wrongly find the page)
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName } from '../src/core/operations.ts';
import {
  __setChatTransportForTests,
  __setEmbedTransportForTests,
} from '../src/core/ai/gateway.ts';
import { withEnv, emptyHome } from './helpers/with-env.ts';

let engine: PGLiteEngine;
let anchorPageId: number;

const ANSWER = 'Federated synthesis insight for the anchor page.';

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  for (const id of ['tenant-a', 'tenant-b']) {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, config, created_at)
       VALUES ($1, $1, NULL, '{}'::jsonb, NOW()) ON CONFLICT (id) DO NOTHING`,
      [id],
    );
  }
  const p = await engine.putPage('people/fed-anchor-example', {
    title: 'Federated anchor', type: 'person',
    compiled_truth: 'A safe placeholder page living in tenant-a.',
  }, { sourceId: 'tenant-a' });
  anchorPageId = p.id;

  // Canned successful synthesis — chat() calls the transport directly,
  // skipping provider resolution/SDK; think parses the JSON envelope.
  __setChatTransportForTests(async () => ({
    text: JSON.stringify({ answer: ANSWER, citations: [], gaps: [] }),
    blocks: [],
    stopReason: 'end' as const,
    usage: { input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model: 'anthropic:claude-opus-4-7',
    providerId: 'anthropic',
  }) as any);
  // Neutralize any query-embedding attempt during gather (fake key below
  // must never reach the network).
  __setEmbedTransportForTests((async (args: any) => ({
    embeddings: ((args?.values ?? []) as string[]).map(() => {
      const v = new Array(1536).fill(0);
      v[0] = 1;
      return v;
    }),
    usage: { tokens: 1 },
  })) as any);
}, 60_000);

afterAll(async () => {
  __setChatTransportForTests(null);
  __setEmbedTransportForTests(null);
  await engine.disconnect();
});

function fedCtx(allowedSources: string[]): any {
  return {
    engine,
    config: {} as any,
    dryRun: false,
    remote: false, // trusted local — safeTake honored; scope still MUST confine
    auth: { allowedSources },
    logger: { info() {}, warn() {}, error() {}, debug() {} } as any,
  };
}

async function runThinkOpTake(allowedSources: string[]): Promise<any> {
  const op = operationsByName['think'];
  // Fake key so tryBuildGatewayClient builds a client (transport is stubbed);
  // empty GBRAIN_HOME so the real user config can't leak into model routing
  // and the page-lock files land in a hermetic temp dir.
  return withEnv({ ANTHROPIC_API_KEY: 'sk-test-fake', GBRAIN_HOME: emptyHome() }, () =>
    op.handler(fedCtx(allowedSources), {
      question: 'what do we know about the federated anchor?',
      anchor: 'people/fed-anchor-example',
      take: true,
    }),
  );
}

describe('think op — federated allowedSources → sourceIds mapping (#2556)', () => {
  test('in-grant federated ctx: take row lands on the anchor in the granted source', async () => {
    const res = await runThinkOpTake(['tenant-a']);
    expect(res.take_row).toBe(1);
    expect(res.take_inserted).toBe(1);
    expect(res.remote_persisted_blocked).toBe(false);

    const takes = await engine.listTakes({ page_id: anchorPageId });
    expect(takes).toHaveLength(1);
    expect(takes[0]).toMatchObject({
      row_num: 1, claim: ANSWER, kind: 'take', holder: 'brain', source: 'gbrain think',
    });
  }, 30_000);

  test('out-of-grant federated ctx: anchor lookup fail-closes — no cross-source take write', async () => {
    const res = await runThinkOpTake(['tenant-b']);
    // If the handler spread thinkScope (dropping the federated array), the
    // getPage lookup would be UNSCOPED, find the tenant-a page, and write a
    // cross-source row — this pins the mapping instead.
    expect(res.take_row).toBeNull();
    expect(res.take_inserted).toBe(0);
    expect((res.warnings as string[]).some(w => w.startsWith('TAKE_ANCHOR_NOT_FOUND'))).toBe(true);

    // Still exactly the one row from the in-grant test above.
    expect(await engine.listTakes({ page_id: anchorPageId })).toHaveLength(1);
  }, 30_000);
});
