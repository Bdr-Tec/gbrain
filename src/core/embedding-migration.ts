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
import { detectEnvOverride, type EnvOverrideWarning } from './retrieval-upgrade-planner.ts';
import { runSchemaTransition } from './retrieval-upgrade-planner.ts';
import { readContentChunksEmbeddingDim } from './embedding-dim-check.ts';
import { DEFAULT_EMBEDDING_MODEL, DEFAULT_EMBEDDING_DIMENSIONS } from './ai/defaults.ts';

/**
 * Resume/state marker (DB plane). Present while a migration is in flight so
 * a re-run can detect + resume; cleared when the re-embed drains to zero.
 */
export const MIGRATION_STATE_KEY = 'embedding_migration.state';
/** ISO timestamp + summary of the last completed migration (DB plane). */
export const MIGRATION_COMPLETED_KEY = 'embedding_migration.completed';

export interface MigrationState {
  to_model: string;
  to_dims: number;
  from_model: string;
  from_dims: number;
  started_at: string;
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
}

export type MigrationApplyResult =
  | { status: 'applied'; invalidated: number; cache_cleared: number; schema_transitioned: boolean }
  | { status: 'refused'; reason: 'env_override'; warning: EnvOverrideWarning }
  | { status: 'failed'; reason: string };

/** `<provider:model>:<dims>` — must match currentEmbeddingSignature()'s shape. */
export function migrationSignature(toModel: string, toDims: number): string {
  return `${toModel}:${toDims}`;
}

/**
 * Resolve + validate the target `provider:model` and dimensions.
 * Throws with a paste-ready message on an unknown provider or when the
 * recipe declares no default dims and the caller passed none.
 */
export function resolveMigrationTarget(to: string, dimFlag?: number): { toModel: string; toDims: number } {
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
  opts: { to: string; dim?: number; fromModel?: string; fromDims?: number },
): Promise<EmbeddingMigrationPlan> {
  const { toModel, toDims } = resolveMigrationTarget(opts.to, opts.dim);

  // From-state: caller (CLI) passes the gateway-resolved values; fall back
  // to the shipped defaults for gateway-less contexts (unit tests, op probe).
  const fromModel = opts.fromModel ?? DEFAULT_EMBEDDING_MODEL;
  const fromDims = opts.fromDims ?? DEFAULT_EMBEDDING_DIMENSIONS;

  const col = await readContentChunksEmbeddingDim(engine);

  const sig = migrationSignature(toModel, toDims);
  const wide = await engine.countStaleChunks({ signature: sig, includeNullSignature: true });
  const narrow = await engine.countStaleChunks({ signature: sig });
  const totalChars = await engine.sumStaleChunkChars({ signature: sig, includeNullSignature: true });

  const price = lookupEmbeddingPrice(toModel);
  const estCostUsd = price.kind === 'known'
    ? estimateCostFromChars(totalChars, price.pricePerMTok)
    : 0;

  let resuming = false;
  try {
    const stateStr = await engine.getConfig(MIGRATION_STATE_KEY);
    if (stateStr) {
      const state = JSON.parse(stateStr) as MigrationState;
      resuming = state.to_model === toModel && state.to_dims === toDims;
    }
  } catch {
    // Corrupt state marker — treat as fresh.
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
    dim_change: col.dims !== null && col.dims !== toDims,
    chunks_to_embed: wide,
    total_chars: totalChars,
    null_signature_chunks: wide - narrow,
    est_cost_usd: estCostUsd,
    price_known: price.kind === 'known',
    resuming,
    reranker_warning: rerankerWarning,
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
  } = {},
): Promise<MigrationApplyResult> {
  const envWarning = detectEnvOverride(plan.to_model, plan.to_dims);
  if (envWarning.triggered && !opts.ignoreEnvOverride) {
    return { status: 'refused', reason: 'env_override', warning: envWarning };
  }

  try {
    // 1. State marker FIRST — a crash after any later step is resumable.
    const state: MigrationState = {
      to_model: plan.to_model,
      to_dims: plan.to_dims,
      from_model: plan.from_model,
      from_dims: plan.from_dims,
      started_at: new Date().toISOString(),
    };
    await engine.setConfig(MIGRATION_STATE_KEY, JSON.stringify(state));

    // 2. Schema transition when the ACTUAL column width differs from the
    //    target (probe again — the plan may be stale after a resume).
    let schemaTransitioned = false;
    const col = await readContentChunksEmbeddingDim(engine);
    if (col.dims !== plan.to_dims) {
      await runSchemaTransition(engine, plan.to_dims);
      schemaTransitioned = true;
    }

    // 3. DB-plane config (doctor's embedding_width_consistency reads these).
    await engine.setConfig('embedding_model', plan.to_model);
    await engine.setConfig('embedding_dimensions', String(plan.to_dims));

    // 4. File plane + gateway (the embed pipeline reads file/env, not DB).
    await opts.persistConfig?.(plan.to_model, plan.to_dims);

    // 5. #3391: mark EVERYTHING not in the target space as stale, including
    //    NULL-signature (pre-v108) pages. After a schema transition this is
    //    a cheap no-op (the column rebuild already nulled every embedding).
    const invalidated = await engine.invalidateStaleSignatureEmbeddings({
      signature: migrationSignature(plan.to_model, plan.to_dims),
      includeNullSignature: true,
    });

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

    return { status: 'applied', invalidated, cache_cleared: cacheCleared, schema_transitioned: schemaTransitioned };
  } catch (err) {
    return { status: 'failed', reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Finish bookkeeping after the re-embed drains: clear the in-flight marker,
 * stamp the completion record. Call ONLY when countStaleChunks() === 0.
 */
export async function completeEmbeddingMigration(
  engine: BrainEngine,
  plan: EmbeddingMigrationPlan,
): Promise<void> {
  await engine.unsetConfig(MIGRATION_STATE_KEY);
  await engine.setConfig(
    MIGRATION_COMPLETED_KEY,
    JSON.stringify({
      to_model: plan.to_model,
      to_dims: plan.to_dims,
      from_model: plan.from_model,
      completed_at: new Date().toISOString(),
    }),
  );
}
