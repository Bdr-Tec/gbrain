/**
 * #4352 — page-level `visibility: private` enforcement for untrusted callers.
 *
 * Pages have carried `frontmatter.visibility` for a long time (the `remember`
 * verb documents "private: local CLI reads only"), but nothing on the READ
 * side ever enforced it for pages: a remote/MCP caller could retrieve a
 * `visibility: private` page through search, recall's query arm, entity
 * cards, and context_pack. This module is the single trust+config resolver:
 *
 *   ctx.remote === false          → see everything (trusted local CLI)
 *   GBRAIN_REMOTE_PRIVATE_PAGES=1 → operator escape hatch, see everything
 *   config search.remote_private_pages ∈ {visible,true,1}
 *                                 → operator opt-out, see everything
 *   otherwise                     → exclude private pages (FAIL-CLOSED default)
 *
 * The SQL predicate itself lives in buildVisibilityClause (sql-ranking.ts)
 * behind SearchOpts.excludePrivate; this resolver decides whether to set it.
 */

import type { BrainEngine } from '../engine.ts';

export const REMOTE_PRIVATE_PAGES_KEY = 'search.remote_private_pages';

const CACHE_TTL_MS = 30_000;
let cache = new WeakMap<BrainEngine, { at: number; expose: boolean }>();

/** Test helper: drop the per-engine config cache. */
export function __resetPrivateVisibilityCacheForTests(): void {
  cache = new WeakMap();
}

/**
 * Should this caller's page reads exclude `visibility: private` pages?
 * `remote` follows the repo trust convention: anything that is not strictly
 * `false` is untrusted. Config lookups are cached 30s per engine; a failed
 * lookup counts as "not opted out" (fail-closed).
 */
export async function resolveExcludePrivatePages(
  engine: BrainEngine,
  remote: boolean | undefined,
): Promise<boolean> {
  if (remote === false) return false; // trusted local CLI sees everything
  if (process.env.GBRAIN_REMOTE_PRIVATE_PAGES === '1') return false; // incident escape hatch
  const hit = cache.get(engine);
  let expose: boolean;
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    expose = hit.expose;
  } else {
    try {
      const v = await engine.getConfig(REMOTE_PRIVATE_PAGES_KEY);
      expose = v === 'visible' || v === 'true' || v === '1';
    } catch {
      expose = false; // config unreadable → enforce (fail-closed)
    }
    cache.set(engine, { at: Date.now(), expose });
  }
  return !expose;
}
