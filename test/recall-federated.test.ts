/**
 * cathedral-6 D1b: `recall` honors federated grants. The fact arms route
 * through sourceScopeOpts — a remote caller whose token carries
 * allowedSources sees world facts across every granted source (the spec's
 * cross-agent continuity), while an ungranted source stays invisible and
 * private facts stay local-only. Single-source callers keep the exact
 * pre-v1 single-query path.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/operations.ts';

let engine: PGLiteEngine;

function ctx(over: Record<string, unknown>): OperationContext {
  return {
    engine,
    config: {},
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: false,
    ...over,
  } as unknown as OperationContext;
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
  for (const id of ['aurora-workspace', 'proj-widget', 'nova-notes']) {
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING`, [id],
    );
  }
  const remember = operationsByName['remember'];
  // B (writes proj-widget): a world fact — the cross-agent continuity payload.
  await remember.handler(
    ctx({ remote: true, sourceId: 'proj-widget' }),
    { fact: 'The payments provider decision is Stripe-shaped (test marker QQF1)', provenance: 'recall-federated test', visibility: 'world' },
  );
  // A private fact in proj-widget: must never cross to remote readers.
  await remember.handler(
    ctx({ remote: false, sourceId: 'proj-widget' }),
    { fact: 'Private hunch marker QQF2', provenance: 'recall-federated test', visibility: 'private' },
  );
  // A fact in an UNGRANTED source: must not leak through the federated arm.
  await remember.handler(
    ctx({ remote: true, sourceId: 'nova-notes' }),
    { fact: 'Ungranted-source marker QQF3', provenance: 'recall-federated test', visibility: 'world' },
  );
});

afterAll(async () => {
  await engine.disconnect();
});

describe('recall federated grants (D1b)', () => {
  const recall = () => operationsByName['recall'];

  it('a federated remote caller recalls world facts from a GRANTED foreign source', async () => {
    const res: any = await recall().handler(
      ctx({
        remote: true,
        sourceId: 'aurora-workspace',
        auth: { allowedSources: ['aurora-workspace', 'proj-widget'] },
      }),
      {},
    );
    const facts = (res.facts ?? []).map((f: any) => String(f.fact));
    expect(facts.some((f: string) => f.includes('QQF1'))).toBe(true);
    expect(facts.some((f: string) => f.includes('QQF3'))).toBe(false); // ungranted source
    expect(facts.some((f: string) => f.includes('QQF2'))).toBe(false); // private stays hidden
  });

  it('without the federated grant the foreign source stays invisible (scalar path)', async () => {
    const res: any = await recall().handler(
      ctx({ remote: true, sourceId: 'aurora-workspace' }),
      {},
    );
    const facts = (res.facts ?? []).map((f: any) => String(f.fact));
    expect(facts.some((f: string) => f.includes('QQF1'))).toBe(false);
  });

  it('an empty allowedSources array is a deny-not-widen: scalar source only', async () => {
    const res: any = await recall().handler(
      ctx({ remote: true, sourceId: 'proj-widget', auth: { allowedSources: [] } }),
      {},
    );
    const facts = (res.facts ?? []).map((f: any) => String(f.fact));
    expect(facts.some((f: string) => f.includes('QQF1'))).toBe(true);  // own scalar source
    expect(facts.some((f: string) => f.includes('QQF3'))).toBe(false); // never widened
  });

  it('the since arm fans out across the federated grant too (not just the no-filter arm)', async () => {
    const res: any = await recall().handler(
      ctx({
        remote: true,
        sourceId: 'aurora-workspace',
        auth: { allowedSources: ['aurora-workspace', 'proj-widget'] },
      }),
      { since: '2000-01-01' },
    );
    const facts = (res.facts ?? []).map((f: any) => String(f.fact));
    expect(facts.some((f: string) => f.includes('QQF1'))).toBe(true);  // granted foreign source
    expect(facts.some((f: string) => f.includes('QQF3'))).toBe(false); // ungranted source
    expect(facts.some((f: string) => f.includes('QQF2'))).toBe(false); // private stays hidden
  });

  it('local trusted caller still reads private facts (visibility unchanged)', async () => {
    const res: any = await recall().handler(
      ctx({ remote: false, sourceId: 'proj-widget' }),
      {},
    );
    const facts = (res.facts ?? []).map((f: any) => String(f.fact));
    expect(facts.some((f: string) => f.includes('QQF2'))).toBe(true);
  });
});
