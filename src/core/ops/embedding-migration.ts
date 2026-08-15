/**
 * Embedding-migration operation cluster — pure move from operations.ts
 * (v0.46.x tranche 3): the #3390 provider-agnostic migrate_embeddings
 * local-only admin op. Op const stays module-private;
 * `embeddingMigrationOperations` below is spliced into the canonical
 * `operations` array in ../operations.ts at the cluster's original position.
 * Never import from '../operations.ts' here (cycle).
 */

import type { Operation } from './contract.ts';

// --- #3390: provider-agnostic embedding migration ---

const migrate_embeddings: Operation = {
  name: 'migrate_embeddings',
  description: 'Re-embed the brain onto a different embedding provider/model (#3390): schema dimension transition, NULL-signature (#3391) invalidation, query-cache purge, resumable re-embed. Without yes=true returns the plan + cost estimate only. Local-only admin op; the primary surface is `gbrain migrate embeddings`.',
  params: {
    to: { type: 'string', required: true, description: 'Target provider:model (e.g. openai:text-embedding-3-small).' },
    dim: { type: 'number', description: "Target dimensions. Defaults to the provider recipe's declared width; required when the recipe declares none." },
    dry_run: { type: 'boolean', description: 'Plan + cost estimate only; change nothing.' },
    yes: { type: 'boolean', description: 'Confirm the re-embed spend + destructive schema change. Required for a live run.' },
  },
  mutating: true,
  scope: 'admin',
  localOnly: true,
  handler: async (ctx, p) => {
    // Belt-and-braces on top of localOnly (the get_recent_transcripts
    // pattern): a schema-rebuilding, money-spending op must never be
    // reachable from a remote transport even if a future dispatch path
    // forgets the localOnly filter.
    if (ctx.remote !== false) {
      throw new Error('migrate_embeddings is local-only. Run `gbrain migrate embeddings` on the host.');
    }
    const {
      planEmbeddingMigration, applyEmbeddingMigration, completeEmbeddingMigration,
      reconcilePageSignatures, migrationSignature,
    } = await import('../embedding-migration.ts');
    const to = p.to as string;
    const dim = p.dim as number | undefined;
    let fromModel: string | undefined;
    let fromDims: number | undefined;
    try {
      const { getEmbeddingModel, getEmbeddingDimensions } = await import('../ai/gateway.ts');
      fromModel = getEmbeddingModel();
      fromDims = getEmbeddingDimensions();
    } catch { /* gateway unconfigured — plan falls back to defaults */ }
    const plan = await planEmbeddingMigration(ctx.engine, {
      to,
      ...(dim !== undefined && { dim }),
      ...(fromModel !== undefined && { fromModel }),
      ...(fromDims !== undefined && { fromDims }),
    });
    if (ctx.dryRun || p.dry_run === true || p.yes !== true) {
      return { status: p.yes === true || p.dry_run === true ? 'planned' : 'needs_confirmation', plan };
    }
    const { persistEmbeddingFileConfig, probeTargetProvider } = await import('../../commands/migrate-embeddings.ts');
    // Safety parity with the CLI path: probe the target provider BEFORE any
    // mutation. Without this, `yes:true` would drop the embedding column and
    // only then discover the key/model/dim is wrong.
    const probe = await probeTargetProvider(plan.to_model, plan.to_dims);
    if (!probe.ok) return { status: 'failed', reason: probe.message, plan };
    const applied = await applyEmbeddingMigration(ctx.engine, plan, {
      persistConfig: (m, d) => persistEmbeddingFileConfig(m, d),
    });
    if (applied.status !== 'applied') return { ...applied, plan };
    const { runEmbedCore } = await import('../../commands/embed.ts');
    // singleFlight parity with the CLI path: takes the same per-source
    // embed-backfill lock so this can't race a queued embed-backfill job on
    // the NULL→non-NULL upsert (the TODOS:2299 class).
    const embedResult = await runEmbedCore(ctx.engine, {
      stale: true, catchUp: true, singleFlight: true, includeNullSignature: true, quiet: true,
    });
    // Stamp batch-boundary pages before probing for completion (see
    // reconcilePageSignatures — the embed loop's all-or-nothing stamp rule
    // skips any page split across two stale batches).
    const reconciled = await reconcilePageSignatures(ctx.engine, plan);
    const remaining = await ctx.engine.countStaleChunks({
      signature: migrationSignature(plan.to_model, plan.to_dims),
      includeNullSignature: true,
    });
    if (remaining === 0) await completeEmbeddingMigration(ctx.engine, plan);
    return {
      status: remaining === 0 ? 'completed' : 'incomplete',
      plan,
      embedded: embedResult.embedded,
      remaining,
      signatures_reconciled: reconciled,
      invalidated: applied.invalidated,
      schema_transitioned: applied.schema_transitioned,
      cache_cleared: applied.cache_cleared,
    };
  },
  cliHints: { name: 'migrate-embeddings', hidden: true },
};

export const embeddingMigrationOperations: Operation[] = [migrate_embeddings];
