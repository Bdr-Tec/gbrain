/**
 * #2119-class DB-plane read-side merge (also #2137/#4297).
 *
 * DB-plane values that `gbrain config set` accepted for years, `config get`
 * echoed back, and NOTHING read: provider credentials, chat/expansion model
 * pins, the chat fallback chain, and flat `cycle.*` knobs. This module owns
 * their sparse-merge into the loaded config — called by
 * `loadConfigWithEngine()` (src/core/config.ts) after its per-key merges,
 * with the same precedence: env > file > DB.
 *
 * Sibling module (not inlined in config.ts) per the module-size ratchet;
 * runtime dependency direction is config.ts → here (the GBrainConfig import
 * below is type-only, erased at compile time — no cycle).
 *
 * NEVER merged from the DB: `embedding_model` / `embedding_dimensions`. They
 * size the schema, must be stable across engine connect, and `gbrain config
 * set` hard-refuses them — a stale DB row must not resurrect the plane-split
 * footgun the #4287 fixes closed. Do not add them to any list here.
 */

import type { GBrainConfig } from './config.ts';

/**
 * The provider-credential fields sparse-merged from the DB plane. `gbrain
 * config set <vendor>_api_key` routes NEW writes to the file plane
 * (FILE_PLANE_API_KEYS in src/commands/config.ts, kept in sync by
 * test/loadConfig-merge.test.ts), but values that reached the DB anyway —
 * pre-routing writes, direct `engine.setConfig`, remote setups — used to be
 * accepted, echoed back by `config get`, and read by nothing. Merging them
 * makes the DB copy honest instead of a lie. Env presence is already folded
 * into the base config by the sync `loadConfig()` (and for the provider keys
 * it doesn't fold, `mergedProviderEnv` gives process-env precedence
 * downstream anyway), so `merged[field] === undefined` means neither env nor
 * file spoke and the DB may fill in.
 */
export const DB_MERGED_PROVIDER_KEY_FIELDS = [
  'openai_api_key',
  'anthropic_api_key',
  'zeroentropy_api_key',
  'openrouter_api_key',
  'voyage_api_key',
  'dashscope_api_key',
  'google_api_key',
  'azure_openai_api_key',
] as const;

/**
 * Apply the #2119 read-side merges to `merged` IN PLACE (matches the
 * mutate-`merged` style of every other branch in loadConfigWithEngine).
 * `dbStr` / `dbPrefixMap` are the caller's quiet-failure DB readers — a
 * missing config table (pre-v36 brain mid-migration) yields undefined and
 * file/env defaults win.
 */
export async function applyDbPlaneReadSideMerge(
  merged: GBrainConfig,
  dbStr: (key: string) => Promise<string | undefined>,
  dbPrefixMap: (prefix: string) => Promise<Record<string, string> | undefined>,
): Promise<void> {
  const dbMergedStringFields = [
    ...DB_MERGED_PROVIDER_KEY_FIELDS,
    'expansion_model',
    'chat_model',
  ] as const;
  for (const field of dbMergedStringFields) {
    if (merged[field] !== undefined) continue;
    const v = await dbStr(field);
    if (v !== undefined) merged[field] = v;
  }

  // chat_fallback_chain — stored as a string in the DB plane. Accept the same
  // comma-separated form the GBRAIN_CHAT_FALLBACK_CHAIN env var uses, plus a
  // JSON string-array (what a tooling writer would naturally store). A
  // malformed JSON payload warns and is ignored (mirrors embedding_columns);
  // an empty chain is treated as unset, never `[]` — no value → no field,
  // the same container discipline as every other merge branch.
  if (merged.chat_fallback_chain === undefined) {
    const rawChain = await dbStr('chat_fallback_chain');
    if (rawChain !== undefined) {
      let chain: string[] | undefined;
      if (rawChain.trim().startsWith('[')) {
        try {
          const parsed = JSON.parse(rawChain);
          if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string')) {
            chain = parsed.map((s) => s.trim()).filter(Boolean);
          } else {
            console.warn('[gbrain] config: chat_fallback_chain DB value is not a JSON array of strings; ignoring');
          }
        } catch (err) {
          console.warn(`[gbrain] config: chat_fallback_chain DB value is not valid JSON; ignoring (${(err as Error).message})`);
        }
      } else {
        chain = rawChain.split(',').map((s) => s.trim()).filter(Boolean);
      }
      if (chain !== undefined && chain.length > 0) {
        merged.chat_fallback_chain = chain;
      }
    }
  }

  // Flat cycle.* merge (#2137/#4297 read-side). One listConfigKeys('cycle.')
  // walk; leaves keep their raw string values (each consumer owns its parse,
  // same contract as reading engine.getConfig directly). Per-leaf precedence
  // file > DB, mirroring provider_base_urls.
  const dbCycle = await dbPrefixMap('cycle.');
  if (dbCycle !== undefined) {
    const nextCycle: Record<string, string> = { ...(merged.cycle ?? {}) };
    for (const [leaf, value] of Object.entries(dbCycle)) {
      if (nextCycle[leaf] === undefined) nextCycle[leaf] = value;
    }
    if (Object.keys(nextCycle).length > 0) {
      merged.cycle = nextCycle;
    }
  }
}
