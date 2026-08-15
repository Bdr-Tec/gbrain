/**
 * advisor/collect-setup-smells.ts — config/setup misconfigurations.
 *
 * Reads merged config + DB-plane keys. Each smell is a concrete, fixable setup
 * problem an owner usually wants to know about: embeddings disabled while a
 * populated brain wants search, a missing embedding key, or skill publishing off
 * while a remote-MCP brain serves agents (they'd hit an empty list_skills).
 */

import type { AdvisorCollector, AdvisorFinding } from './types.ts';

async function dbBool(ctx: { engine: { getConfig(k: string): Promise<string | null> } }, key: string): Promise<boolean | null> {
  try {
    const v = await ctx.engine.getConfig(key);
    if (v == null) return null;
    return v === 'true';
  } catch {
    return null;
  }
}

export const collectSetupSmells: AdvisorCollector = {
  id: 'setup-smells',
  collect: async (ctx) => {
    const findings: AdvisorFinding[] = [];
    const cfg = ctx.config ?? ({} as typeof ctx.config);

    // Embeddings disabled — deferred setup never completed.
    if (cfg.embedding_disabled === true) {
      findings.push({
        id: 'embeddings_disabled',
        severity: 'warn',
        title: 'Embeddings are disabled — semantic search and dedup are off.',
        detail: 'Set an embedding model to turn on vector search.',
        fix: { command_argv: ['gbrain', 'config', 'set', 'embedding_model', '<model-id>'] },
        collector: 'setup-smells',
        ask_user: true,
      });
    } else if (
      !cfg.embedding_model &&
      !cfg.voyage_api_key &&
      !process.env.VOYAGE_API_KEY &&
      !process.env.OPENAI_API_KEY
    ) {
      // No key for the recommended providers anywhere → embeds will fail.
      // No command_argv: API keys are env/file-plane only (`gbrain config set
      // voyage_api_key` writes the DB plane, which the embedding pipeline
      // never reads — see src/core/config.ts's two-plane doc).
      findings.push({
        id: 'embedding_key_missing',
        severity: 'warn',
        title: 'No embedding provider key is set — embedding will fail at write time.',
        detail:
          'Set VOYAGE_API_KEY in the environment (or add voyage_api_key to ~/.gbrain/config.json), ' +
          'then `gbrain init --force --embedding-model voyage:voyage-4`. OPENAI_API_KEY works too.',
        fix: { command_argv: null },
        collector: 'setup-smells',
        ask_user: true,
      });
    }

    // Remote-MCP brain serving agents but skill publishing is off → agents hit
    // an empty list_skills and never learn what the brain can do.
    if (cfg.remote_mcp) {
      const publishDb = await dbBool(ctx, 'mcp.publish_skills');
      const publish = publishDb ?? cfg.mcp?.publish_skills === true;
      if (!publish) {
        findings.push({
          id: 'publish_skills_off',
          severity: 'info',
          title: 'Skill publishing is off while this brain serves agents over MCP.',
          detail: 'Connected agents get an empty list_skills and miss this brain\'s capabilities.',
          fix: { command_argv: ['gbrain', 'config', 'set', 'mcp.publish_skills', 'true'] },
          collector: 'setup-smells',
          ask_user: true,
        });
      }
    }

    return findings;
  },
};
