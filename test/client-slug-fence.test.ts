/**
 * OAuth-client slug-fence tests (v0.42.70.0 — write-side isolation symmetry).
 *
 * enforceClientSlugFence confines a bound client's direct writes to slugs
 * under its `oauth_clients.bound_slug_prefixes`. This pins:
 *  - regression: no auth / unbound client → every op accepts any slug
 *    (local CLI and unbound-remote behavior unchanged);
 *  - fence: each slug-mutating write op rejects out-of-binding slugs with
 *    permission_denied, BEFORE the dry-run short-circuit (all denials here
 *    run with dryRun=true and an empty engine stub);
 *  - fail-closed: an empty-array binding denies all writes (matches
 *    submit_agent's posture for the same column);
 *  - add_link/remove_link fence the `from` endpoint only — linking TO a
 *    page outside the binding is a reference, not a mutation of it.
 */

import { describe, test, expect } from 'bun:test';
import { operations, OperationError } from '../src/core/operations.ts';
import type { OperationContext, Operation, AuthInfo } from '../src/core/operations.ts';
import type { BrainEngine } from '../src/core/engine.ts';

function op(name: string): Operation {
  const found = operations.find(o => o.name === name);
  if (!found) throw new Error(`${name} op missing`);
  return found;
}

function makeCtx(overrides: Partial<OperationContext> = {}): OperationContext {
  const engine = {} as BrainEngine; // dry_run short-circuits before touching the engine
  return {
    engine,
    config: { engine: 'postgres' } as any,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: true,
    remote: true,
    sourceId: 'shared',
    ...overrides,
  };
}

function boundAuth(prefixes: string[] | undefined): AuthInfo {
  return {
    token: 'test-token',
    clientId: 'gbrain_cl_fence_test',
    scopes: ['read', 'write'],
    sourceId: 'shared',
    ...(prefixes !== undefined ? { boundSlugPrefixes: prefixes } : {}),
  };
}

// Every fenced op with a params factory for an arbitrary slug.
const FENCED_OPS: Array<{ name: string; params: (slug: string) => Record<string, unknown> }> = [
  { name: 'put_page', params: (slug) => ({ slug, content: 'stub' }) },
  { name: 'delete_page', params: (slug) => ({ slug }) },
  { name: 'restore_page', params: (slug) => ({ slug }) },
  { name: 'add_tag', params: (slug) => ({ slug, tag: 't' }) },
  { name: 'remove_tag', params: (slug) => ({ slug, tag: 't' }) },
  { name: 'add_link', params: (slug) => ({ from: slug, to: 'org-wiki/roadmap' }) },
  { name: 'remove_link', params: (slug) => ({ from: slug, to: 'org-wiki/roadmap' }) },
  { name: 'add_timeline_entry', params: (slug) => ({ slug, date: '2026-08-01', summary: 's' }) },
  { name: 'revert_version', params: (slug) => ({ slug, version_id: 1 }) },
  { name: 'put_raw_data', params: (slug) => ({ slug, source: 'src', data: {} }) },
];

describe('client slug fence (bound_slug_prefixes on direct writes)', () => {
  describe('regression: unbound callers unchanged', () => {
    for (const { name, params } of FENCED_OPS) {
      test(`${name}: no ctx.auth accepts arbitrary slug`, async () => {
        const result = await op(name).handler(makeCtx(), params('anywhere/at-all'));
        expect(result).toMatchObject({ dry_run: true });
      });

      test(`${name}: authed client WITHOUT binding accepts arbitrary slug`, async () => {
        const ctx = makeCtx({ auth: boundAuth(undefined) });
        const result = await op(name).handler(ctx, params('anywhere/at-all'));
        expect(result).toMatchObject({ dry_run: true });
      });
    }
  });

  describe('fence: bound client confined to its prefixes', () => {
    const auth = boundAuth(['chan-eng/', 'emp-alice/']);

    for (const { name, params } of FENCED_OPS) {
      test(`${name}: in-binding slug accepted`, async () => {
        const ctx = makeCtx({ auth });
        const result = await op(name).handler(ctx, params('chan-eng/standup-notes'));
        expect(result).toMatchObject({ dry_run: true });
      });

      test(`${name}: out-of-binding slug rejected with permission_denied`, async () => {
        const ctx = makeCtx({ auth });
        try {
          await op(name).handler(ctx, params('chan-product/roadmap'));
          throw new Error('should have thrown');
        } catch (e) {
          expect(e).toBeInstanceOf(OperationError);
          expect((e as OperationError).code).toBe('permission_denied');
          expect((e as Error).message).toContain('bound_slug_prefixes');
        }
      });
    }

    test('second prefix also admits writes', async () => {
      const ctx = makeCtx({ auth });
      const result = await op('put_page').handler(ctx, { slug: 'emp-alice/journal', content: 'stub' });
      expect(result).toMatchObject({ dry_run: true });
    });

    test('prefix match is plain startsWith — bare slug equal to a prefix-less-slash is rejected', async () => {
      const ctx = makeCtx({ auth });
      const p = op('put_page').handler(ctx, { slug: 'chan-eng', content: 'stub' });
      await expect(p).rejects.toBeInstanceOf(OperationError);
    });

    test('add_link: `to` outside the binding is allowed (reference, not mutation)', async () => {
      const ctx = makeCtx({ auth });
      const result = await op('add_link').handler(ctx, { from: 'chan-eng/decision', to: 'org-wiki/anything' });
      expect(result).toMatchObject({ dry_run: true });
    });

    test('local CLI (no auth, remote=false) is never fenced', async () => {
      const ctx = makeCtx({ remote: false });
      const result = await op('put_page').handler(ctx, { slug: 'people/alice', content: 'stub' });
      expect(result).toMatchObject({ dry_run: true });
    });
  });

  describe('fail-closed: empty-array binding denies all writes', () => {
    test('put_page with boundSlugPrefixes=[] rejects every slug', async () => {
      const ctx = makeCtx({ auth: boundAuth([]) });
      const p = op('put_page').handler(ctx, { slug: 'anywhere/at-all', content: 'stub' });
      await expect(p).rejects.toBeInstanceOf(OperationError);
    });
  });

  describe('composition with the subagent fence', () => {
    test('both fences apply: subagent namespace passes but client binding rejects', async () => {
      const ctx = makeCtx({
        viaSubagent: true,
        subagentId: 42,
        auth: boundAuth(['chan-eng/']),
      });
      const p = op('put_page').handler(ctx, { slug: 'wiki/agents/42/notes', content: 'stub' });
      await expect(p).rejects.toBeInstanceOf(OperationError);
      await expect(p).rejects.toThrow(/bound_slug_prefixes/);
    });
  });
});
