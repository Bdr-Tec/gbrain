/**
 * Provider-agnostic embedding migration (#3390).
 *
 * `gbrain migrate embeddings --to <provider:model>` re-embeds a brain onto
 * any configured provider — the forward path off a sunsetting provider that
 * `ze-switch` (ZE-only target) and `ze-switch --undo` (needs a snapshot fresh
 * installs don't have) cannot cover.
 *
 * Deliberately thin: everything heavy is reused —
 *   - runSchemaTransition (retrieval-upgrade-planner.ts) for dimension changes
 *   - invalidateStaleSignatureEmbeddings + the NULL-embedding cursor for
 *     staleness + resume (the NULL column IS the checkpoint: a killed run
 *     re-runs the same command and continues where it stopped)
 *   - the embed pipeline (src/commands/embed.ts) for the actual re-embed,
 *     with pacing, backfill locks, rate-limit backoff, and progress
 *   - lookupEmbeddingPrice / estimateCostFromChars for the preflight estimate
 *   - detectEnvOverride (the #1421 damage-class gate) before any mutation
 *
 * #3391 companion fix: the migration widens staleness with
 * `includeNullSignature: true` so pages that predate the v108 signature stamp
 * are re-embedded too, instead of silently staying in the old embedding space.
 *
 * The command layer (src/commands/migrate-embeddings.ts) owns everything
 * process-shaped: confirm prompts, file-plane config persistence (the gateway
 * reads file/env, not the DB plane), gateway reconfiguration, and the embed
 * catch-up run. This module is engine-pure so both engines and the op handler
 * share one implementation.
 */

import type { BrainEngine } from './engine.ts';
import { resolveRecipe, embeddingDimsForModel } from './ai/model-resolver.ts';
import { lookupEmbeddingPrice, estimateCostFromChars } from './embedding-pricing.ts';
import { readContentChunksEmbeddingDim } from './embedding-dim-check.ts';
import { DEFAULT_EMBEDDING_MODEL, DEFAULT_EMBEDDING_DIMENSIONS } from './ai/defaults.ts';
import { hnswIndexExpected } from './vector-index.ts';

// ============================================================================
// Env-override safety gate (moved from retrieval-upgrade-planner.ts — this
// module is the v0.47 survivor; the planner re-exports for back-compat and
// is deleted in the ZE removal wave)
// ============================================================================

/**
 * v0.41.2.1 — env-override safety gate.
 *
 * `process.env.GBRAIN_EMBEDDING_MODEL` and `GBRAIN_EMBEDDING_DIMENSIONS`
 * win over DB+file config in `loadConfig()`. The 716K-chunk damage
 * incident (PR #1421) shipped because ze-switch wrote DB config but
 * the env override silently kept the old model active at embed time —
 * schema migrated to 2560d while embeds still produced 1536d vectors.
 *
 * detectEnvOverride is a pure read of process.env (or an injected env
 * for tests). triggered:true means refusal is required unless the
 * caller passes ignoreEnvOverride:true (mirrors --ignore-missing-key).
 */
export interface EnvOverrideWarning {
  triggered: boolean;
  vars: Array<{ name: string; current: string; target: string }>;
}

export function detectEnvOverride(
  targetModel: string,
  targetDim: number,
  env: NodeJS.ProcessEnv = process.env,
): EnvOverrideWarning {
  const vars: EnvOverrideWarning['vars'] = [];
  const envModel = env.GBRAIN_EMBEDDING_MODEL?.trim();
  if (envModel && envModel !== targetModel) {
    vars.push({ name: 'GBRAIN_EMBEDDING_MODEL', current: envModel, target: targetModel });
  }
  const envDimRaw = env.GBRAIN_EMBEDDING_DIMENSIONS?.trim();
  if (envDimRaw) {
    const envDim = Number(envDimRaw);
    if (!Number.isFinite(envDim) || envDim !== targetDim) {
      vars.push({
        name: 'GBRAIN_EMBEDDING_DIMENSIONS',
        current: envDimRaw,
        target: String(targetDim),
      });
    }
  }
  return { triggered: vars.length > 0, vars };
}

/**
 * ASCII box rendering (repo convention D10 v0.22.11 — no Unicode box
 * drawing). Pure function; CLI calls this and writes to stderr.
 * Line width <= 78 cols for safe rendering in any terminal or log
 * aggregator.
 */
export function formatEnvOverrideWarning(w: EnvOverrideWarning): string {
  const lines: string[] = [];
  lines.push('+----------------------------------------------------------------------------+');
  lines.push('| ENV OVERRIDE DETECTED - ACTION REQUIRED                                    |');
  lines.push('+----------------------------------------------------------------------------+');
  for (const v of w.vars) {
    lines.push(`| ${v.name} is set in your environment:`.padEnd(77) + '|');
    lines.push(`|   Current env: ${v.current}`.padEnd(77) + '|');
    lines.push(`|   Switch target: ${v.target}`.padEnd(77) + '|');
    lines.push('|                                                                            |');
  }
  lines.push('| The env var takes HIGHEST PRECEDENCE and will override this switch.        |');
  lines.push('| Update your .env file or shell environment before retrying:                |');
  lines.push('|                                                                            |');
  const unsetCmd = `   unset ${w.vars.map(v => v.name).join(' ')}`;
  // Match the other content-line pattern: `|` + 76 chars + `|` = 78 total.
  lines.push(`|${unsetCmd.padEnd(76)}|`);
  lines.push('|                                                                            |');
  lines.push('| Without this change, the switch has NO EFFECT at runtime.                  |');
  lines.push('| Pass --ignore-env-override to apply anyway (advanced; you know why).       |');
  lines.push('+----------------------------------------------------------------------------+');
  return lines.join('\n');
}

// ============================================================================
// Schema transition (D18; moved from retrieval-upgrade-planner.ts)
// ============================================================================

/**
 * The atomic DROP + ALTER + CREATE INDEX sequence for content_chunks.
 * Both engines accept identical SQL (PGLite uses pgvector via WASM, same
 * grammar). Wrapped in engine.transaction so a partial failure rolls back.
 *
 * Index names verified against:
 *   src/schema.sql:163  -> idx_chunks_embedding
 *   src/core/pglite-schema.ts:127 -> idx_chunks_embedding
 *   src/schema.sql:169  -> idx_chunks_embedding_image
 *   src/core/pglite-schema.ts:130 -> idx_chunks_embedding_image
 *
 * IF NOT EXISTS on CREATE INDEX makes the operation safe to re-run during
 * `--resume`.
 */
export async function runSchemaTransition(engine: BrainEngine, targetDim: number): Promise<void> {
  // v0.41 fix: only transition the primary text embedding column.
  // The embedding_image (v0.27.1) and embedding_multimodal (v0.36 / migration
  // v78) columns use SEPARATE multimodal models (e.g. voyage-multimodal-3 at
  // 1024d) whose dimensions are independent of the text embedding model.
  // Dropping and recreating either at targetDim silently breaks multimodal
  // search by creating a dimension mismatch between the column and the
  // multimodal provider's output.
  //
  // Before this fix, switching text embeddings from OpenAI (1536d) to
  // ZeroEntropy (1280d) would also change embedding_image from 1024d to
  // 1280d, making voyage-multimodal-3 unable to write to it. The same
  // class of bug applies to embedding_multimodal — leave both untouched.
  await engine.transaction(async (tx) => {
    // Text embedding column — transition to target dim.
    await tx.executeRaw(`DROP INDEX IF EXISTS idx_chunks_embedding`);
    await tx.executeRaw(`ALTER TABLE content_chunks DROP COLUMN IF EXISTS embedding`);
    await tx.executeRaw(`ALTER TABLE content_chunks ADD COLUMN embedding vector(${targetDim})`);
    // HNSW cap policy lives in vector-index.ts (single home): pgvector caps
    // `vector` HNSW at 2000 dims, so a valid 2048d target must skip the index
    // (exact scans stay correct) instead of failing the whole DDL.
    if (hnswIndexExpected('vector', targetDim)) {
      await tx.executeRaw(
        `CREATE INDEX IF NOT EXISTS idx_chunks_embedding ON content_chunks USING hnsw (embedding vector_cosine_ops)`,
      );
    }

    // Image/multimodal embedding column — rebuild index but preserve
    // existing dimension. Only create it if it doesn't already exist
    // (fresh brains may not have it yet). Partial WHERE clause matches
    // schema.sql:258-260 and pglite-schema.ts:198-200: HNSW footprint
    // scales with image-chunk count, not table size.
    const hasImageCol = await tx.executeRaw<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'content_chunks'
           AND column_name = 'embedding_image'
       ) AS exists`,
    );
    if (hasImageCol[0]?.exists) {
      await tx.executeRaw(`DROP INDEX IF EXISTS idx_chunks_embedding_image`);
      await tx.executeRaw(
        `CREATE INDEX IF NOT EXISTS idx_chunks_embedding_image
           ON content_chunks USING hnsw (embedding_image vector_cosine_ops)
           WHERE embedding_image IS NOT NULL`,
      );
    }

    // #3390: the OTHER two dim-pinned columns that carry TEXT-embedding-space
    // vectors. Both are created at brain-birth width (migrate.ts v55 for
    // query_cache, v42 for facts) and NO migration ever ALTERs them, so before
    // this fix a dimension change left them at the old width:
    //   - query_cache.embedding stayed narrow → every store() AND lookup()
    //     silently swallowed the width error (by design, so the cache can
    //     never break search), i.e. a PERMANENT 0% hit rate.
    //   - facts.embedding stayed narrow → every per-fact embed write failed
    //     ($N::vector into the old width), and the doctor check that would
    //     warn is skipped on PGLite (the DEFAULT engine).
    // Both are text-embedding-space columns, so they MUST move with
    // content_chunks.embedding. The image/multimodal columns above are the
    // deliberate exception (separate models, independent dims).
    for (const t of TEXT_EMBEDDING_DIM_PINNED_TABLES) {
      await transitionDimPinnedColumn(tx, t.table, t.index, t.indexSql, targetDim);
    }
  });

  // Post-tx data hygiene: the column rebuild NULLed every vector but left
  // embedded_at stamped — stale data that used to make coverage surfaces lie.
  // All READ paths now key on the vector itself (getStats/getHealth/getChunks
  // embedding_is_null), so this clear is belt-and-braces, DELIBERATELY outside
  // the DDL transaction: a ~1M-row UPDATE inside the ACCESS EXCLUSIVE window
  // would hold the exclusive lock through row churn (the pooler-contention
  // class pace-mode exists for), and a crash mid-batch leaves only
  // redundant-lie rows that nothing reads. Batched with an event-loop yield
  // between batches (setTimeout(0), NOT setImmediate — Bun starves the timers
  // phase under a tight setImmediate loop) so lock heartbeats keep firing.
  try {
    for (;;) {
      const res = await engine.executeRaw<{ n: number }>(
        `WITH b AS (SELECT id FROM content_chunks WHERE embedded_at IS NOT NULL LIMIT 50000),
              u AS (UPDATE content_chunks c SET embedded_at = NULL FROM b WHERE c.id = b.id RETURNING 1)
         SELECT count(*)::int AS n FROM u`,
      );
      if (!res[0] || Number(res[0].n) === 0) break;
      await new Promise((r) => setTimeout(r, 0));
    }
  } catch {
    // Best-effort: the vector column is the source of truth; a failed clear
    // must never fail the migration.
  }
}

/**
 * The dim-pinned TEXT-embedding-space columns outside content_chunks.
 * `indexSql` is a factory because each table's index carries its own partial
 * WHERE clause + opclass, and the opclass must match the column TYPE
 * (vector_cosine_ops vs halfvec_cosine_ops).
 */
export const TEXT_EMBEDDING_DIM_PINNED_TABLES: ReadonlyArray<{
  table: string;
  index: string;
  indexSql: (opclass: string) => string;
}> = [
  {
    table: 'query_cache',
    index: 'idx_query_cache_embedding_hnsw',
    indexSql: (opclass) =>
      `CREATE INDEX IF NOT EXISTS idx_query_cache_embedding_hnsw
         ON query_cache USING hnsw (embedding ${opclass})
         WHERE embedding IS NOT NULL`,
  },
  {
    table: 'facts',
    index: 'idx_facts_embedding_hnsw',
    indexSql: (opclass) =>
      `CREATE INDEX IF NOT EXISTS idx_facts_embedding_hnsw
         ON facts USING hnsw (embedding ${opclass})
         WHERE embedding IS NOT NULL AND expired_at IS NULL`,
  },
];

/**
 * Rebuild one dim-pinned embedding column at `targetDim`, PRESERVING its
 * existing column type (`vector` vs `halfvec` — migrate.ts picks halfvec when
 * the server supports it, and the HNSW opclass must match). No-op when the
 * table or column doesn't exist (fresh/older brains).
 *
 * Dropping the column discards the stored vectors, which is correct: they are
 * in the OLD embedding space and unusable after the swap. query_cache is a
 * cache (refills on the next query); facts re-embed on their next write /
 * `gbrain extract` pass.
 */
async function transitionDimPinnedColumn(
  tx: { executeRaw: <T = unknown>(sql: string, params?: unknown[]) => Promise<T[]> },
  table: string,
  indexName: string,
  indexSql: (opclass: string) => string,
  targetDim: number,
): Promise<void> {
  const probe = await tx.executeRaw<{ udt_name: string | null }>(
    `SELECT udt_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'embedding'`,
    [table],
  );
  const udt = probe[0]?.udt_name;
  if (!udt) return; // table or column absent — nothing to transition
  // Preserve the column type; anything unexpected falls back to `vector`.
  const columnType: 'vector' | 'halfvec' = udt.toLowerCase() === 'halfvec' ? 'halfvec' : 'vector';
  const opclass = columnType === 'halfvec' ? 'halfvec_cosine_ops' : 'vector_cosine_ops';

  await tx.executeRaw(`DROP INDEX IF EXISTS ${indexName}`);
  await tx.executeRaw(`ALTER TABLE ${table} DROP COLUMN IF EXISTS embedding`);
  await tx.executeRaw(`ALTER TABLE ${table} ADD COLUMN embedding ${columnType}(${targetDim})`);
  // HNSW has a per-type dimension ceiling; above it pgvector refuses the
  // index and exact scans remain the (correct, slower) path. Mirrors the
  // same guard in migrate.ts's original DDL.
  if (hnswIndexExpected(columnType, targetDim)) {
    await tx.executeRaw(indexSql(opclass));
  }
}

/**
 * Resume/state marker (DB plane). Present while a migration is in flight so
 * a re-run can detect + resume; cleared when the re-embed drains to zero.
 */
export const MIGRATION_STATE_KEY = 'embedding_migration.state';
/** ISO timestamp + summary of the last completed migration (DB plane). */
export const MIGRATION_COMPLETED_KEY = 'embedding_migration.completed';

export interface MigrationState {
  /** Marker schema version. Absent = v1 (pre-hardening). */
  version?: 2;
  to_model: string;
  to_dims: number;
  from_model: string;
  from_dims: number;
  /**
   * Preserved across same-target re-applies (set-if-absent) so `--status` and
   * doctor report the TRUE age of the migration, not the latest retry.
   */
  started_at: string;
  /** Set when the run used --force-sunset-target (resume command must too). */
  force_sunset_target?: boolean;
  /** Set when this marker replaced a live different-target marker. */
  retargeted_at?: string;
  /** History of abandoned targets (newest last) for --status forensics. */
  superseded?: Array<{ to_model: string; to_dims: number; started_at: string }>;
}

/**
 * Read + parse the live migration marker. Corrupt JSON returns
 * `{ corrupt: true, raw }` instead of throwing — every consumer of this is a
 * read-only/reporting surface that must never crash on a bad row.
 */
export async function readMigrationState(
  engine: BrainEngine,
): Promise<{ state: MigrationState | null; corrupt: boolean; raw: string | null }> {
  let raw: string | null = null;
  try {
    raw = await engine.getConfig(MIGRATION_STATE_KEY);
  } catch {
    return { state: null, corrupt: false, raw: null };
  }
  if (!raw) return { state: null, corrupt: false, raw: null };
  try {
    return { state: JSON.parse(raw) as MigrationState, corrupt: false, raw };
  } catch {
    return { state: null, corrupt: true, raw };
  }
}

export interface EmbeddingMigrationPlan {
  from_model: string;
  from_dims: number;
  /** Actual `content_chunks.embedding` vector(N) width (null = column absent). */
  column_dims: number | null;
  to_model: string;
  to_dims: number;
  /** True when the schema column must be rebuilt at a new width. */
  dim_change: boolean;
  /** Chunks not yet in the target embedding space (the migration workload). */
  chunks_to_embed: number;
  /** Characters across those chunks (feeds the cost estimate). */
  total_chars: number;
  /**
   * #3391 visibility: embedded chunks on pages with NO recorded signature
   * (pre-v108). Included in chunks_to_embed via includeNullSignature.
   */
  null_signature_chunks: number;
  est_cost_usd: number;
  /** False when the target model has no entry in EMBEDDING_PRICING. */
  price_known: boolean;
  /** True when a prior in-flight migration state matches this target. */
  resuming: boolean;
  /** Set when the brain's reranker is also on the outgoing provider. */
  reranker_warning: string | null;
  /**
   * DB-reality corroboration of the From line: top signatures actually
   * stamped on pages (env vars can lie about From; the census cannot).
   * `signature: null` bucket = pages with no recorded signature.
   */
  signature_census: Array<{ signature: string | null; pages: number }>;
}

export type MigrationApplyResult =
  | {
      status: 'applied';
      invalidated: number;
      cache_cleared: number;
      schema_transitioned: boolean;
      /** Dim-pinned columns repaired independently of a full rebuild. */
      pinned_repaired: string[];
    }
  | { status: 'refused'; reason: 'env_override'; warning: EnvOverrideWarning }
  | { status: 'failed'; reason: string };

/**
 * Env-presence probe (distinct from detectEnvOverride, which fires only on a
 * MISMATCH): true when GBRAIN_EMBEDDING_* is set at all. env == target is not
 * refused — it proceeds with a loud notice (env-first deployments are
 * legitimate) — but every surface that reports config planes needs to know.
 */
export function detectEnvPresence(
  env: NodeJS.ProcessEnv = process.env,
): { present: boolean; model: string | null; dims: string | null } {
  const model = env.GBRAIN_EMBEDDING_MODEL?.trim() || null;
  const dims = env.GBRAIN_EMBEDDING_DIMENSIONS?.trim() || null;
  return { present: Boolean(model || dims), model, dims };
}

/**
 * ONE computation for "does the schema need a (re)build?" shared by plan
 * (display) and apply (trigger) so they can never disagree. An absent or
 * unparsable column (dims === null) NEEDS a build — the old plan-side
 * `dims !== null && dims !== to` spelling showed no DESTRUCTIVE warning while
 * apply ran the DDL anyway.
 */
export function schemaRebuildNeeded(colDims: number | null, toDims: number): boolean {
  return colDims !== toDims;
}

/**
 * Widths of the dim-pinned TEXT-embedding-space columns outside
 * content_chunks. `null` dims = column exists but width unreadable; absent
 * tables/columns are omitted entirely (nothing to repair).
 */
export async function readDimPinnedWidths(
  engine: BrainEngine,
): Promise<Array<{ table: string; dims: number | null }>> {
  const out: Array<{ table: string; dims: number | null }> = [];
  for (const t of TEXT_EMBEDDING_DIM_PINNED_TABLES) {
    try {
      const rows = await engine.executeRaw<{ dim: number | null }>(
        `SELECT a.atttypmod AS dim
           FROM pg_attribute a
           JOIN pg_class c ON c.oid = a.attrelid
          WHERE c.relname = $1 AND a.attname = 'embedding'
            AND a.attnum > 0 AND NOT a.attisdropped`,
        [t.table],
      );
      if (rows.length === 0) continue; // table/column absent
      const dim = rows[0]?.dim;
      out.push({ table: t.table, dims: typeof dim === 'number' && dim > 0 ? dim : null });
    } catch {
      // Probe failure = unknown, not broken; skip (transition no-ops there too).
    }
  }
  return out;
}

/** `<provider:model>:<dims>` — must match currentEmbeddingSignature()'s shape. */
export function migrationSignature(toModel: string, toDims: number): string {
  return `${toModel}:${toDims}`;
}

/**
 * Resolve + validate the target `provider:model` and dimensions.
 * Throws with a paste-ready message on an unknown provider or when the
 * recipe declares no default dims and the caller passed none.
 */
export function resolveMigrationTarget(
  to: string,
  dimFlag?: number,
  opts?: { allowSunsetTarget?: boolean },
): { toModel: string; toDims: number } {
  if (!to.includes(':')) {
    throw new Error(
      `--to must be provider:model (e.g. openai:text-embedding-3-small). Got: ${to}`,
    );
  }
  // Throws AIConfigError with provider list on an unknown provider.
  const { recipe } = resolveRecipe(to);
  if (!recipe.touchpoints.embedding) {
    throw new Error(`Provider ${recipe.id} has no embedding support. Pick an embedding-capable provider:model.`);
  }
  // v0.46.3: refuse a PAID full re-embed onto a provider with an announced
  // shutdown — the live probe passes while the hosted API is still up, so
  // without this gate an agent replaying an old runbook could strand the
  // brain days before the shutdown. Same posture as ze-switch's forward
  // refusal; `--force-sunset-target` (self-hosters with a compatible
  // endpoint) is the loud escape hatch.
  if (recipe.sunset && !opts?.allowSunsetTarget) {
    throw new Error(
      `Refusing to migrate ONTO ${recipe.name}: its hosted API stops working on ` +
      `${recipe.sunset.date}, so this paid re-embed would strand the brain. ` +
      `Recommended target: ${recipe.sunset.replacement?.embedding ?? 'voyage:voyage-4'}. ` +
      `Self-hosting a compatible endpoint? Re-run with --force-sunset-target.`,
    );
  }
  const toDims = dimFlag ?? embeddingDimsForModel(recipe, to);
  if (!toDims || toDims <= 0) {
    throw new Error(
      `No default dimension known for ${to}. Pass --dim <N> explicitly (see the provider's docs for valid values).`,
    );
  }
  return { toModel: to, toDims };
}

/**
 * Pure read: compute the migration workload. Uses the stale-chunk predicates
 * with the TARGET signature + includeNullSignature so the count is
 * resume-aware — a re-plan mid-migration counts only what remains.
 */
export async function planEmbeddingMigration(
  engine: BrainEngine,
  opts: { to: string; dim?: number; fromModel?: string; fromDims?: number; allowSunsetTarget?: boolean },
): Promise<EmbeddingMigrationPlan> {
  const { toModel, toDims } = resolveMigrationTarget(opts.to, opts.dim, {
    allowSunsetTarget: opts.allowSunsetTarget,
  });

  // From-state: caller (CLI) passes the gateway-resolved values; fall back
  // to the shipped defaults for gateway-less contexts (unit tests, op probe).
  const fromModel = opts.fromModel ?? DEFAULT_EMBEDDING_MODEL;
  const fromDims = opts.fromDims ?? DEFAULT_EMBEDDING_DIMENSIONS;

  const col = await readContentChunksEmbeddingDim(engine);

  const sig = migrationSignature(toModel, toDims);
  let wide: number;
  let narrow: number;
  let totalChars: number;
  if (col.exists) {
    wide = await engine.countStaleChunks({ signature: sig, includeNullSignature: true });
    narrow = await engine.countStaleChunks({ signature: sig });
    totalChars = await engine.sumStaleChunkChars({ signature: sig, includeNullSignature: true });
  } else {
    // Column ABSENT: the stale predicates reference cc.embedding and would
    // throw. Every chunk needs embedding once the column is (re)built.
    const rows = await engine.executeRaw<{ n: number; chars: number }>(
      `SELECT count(*)::int AS n, COALESCE(sum(length(chunk_text)), 0)::bigint AS chars FROM content_chunks`,
    );
    wide = Number(rows[0]?.n ?? 0);
    narrow = wide;
    totalChars = Number(rows[0]?.chars ?? 0);
  }

  const price = lookupEmbeddingPrice(toModel);
  const estCostUsd = price.kind === 'known'
    ? estimateCostFromChars(totalChars, price.pricePerMTok)
    : 0;

  const marker = await readMigrationState(engine);
  const resuming = marker.state !== null
    && marker.state.to_model === toModel
    && marker.state.to_dims === toDims;

  // DB-reality census: what the pages themselves say they were embedded with.
  // Top 5 buckets; NULL = no recorded signature (pre-v108 or never stamped).
  let signatureCensus: Array<{ signature: string | null; pages: number }> = [];
  try {
    const rows = await engine.executeRaw<{ signature: string | null; pages: number }>(
      `SELECT embedding_signature AS signature, count(*)::int AS pages
         FROM pages
        WHERE deleted_at IS NULL
        GROUP BY embedding_signature
        ORDER BY count(*) DESC
        LIMIT 5`,
    );
    signatureCensus = rows.map((r) => ({ signature: r.signature, pages: Number(r.pages) }));
  } catch {
    // Census is informational; a probe failure never blocks planning.
  }

  // Sunset companion warning: migrating embeddings off a provider whose
  // reranker is still configured leaves rerank on the outgoing provider.
  let rerankerWarning: string | null = null;
  try {
    const rr = await engine.getConfig('search.reranker.model');
    const outgoingProvider = fromModel.split(':')[0];
    const targetProvider = toModel.split(':')[0];
    if (rr && outgoingProvider !== targetProvider && rr.startsWith(`${outgoingProvider}:`)) {
      rerankerWarning =
        `search.reranker.model is still ${rr} (the outgoing provider). ` +
        `If that provider is sunsetting, also update or disable the reranker: ` +
        `gbrain config set search.reranker.enabled false`;
    }
  } catch {
    // Reranker warning is cosmetic.
  }

  return {
    from_model: fromModel,
    from_dims: fromDims,
    column_dims: col.dims,
    to_model: toModel,
    to_dims: toDims,
    // ONE computation shared with apply's trigger (absent column ⇒ build).
    dim_change: schemaRebuildNeeded(col.dims, toDims),
    chunks_to_embed: wide,
    total_chars: totalChars,
    null_signature_chunks: wide - narrow,
    est_cost_usd: estCostUsd,
    price_known: price.kind === 'known',
    resuming,
    reranker_warning: rerankerWarning,
    signature_census: signatureCensus,
  };
}

/**
 * DB-reality convergence check — the ONLY basis on which the command may say
 * "nothing to migrate". Never trusts `from_model` (env vars poison it); every
 * conjunct is probed from the database or the file plane the caller read
 * WITHOUT env merge.
 */
export interface MigrationVerify {
  complete: boolean;
  blockers: string[];
  details: {
    column_dims: number | null;
    pinned_widths: Array<{ table: string; dims: number | null }>;
    stale_wide: number;
    missing_embeddings: number;
    chunkless_pages: number;
    marker: 'none' | 'same_target' | 'different_target' | 'corrupt';
    file_plane_ok: boolean;
  };
}

export async function verifyMigrationComplete(
  engine: BrainEngine,
  target: { toModel: string; toDims: number },
  opts: {
    /** File-plane config read WITHOUT env merge (loadConfigFileOnly). */
    filePlane?: { model?: string | null; dims?: number | null } | null;
    /** True when GBRAIN_EMBEDDING_* env exactly matches the target. */
    envMatchesTarget?: boolean;
    /** True when GBRAIN_EMBEDDING_* env is set at all. */
    envPresent?: boolean;
  } = {},
): Promise<MigrationVerify> {
  const blockers: string[] = [];

  // env≠target: the runtime would embed at a DIFFERENT model than the target
  // no matter what the DB says — a converged-looking brain is one process
  // restart away from re-poisoning. Never claim "nothing to migrate" here.
  if (opts.envPresent === true && opts.envMatchesTarget !== true) {
    blockers.push('GBRAIN_EMBEDDING_* env vars override the runtime AWAY from the target — unset them (or pass --ignore-env-override)');
  }

  const col = await readContentChunksEmbeddingDim(engine);
  if (schemaRebuildNeeded(col.dims, target.toDims)) {
    blockers.push(
      col.dims === null
        ? `embedding column is absent/unreadable — will be (re)built at ${target.toDims}d`
        : `embedding column is ${col.dims}d, target is ${target.toDims}d`,
    );
  }

  const pinned = await readDimPinnedWidths(engine);
  for (const p of pinned) {
    if (schemaRebuildNeeded(p.dims, target.toDims)) {
      blockers.push(`${p.table}.embedding is ${p.dims === null ? 'unreadable' : `${p.dims}d`}, target is ${target.toDims}d`);
    }
  }

  const sig = migrationSignature(target.toModel, target.toDims);
  let staleWide = 0;
  if (col.exists) {
    staleWide = await engine.countStaleChunks({ signature: sig, includeNullSignature: true });
  } else {
    // Absent column: the stale predicate would throw; every chunk is pending.
    const rows = await engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM content_chunks`,
    );
    staleWide = Number(rows[0]?.n ?? 0);
  }
  if (staleWide > 0) {
    blockers.push(`${staleWide} chunk(s) not in the target embedding space`);
  }

  // Belt-and-braces raw NULL residue via the (post-truth-fix) health count —
  // no pages JOIN divergence, embed_skip already excluded on both engines.
  let missing = 0;
  try {
    missing = (await engine.getHealth()).missing_embeddings;
  } catch {
    // Health probe failure: report-only conjunct, don't block on it.
  }
  if (missing > 0 && staleWide === 0) {
    blockers.push(`${missing} chunk(s) have NULL vectors outside the stale predicate`);
  }

  // Contentful pages with zero chunk rows: the embed drain heals these, so a
  // brain with any is NOT converged (round-2 #6; same census the drain uses).
  let chunkless = 0;
  try {
    chunkless = await engine.countChunklessPagesWithContent();
  } catch {
    // Optional census; older engines without the method just skip it.
  }
  if (chunkless > 0) {
    blockers.push(`${chunkless} contentful page(s) have no chunks yet (the re-embed pass heals these)`);
  }

  const marker = await readMigrationState(engine);
  let markerState: MigrationVerify['details']['marker'] = 'none';
  if (marker.corrupt) {
    markerState = 'corrupt';
    blockers.push('migration state marker is corrupt (treated as in-flight; completing the run rewrites it)');
  } else if (marker.state) {
    const same = marker.state.to_model === target.toModel && marker.state.to_dims === target.toDims;
    markerState = same ? 'same_target' : 'different_target';
    if (same) {
      blockers.push(`a migration to this target started ${marker.state.started_at} is still in flight — resuming it`);
    }
    // different_target is the caller's --retarget decision, not a convergence
    // blocker for THIS target; readMigrationStatus surfaces it.
  }

  const fp = opts.filePlane;
  const filePlaneOk = fp
    ? fp.model === target.toModel && Number(fp.dims) === target.toDims
    : opts.envMatchesTarget === true; // env-canonical mode: no file plane, env pins the target
  if (!filePlaneOk) {
    blockers.push('runtime config (file plane) does not point at the target yet');
  }

  return {
    complete: blockers.length === 0,
    blockers,
    details: {
      column_dims: col.dims,
      pinned_widths: pinned,
      stale_wide: staleWide,
      missing_embeddings: missing,
      chunkless_pages: chunkless,
      marker: markerState,
      file_plane_ok: filePlaneOk,
    },
  };
}

/**
 * Apply the non-embed half of the migration: env gate, state marker, schema
 * transition (dim changes only), DB-plane config, file-plane persistence
 * (via callback — the core module never touches ~/.gbrain), stale-signature
 * invalidation (#3391: includeNullSignature), and query-cache purge.
 *
 * Ordering makes every step idempotent under a crash + re-run:
 *   state marker → schema → config → invalidate → cache purge.
 * A crash anywhere leaves the state marker set; the re-run re-executes the
 * remaining steps (schema transition no-ops when the column is already at
 * the target width via the actual-width probe; invalidation matches nothing
 * the second time).
 */
export async function applyEmbeddingMigration(
  engine: BrainEngine,
  plan: EmbeddingMigrationPlan,
  opts: {
    ignoreEnvOverride?: boolean;
    /** Persist target model+dims to the file plane + reconfigure the gateway. */
    persistConfig?: (toModel: string, toDims: number) => void | Promise<void>;
    /** Stamped into the marker so the printed resume command is complete. */
    forceSunsetTarget?: boolean;
  } = {},
): Promise<MigrationApplyResult> {
  const envWarning = detectEnvOverride(plan.to_model, plan.to_dims);
  if (envWarning.triggered && !opts.ignoreEnvOverride) {
    return { status: 'refused', reason: 'env_override', warning: envWarning };
  }

  try {
    // 1. State marker FIRST — a crash after any later step is resumable.
    //    Same-target re-apply PRESERVES the original started_at (set-if-
    //    absent) so status/doctor report the migration's true age; a
    //    different-target live marker is pushed into `superseded` (the caller
    //    already gated the retarget decision).
    const prior = await readMigrationState(engine);
    const now = new Date().toISOString();
    const sameTarget = prior.state !== null
      && prior.state.to_model === plan.to_model
      && prior.state.to_dims === plan.to_dims;

    const state: MigrationState = {
      version: 2,
      to_model: plan.to_model,
      to_dims: plan.to_dims,
      from_model: plan.from_model,
      from_dims: plan.from_dims,
      started_at: now,
    };
    if (opts.forceSunsetTarget) state.force_sunset_target = true;
    if (sameTarget && prior.state) {
      // Resume: keep the original run's identity.
      state.from_model = prior.state.from_model;
      state.from_dims = prior.state.from_dims;
      state.started_at = prior.state.started_at;
      if (prior.state.retargeted_at) state.retargeted_at = prior.state.retargeted_at;
      if (prior.state.superseded) state.superseded = prior.state.superseded;
    } else if (prior.state) {
      // Retarget: record the abandoned target's identity.
      state.retargeted_at = now;
      state.superseded = [
        ...(prior.state.superseded ?? []),
        { to_model: prior.state.to_model, to_dims: prior.state.to_dims, started_at: prior.state.started_at },
      ];
    }
    await engine.setConfig(MIGRATION_STATE_KEY, JSON.stringify(state));

    // 2. Schema work — probe again (the plan may be stale after a resume) and
    //    repair each dim-pinned column INDEPENDENTLY (round-2 #9): a brain
    //    whose chunks column is already at target but whose facts/query_cache
    //    stayed narrow gets those repaired without a full destructive rebuild.
    let schemaTransitioned = false;
    const pinnedRepaired: string[] = [];
    const col = await readContentChunksEmbeddingDim(engine);
    if (schemaRebuildNeeded(col.dims, plan.to_dims)) {
      await runSchemaTransition(engine, plan.to_dims);
      schemaTransitioned = true;
    } else {
      const pinned = await readDimPinnedWidths(engine);
      const stalePinned = pinned.filter((p) => schemaRebuildNeeded(p.dims, plan.to_dims));
      if (stalePinned.length > 0) {
        await engine.transaction(async (tx) => {
          for (const t of TEXT_EMBEDDING_DIM_PINNED_TABLES) {
            if (stalePinned.some((p) => p.table === t.table)) {
              await transitionDimPinnedColumn(tx, t.table, t.index, t.indexSql, plan.to_dims);
              pinnedRepaired.push(t.table);
            }
          }
        });
      }
    }

    // 3. #3391: mark EVERYTHING not in the target space as stale, including
    //    NULL-signature (pre-v108) pages. After a schema transition this is
    //    a cheap no-op (the column rebuild already nulled every embedding).
    //
    //    ORDERING (adversarial review): invalidation MUST precede the config
    //    writes below. On a SAME-dim provider swap there is no schema
    //    transition to null the vectors, so a crash between "config says new
    //    provider" and "old vectors invalidated" would leave NEW-space query
    //    embeddings scored against OLD-space document vectors — silently
    //    WRONG results. Invalidating first makes the crash window safe:
    //    config still says the old provider, and the rows are merely stale
    //    (empty/degraded results, never wrong ones).
    const invalidated = await engine.invalidateStaleSignatureEmbeddings({
      signature: migrationSignature(plan.to_model, plan.to_dims),
      includeNullSignature: true,
    });

    // 4. DB-plane config (doctor's embedding_width_consistency reads these).
    await engine.setConfig('embedding_model', plan.to_model);
    await engine.setConfig('embedding_dimensions', String(plan.to_dims));

    // 5. File plane + gateway (the embed pipeline reads file/env, not DB).
    await opts.persistConfig?.(plan.to_model, plan.to_dims);

    // 6. Purge the semantic query cache. The knobs hash folds provider:model
    //    for callers that thread KnobsHashContext, but legacy callers fall
    //    back to 'default' — a row they wrote pre-migration must not be
    //    served post-migration. Best-effort (cache must never block).
    let cacheCleared = 0;
    try {
      const { SemanticQueryCache } = await import('./search/query-cache.ts');
      cacheCleared = await new SemanticQueryCache(engine).clear({});
    } catch {
      // Table may not exist on old brains; a miss here is harmless.
    }

    return {
      status: 'applied',
      invalidated,
      cache_cleared: cacheCleared,
      schema_transitioned: schemaTransitioned,
      pinned_repaired: pinnedRepaired,
    };
  } catch (err) {
    return { status: 'failed', reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Stamp the target signature on every page that is fully embedded but not yet
 * stamped. Call after the re-embed drain, BEFORE the completion probe.
 *
 * Why this exists (adversarial review): the embed loop only stamps a page when
 * `stale.length === existing.length` — i.e. when every one of the page's
 * chunks was in the SAME batch. `listStaleChunks` is a plain keyset LIMIT with
 * no page alignment, so on any corpus larger than one batch (default 2000
 * chunks) the page straddling each boundary is embedded correctly but never
 * stamped. Without this reconcile the command reports "incomplete" + exit 1 on
 * a perfectly-migrated brain, and the re-run re-invalidates and PAYS AGAIN for
 * those pages — breaking the "already-migrated chunks are never re-embedded"
 * contract.
 *
 * Safety: this is only sound because `applyEmbeddingMigration` invalidated
 * (NULLed) every chunk that was NOT already in the target space. So "page has
 * zero NULL-embedding chunks" ⇒ "every chunk on this page was embedded in the
 * target space during this run". Pages with any remaining NULL chunk (a real
 * embed failure) are deliberately left unstamped so the completion probe still
 * reports them.
 *
 * Returns the number of pages stamped.
 */
export async function reconcilePageSignatures(
  engine: BrainEngine,
  plan: EmbeddingMigrationPlan,
): Promise<number> {
  const sig = migrationSignature(plan.to_model, plan.to_dims);
  const rows = await engine.executeRaw<{ slug: string }>(
    `UPDATE pages p
        SET embedding_signature = $1
      WHERE p.deleted_at IS NULL
        AND (p.embedding_signature IS DISTINCT FROM $1)
        AND EXISTS (SELECT 1 FROM content_chunks c WHERE c.page_id = p.id)
        AND NOT EXISTS (
          SELECT 1 FROM content_chunks c
           WHERE c.page_id = p.id AND c.embedding IS NULL
        )
      RETURNING p.slug`,
    [sig],
  );
  return (rows as unknown[]).length;
}

/**
 * Finish bookkeeping after the re-embed drains: clear the in-flight marker,
 * stamp the completion record. Call ONLY when countStaleChunks() === 0.
 *
 * ONE transaction (round-2 #10): delete + insert as separate writes had a
 * crash window that lost BOTH the resume state and the completion receipt —
 * and the verified skip would then read the brain as trivially converged
 * with no record of what happened.
 *
 * `extra` is merged into the completion record (e.g. verify_search from the
 * completion smoke check). Keep it small and content-free — this row lands
 * in config-table dumps and logs.
 */
export async function completeEmbeddingMigration(
  engine: BrainEngine,
  plan: EmbeddingMigrationPlan,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const completed = JSON.stringify({
    to_model: plan.to_model,
    to_dims: plan.to_dims,
    from_model: plan.from_model,
    completed_at: new Date().toISOString(),
    ...extra,
  });
  await engine.transaction(async (tx) => {
    await tx.executeRaw(`DELETE FROM config WHERE key = $1`, [MIGRATION_STATE_KEY]);
    await tx.executeRaw(
      `INSERT INTO config (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [MIGRATION_COMPLETED_KEY, completed],
    );
  });
}
