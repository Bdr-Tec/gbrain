/**
 * Extraction quarantine lane (issue #160).
 *
 * `extractAndEnrich` regex-extracts entity names from arbitrary ingested text
 * and creates `people/{slug}` / `companies/{slug}` stub pages. When the input
 * text comes from an untrusted channel (anything that is not the trusted local
 * CLI with an explicit opt-in), those stubs must NOT enter the brain as
 * authoritative entity pages. Instead they land in the quarantine lane:
 * ordinary pages carrying two frontmatter markers —
 *
 *   provenance: 'auto-extracted'   — HOW the page came to exist
 *   status:     'unverified'       — the owner has not reviewed it yet
 *
 * Consequences of the markers (each enforced at its own site):
 *   - Search: unverified stubs are excluded from the compiled-truth authority
 *     boost (they rank as ordinary content) and results carry
 *     `unverified: true` so agents can label the provenance.
 *   - Review: `extraction_pending` lists them; `extraction_review` promotes
 *     (status → 'verified', provenance kept for audit) or rejects
 *     (soft-delete) in batch. Promotion is local-owner-only.
 *   - Doctor: counts unverified stubs older than N days as a review nudge.
 *
 * Fail-closed trust rule (mirrors OperationContext.remote): only an explicit
 * `trusted: true` writes direct; undefined/false/anything-else quarantines.
 *
 * Sibling of `src/core/quarantine.ts` / `src/core/embed-skip.ts` — same
 * marker-as-frontmatter-JSONB pattern, same "SQL fragment lives next to the
 * marker key so they can never drift" rule. No schema migration needed.
 */

// ---------------------------------------------------------------------------
// Marker keys + values (stable contract)
// ---------------------------------------------------------------------------

export const EXTRACTION_PROVENANCE_KEY = 'provenance';
export const EXTRACTION_STATUS_KEY = 'status';

export const PROVENANCE_AUTO_EXTRACTED = 'auto-extracted';
export const STATUS_UNVERIFIED = 'unverified';
export const STATUS_VERIFIED = 'verified';

/** Frontmatter markers to spread onto a quarantined stub at create time. */
export function quarantineMarkers(): Record<string, string> {
  return {
    [EXTRACTION_PROVENANCE_KEY]: PROVENANCE_AUTO_EXTRACTED,
    [EXTRACTION_STATUS_KEY]: STATUS_UNVERIFIED,
  };
}

/**
 * JS-side predicate: true only when BOTH markers match. Requiring the pair
 * means user pages that happen to carry their own `status` or `provenance`
 * frontmatter are never captured by the review lane.
 */
export function isUnverifiedExtraction(
  frontmatter: Record<string, unknown> | null | undefined,
): boolean {
  if (!frontmatter) return false;
  return (
    frontmatter[EXTRACTION_PROVENANCE_KEY] === PROVENANCE_AUTO_EXTRACTED &&
    frontmatter[EXTRACTION_STATUS_KEY] === STATUS_UNVERIFIED
  );
}

/**
 * SQL fragment matching unverified auto-extracted stubs, parameterized on the
 * page-table alias. Single source of truth for every SQL-side consumer
 * (extraction_pending list, doctor count) so the filter and the marker keys
 * can never drift. `pageAlias` is engine-supplied (never user input).
 * JSONB `->>` works identically on Postgres and PGLite (PostgreSQL-in-WASM).
 */
export function unverifiedExtractionFragment(pageAlias: string): string {
  return (
    `(COALESCE(${pageAlias}.frontmatter, '{}'::jsonb) ->> '${EXTRACTION_PROVENANCE_KEY}') = '${PROVENANCE_AUTO_EXTRACTED}'` +
    ` AND (COALESCE(${pageAlias}.frontmatter, '{}'::jsonb) ->> '${EXTRACTION_STATUS_KEY}') = '${STATUS_UNVERIFIED}'`
  );
}
