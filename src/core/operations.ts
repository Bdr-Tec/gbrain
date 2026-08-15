/**
 * Contract-first operation definitions. Single source of truth for CLI, MCP, and tools-json.
 * Each operation defines its schema, handler, and optional CLI hints.
 */

import type { BrainEngine } from './engine.ts';
import { hybridSearchCached, stampContentFlags } from './search/hybrid.ts';
import { dedupResults } from './search/dedup.ts';
import { unverifiedExtractionFragment, isUnverifiedExtraction, EXTRACTION_STATUS_KEY, STATUS_VERIFIED } from './extraction-review.ts';
import { buildVisibilityClause } from './search/sql-ranking.ts';
import { bumpLastRetrievedAt } from './last-retrieved.ts';
import { packToBudget, estimateTokens, resultTokens } from './search/token-budget.ts';
import { isAvailable } from './ai/gateway.ts';
import { verbOperations, MEMORY_VERBS_VERSION } from './verbs.ts';
export { MEMORY_VERBS_VERSION };
import type { SearchResult } from './types.ts';
import {
  FIND_EXPERTS_DESCRIPTION,
  GET_RECENT_TRANSCRIPTS_DESCRIPTION,
  FIND_CONTRADICTIONS_DESCRIPTION,
  FIND_TRAJECTORY_DESCRIPTION,
  CODE_CALLERS_DESCRIPTION,
  CODE_CALLEES_DESCRIPTION,
  CODE_DEF_DESCRIPTION,
  CODE_REFS_DESCRIPTION,
} from './operations-descriptions.ts';
// WP4 (request_tools): all three are runtime leaves relative to this module
// (no import cycles back into operations.ts). The cyclic dependencies —
// src/mcp/surface.ts (→ brain-allowlist → operations) and
// src/mcp/publish-gates.ts (→ operations) — are loaded via dynamic import
// inside the handler instead (the verbs.ts house pattern).
import { isUndefinedColumnError } from './utils.ts';
import { hasScope } from './scope.ts';
import { RateLimiter } from '../mcp/rate-limit.ts';
import { writeSurfaceChangeAudit } from './surface-audit.ts';

// --- Foundation (pure move, v0.46.x): the contract types + error envelope live
// in ops/contract.ts; the validators, slug fences, and source-scope resolvers
// live in ops/context.ts. Imported here for the op handlers below, and
// re-exported so every existing importer of operations.ts is unchanged.

import { OperationError, verbError } from './ops/contract.ts';
import type { Operation, OperationContext } from './ops/contract.ts';
import {
  opAllowedForBoundClient,
  sourceScopeOpts,
  resolveRequestedScope,
  resolveCodeIntelScope,
  stampEvidenceSafe,
} from './ops/context.ts';

// Re-exports: the full previously-exported foundation surface of this module.
// The formerly file-private helpers (enforceSubagentSlugFence, slugUnderSubagentFence,
// slugOutsideCallerFence, enforceClientSlugFence, BOUND_CLIENT_META_OPS,
// stampEvidenceSafe, maybeCaptureSearch) are deliberately NOT re-exported —
// they were never part of this module's surface; import them from ops/context.ts.
export { OperationError, verbError } from './ops/contract.ts';
export type {
  ErrorCode,
  ParamDef,
  Logger,
  AuthInfo,
  OperationContext,
  Operation,
} from './ops/contract.ts';
export {
  validateUploadPath,
  validatePageSlug,
  matchesSlugAllowList,
  slugUnderBoundPrefixes,
  normalizeSlugPrefix,
  CLIENT_FENCED_WRITE_OPS,
  opAllowedForBoundClient,
  enforceBoundClientOpAllowList,
  validateFilename,
  sourceScopeOpts,
  thinkSourceScopeOpts,
  linkReadScopeOpts,
  resolveRequestedScope,
  federatedSearchScope,
  resolveCodeIntelScope,
  resolvePerCallMode,
} from './ops/context.ts';

// --- Tranche 1 (pure move, v0.46.x): the Page CRUD, Search (search/query),
// Takes+think, Tags, Links+graph, and Timeline op clusters live in
// ops/pages.ts, ops/search.ts, ops/takes.ts, ops/tags.ts, ops/links.ts, and
// ops/timeline.ts. Their ordered arrays are spliced into the canonical
// `operations` array below at the clusters' original positions (order is
// contractual — docs/TOOL_CATALOG.md is generated from it).

import { pagesOperations } from './ops/pages.ts';
import { searchOperations } from './ops/search.ts';
import { takesOperations } from './ops/takes.ts';
import { tagsOperations } from './ops/tags.ts';
import { linksOperations } from './ops/links.ts';
import { timelineOperations } from './ops/timeline.ts';

// MANAGED_LINK_SOURCES moved to ops/links.ts with the add_link op; re-exported
// so every existing importer of operations.ts is unchanged.
export { MANAGED_LINK_SOURCES } from './ops/links.ts';

// --- Tranche 2 (pure move, v0.46.x): the Admin, skill-catalog (+advisor/
// status-snapshot), Sync, Raw Data, Resolution & Chunks, Ingest Log, File
// Operations, Jobs (Minions + agent lane), Orphans, calibration, and
// Salience + Anomaly op clusters live in ops/admin.ts, ops/skills-catalog.ts,
// ops/sync-status.ts, ops/raw-data.ts, ops/chunks.ts, ops/ingest-log.ts,
// ops/files.ts, ops/jobs.ts, ops/orphans.ts, ops/calibration.ts, and
// ops/salience.ts. Their ordered arrays are spliced into the canonical
// `operations` array below at the clusters' original positions (order is
// contractual — docs/TOOL_CATALOG.md is generated from it).

import { adminOperations } from './ops/admin.ts';
import { skillsCatalogOperations } from './ops/skills-catalog.ts';
import { syncStatusOperations } from './ops/sync-status.ts';
import { rawDataOperations } from './ops/raw-data.ts';
import { chunksOperations } from './ops/chunks.ts';
import { ingestLogOperations } from './ops/ingest-log.ts';
import { filesOperations } from './ops/files.ts';
import { jobsOperations } from './ops/jobs.ts';
import { orphansOperations } from './ops/orphans.ts';
import { calibrationOperations } from './ops/calibration.ts';
import { salienceOperations } from './ops/salience.ts';

// --- v0.43 (#2095): push-based context — the brain volunteers pages ---

const volunteer_context: Operation = {
  name: 'volunteer_context',
  description:
    'Push-based context: volunteer brain pages relevant to a rolling conversation window ' +
    'WITHOUT being asked. Zero-LLM, confidence-gated (alias 0.9 / exact-title 0.8 / ' +
    'slug-suffix 0.6, +0.05 for multi-turn or newest-turn mentions; default gate 0.7), ' +
    'capped at 3 pages (max 5). Returns pointers with one-line rationales + synopses — ' +
    'open the page (get_page) before relying on details. Pass stats: true for the ' +
    'approximate volunteered-vs-used precision summary (the feedback loop).',
  scope: 'read',
  params: {
    window: {
      type: 'string',
      description:
        "Recent conversation turns, oldest → newest, as 'user:' / 'assistant:' prefixed " +
        'lines (unprefixed text = one user turn). Required unless stats: true. ' +
        'CLI: piped stdin fills this.',
    },
    prior_context: {
      type: 'string',
      description:
        'Already-surfaced context (pointer blocks / opened page bodies). Pages whose slug ' +
        'appears here are not re-volunteered.',
    },
    max_pages: { type: 'number', description: 'Max pages to volunteer (default 3, hard cap 5).' },
    min_confidence: {
      type: 'number',
      description:
        'Confidence gate 0..1 (default 0.7 — slug-suffix matches need an explicit lower gate).',
    },
    session_id: { type: 'string', description: 'Optional caller session id, logged for attribution.' },
    turn: { type: 'number', description: 'Optional caller turn number, logged for attribution.' },
    stats: {
      type: 'boolean',
      description:
        'Return the volunteered-vs-used precision summary instead of volunteering. ' +
        'APPROXIMATE: "used" = pages.last_retrieved_at > volunteered_at.',
    },
    days: { type: 'number', description: 'Stats window in days (default 30; stats mode only).' },
  },
  handler: async (ctx, p) => {
    const { parseWindow, volunteerContext, volunteerUsageStats } = await import('./context/volunteer.ts');
    const scope = sourceScopeOpts(ctx);
    const sourceIds = scope.sourceIds ?? (scope.sourceId ? [scope.sourceId] : ['default']);

    if (p.stats === true) {
      return volunteerUsageStats(ctx.engine, sourceIds, typeof p.days === 'number' ? p.days : undefined);
    }

    if (typeof p.window !== 'string' || !p.window.trim()) {
      throw new OperationError(
        'invalid_params',
        'window is required unless stats: true',
        'Pass the recent turns as a string (CLI: pipe them on stdin), or use --stats.',
      );
    }
    const turns = parseWindow(p.window);
    const pages = await volunteerContext(ctx.engine, turns, {
      sourceIds,
      priorContext: typeof p.prior_context === 'string' ? p.prior_context : undefined,
      maxPages: typeof p.max_pages === 'number' ? p.max_pages : undefined,
      minConfidence: typeof p.min_confidence === 'number' ? p.min_confidence : undefined,
    });

    // Feedback-loop logging: fire-and-forget batched INSERT through the
    // volunteer-events sink (drained at exit). Never fails the op.
    if (pages.length) {
      try {
        const { logVolunteerEventsFireAndForget, volunteerEventRowsFrom, SESSION_ID_MAX_LEN } = await import('./context/volunteer-events.ts');
        // Trust-boundary clamps (remote MCP callers): cap session_id length so
        // a read-scoped token can't bank unbounded TEXT per request, and only
        // log integer turns — a non-integer would throw inside the single
        // multi-row INSERT and silently drop the whole batch.
        const sessionId = typeof p.session_id === 'string' ? p.session_id.slice(0, SESSION_ID_MAX_LEN) : null;
        const turn =
          typeof p.turn === 'number' && Number.isInteger(p.turn) && Math.abs(p.turn) <= 2_147_483_647
            ? p.turn
            : null;
        logVolunteerEventsFireAndForget(
          ctx.engine,
          volunteerEventRowsFrom(pages, { channel: 'op', session_id: sessionId, turn }),
        );
      } catch {
        /* telemetry only */
      }
    }
    return { pages, count: pages.length, window_turns: turns.length };
  },
  cliHints: { name: 'volunteer-context', stdin: 'window' },
};

// v0.33: expertise + relationship-proximity routing. CLI: gbrain whoknows.
const find_experts: Operation = {
  name: 'find_experts',
  description: FIND_EXPERTS_DESCRIPTION,
  scope: 'read',
  params: {
    topic: {
      type: 'string',
      description: 'The topic to route. Free-form natural language.',
    },
    limit: {
      type: 'number',
      description: 'Max results (default 5).',
    },
    explain: {
      type: 'boolean',
      description: 'Include factor breakdown per result (expertise, recency, salience).',
    },
  },
  handler: async (ctx, p) => {
    const { findExperts } = await import('../commands/whoknows.ts');
    const topic = typeof p.topic === 'string' ? p.topic : '';
    if (!topic.trim()) {
      throw new OperationError('invalid_params', '`topic` is required and must be a non-empty string.');
    }
    // v0.34.1 (#861, D3 — 5th leak surface): find_experts (whoknows) was
    // authored against v0.33 after PR #861 was drafted, so the source-scope
    // thread was missing entirely. The op calls findExperts → hybridSearch
    // internally; without the thread an auth'd src-A whoknows query would
    // surface src-B people in the rankings.
    // v0.40.6.0 T1.5 wiring (D4): consult the active pack for expert
    // types; pack-load failure → empty filter (NOT hardcoded defaults
    // per the silent-violation bug class Finding 1.3 closed).
    const { loadActivePackBestEffort, expertTypesFromPack } = await import('./schema-pack/index.ts');
    const pack = await loadActivePackBestEffort(ctx);
    const types = pack ? expertTypesFromPack(pack.manifest) : [];
    return findExperts(ctx.engine, {
      topic,
      limit: typeof p.limit === 'number' ? p.limit : undefined,
      explain: p.explain === true,
      types: types as never,
      ...sourceScopeOpts(ctx),
    });
  },
  cliHints: { name: 'whoknows', positional: ['topic'] },
};

// v0.32.6: contradiction probe MCP surface (M3)
const find_contradictions: Operation = {
  name: 'find_contradictions',
  description: FIND_CONTRADICTIONS_DESCRIPTION,
  scope: 'read',
  // Reads eval_contradictions_runs.report_json for the latest run, then
  // filters in-memory by slug and severity. No new probe is triggered;
  // the agent surfaces what's already on disk.
  params: {
    slug: {
      type: 'string',
      description: 'Optional slug filter; matches either side of a pair (substring match on slug).',
    },
    severity: {
      type: 'string',
      enum: ['low', 'medium', 'high'],
      description: 'Optional severity filter.',
    },
    limit: {
      type: 'number',
      description: 'Max findings to return. Default 20.',
    },
  },
  handler: async (ctx, p) => {
    const limit = typeof p.limit === 'number' && p.limit > 0 ? Math.min(p.limit, 100) : 20;
    const slugFilter = typeof p.slug === 'string' ? p.slug.toLowerCase() : null;
    const sevFilter = (p.severity === 'low' || p.severity === 'medium' || p.severity === 'high')
      ? p.severity
      : null;
    const rows = await ctx.engine.loadContradictionsTrend(30);
    if (rows.length === 0) {
      return { contradictions: [], note: 'No probe runs in the last 30 days; run `gbrain eval suspected-contradictions` first.' };
    }
    const latest = rows[0];
    const report = latest.report_json as Record<string, unknown> | null;
    const perQuery = (report?.per_query as Array<{
      contradictions: Array<{
        kind: string;
        severity: 'low' | 'medium' | 'high';
        axis: string;
        confidence: number;
        a: { slug: string; chunk_id: number | null; take_id: number | null };
        b: { slug: string; chunk_id: number | null; take_id: number | null };
        resolution_kind: string;
        resolution_command: string;
      }>;
    }> | undefined) ?? [];
    const findings = perQuery.flatMap((q) => q.contradictions);
    const filtered = findings.filter((f) => {
      if (sevFilter && f.severity !== sevFilter) return false;
      if (slugFilter) {
        const sA = f.a.slug.toLowerCase();
        const sB = f.b.slug.toLowerCase();
        if (!sA.includes(slugFilter) && !sB.includes(slugFilter)) return false;
      }
      return true;
    });
    return {
      run_id: latest.run_id,
      ran_at: latest.ran_at,
      contradictions: filtered.slice(0, limit),
      total_in_run: findings.length,
    };
  },
  cliHints: { name: 'find-contradictions' },
};

const find_trajectory: Operation = {
  name: 'find_trajectory',
  description: FIND_TRAJECTORY_DESCRIPTION,
  scope: 'read',
  // localOnly intentionally NOT set — federated OAuth clients should be
  // able to query trajectories for entities in their scope. Visibility
  // filtering (D-CDX-1) inside the engine restricts remote callers to
  // visibility='world' facts.
  params: {
    entity_slug: {
      type: 'string',
      description: 'Required. Entity slug to chart (e.g. "companies/acme-example", "people/alice-example").',
    },
    metric: {
      type: 'string',
      description: 'Optional. Filter to a single canonical metric (e.g. "mrr", "arr", "team_size"). When omitted, all metrics return.',
    },
    kind: {
      type: 'string',
      enum: ['metric', 'event', 'all'],
      description: 'Optional. Filter by row shape: "metric" (typed-claim rows only), "event" (event_type rows only), or "all" (default). v0.40.2.0+.',
    },
    since: {
      type: 'string',
      description: 'Optional lower bound on valid_from (YYYY-MM-DD or ISO).',
    },
    until: {
      type: 'string',
      description: 'Optional upper bound on valid_from (YYYY-MM-DD or ISO).',
    },
    limit: {
      type: 'number',
      description: 'Max points returned. Default 100, max 500.',
    },
  },
  handler: async (ctx, p) => {
    if (typeof p.entity_slug !== 'string' || !p.entity_slug.trim()) {
      throw new Error('find_trajectory requires entity_slug (string)');
    }
    const metric = typeof p.metric === 'string' ? p.metric : undefined;
    const kind = (p.kind === 'metric' || p.kind === 'event' || p.kind === 'all')
      ? (p.kind as 'metric' | 'event' | 'all')
      : undefined;
    const since  = typeof p.since  === 'string' ? p.since  : undefined;
    const until  = typeof p.until  === 'string' ? p.until  : undefined;
    const limit  = typeof p.limit  === 'number' ? p.limit  : undefined;
    const scope = sourceScopeOpts(ctx);

    // D-CDX-1: thread ctx.remote into the engine so visibility filtering
    // happens at SQL level. Mirrors recall's posture for untrusted callers.
    const points = await ctx.engine.findTrajectory({
      entitySlug: p.entity_slug,
      ...scope,
      remote: ctx.remote !== false, // fail-closed: anything not strictly false is untrusted (CLAUDE.md invariant)
      metric,
      kind,
      since,
      until,
      limit,
    });

    const { computeTrajectoryStats, TRAJECTORY_SCHEMA_VERSION } = await import('./trajectory.ts');
    const { regressions, drift_score } = computeTrajectoryStats(points);

    // Engine result includes raw embeddings (Float32Array); strip those
    // before sending over MCP — they're bulky binary noise that consumers
    // never need at this layer.
    // v0.40.2.0: event_type surfaces on the wire so remote callers (thin-
    // client think, founder-scorecard) see the event-shaped rows.
    const wirePoints = points.map(pt => ({
      fact_id: pt.fact_id,
      valid_from: pt.valid_from.toISOString().slice(0, 10),
      metric: pt.metric,
      value: pt.value,
      unit: pt.unit,
      period: pt.period,
      event_type: pt.event_type,
      text: pt.text,
      source_session: pt.source_session,
      source_markdown_slug: pt.source_markdown_slug,
    }));

    return {
      points: wirePoints,
      regressions,
      drift_score,
      schema_version: TRAJECTORY_SCHEMA_VERSION,
    };
  },
  cliHints: { name: 'find-trajectory' },
};

const get_recent_transcripts: Operation = {
  name: 'get_recent_transcripts',
  description: GET_RECENT_TRANSCRIPTS_DESCRIPTION,
  scope: 'read',
  // Local-only: rejects HTTP-borne MCP traffic at tool-list time
  // (serve-http.ts filters on `localOnly`) AND at runtime via the in-handler
  // ctx.remote check. Defense in depth: hidden + rejected.
  localOnly: true,
  params: {
    days: { type: 'number', description: 'Window in days. Default 7.' },
    summary: {
      type: 'boolean',
      description: 'When true (default), return first ~300 chars per transcript. When false, full content (capped at 100 KB per file).',
    },
    limit: { type: 'number', description: 'Max transcripts (default 50).' },
  },
  handler: async (ctx, p) => {
    // Trust gate (eng review D2 + codex C3): MCP / HTTP callers (`remote=true`)
    // are blocked. Local CLI callers (`remote=false`) and the trusted-workspace
    // dream cycle pass through. This op is intentionally NOT in the subagent
    // allow-list (subagents always run with remote=true; they would always be
    // rejected, which is a footgun if the op is visible).
    if (ctx.remote === true) {
      throw new OperationError(
        'permission_denied',
        'get_recent_transcripts is local-only — call via the gbrain CLI.',
      );
    }
    const { listRecentTranscripts } = await import('./transcripts.ts');
    return listRecentTranscripts(ctx.engine, {
      days: typeof p.days === 'number' ? p.days : undefined,
      summary: typeof p.summary === 'boolean' ? p.summary : undefined,
      limit: typeof p.limit === 'number' ? p.limit : undefined,
    });
  },
  cliHints: { name: 'transcripts', hidden: true },
};

// --- v0.28: whoami + sources management ---

const whoami: Operation = {
  name: 'whoami',
  description:
    'Introspect the calling identity. Returns one of three transport shapes: ' +
    '{transport: "oauth", client_id, client_name, scopes, expires_at, source_id, federated_read}, ' +
    '{transport: "legacy", token_name, scopes, expires_at: null}, or ' +
    '{transport: "local", scopes: []}, or {transport: "stdio", scopes: []} ' +
    'for the auth-less stdio MCP pipe. Throws unknown_transport when the ' +
    'context is ambiguous (remote=true without auth and no transport marker) ' +
    '— fail-closed posture mirroring the v0.26.9 trust-boundary contract.',
  params: {},
  scope: 'read',
  handler: async (ctx) => {
    // Trust boundary: ctx.remote === false is the trusted local CLI surface.
    // Returning OAuth-shaped scopes here would resurrect the v0.26.9 footgun
    // where code conditionally trusted on `scopes.includes('admin')` instead
    // of `ctx.remote === false`. Empty scopes array forces clients to
    // special-case `transport: 'local'` explicitly.
    if (ctx.remote === false) {
      return { transport: 'local', scopes: [] };
    }
    // #1061: stdio MCP is remote/untrusted by design but has no per-token
    // auth (local pipe) — a known transport, not a bug. Report it instead of
    // throwing. Empty scopes: nothing here may be used to gate anything.
    if (!ctx.auth && ctx.transport === 'stdio') {
      return { transport: 'stdio', scopes: [] };
    }
    if (!ctx.auth) {
      throw new OperationError(
        'unknown_transport',
        'whoami called over a remote transport that did not thread ctx.auth. ' +
          'This is a transport bug — every remote call site must populate ctx.auth ' +
          'or set ctx.remote === false.',
      );
    }
    // OAuth tokens have client_id starting with 'gbrain_cl_'; legacy
    // access_tokens reuse `name` as both clientId and clientName (verifyAccessToken
    // at oauth-provider.ts:417-430). Detect by inspecting the prefix.
    const isOauth = ctx.auth.clientId.startsWith('gbrain_cl_');
    if (isOauth) {
      return {
        transport: 'oauth',
        client_id: ctx.auth.clientId,
        client_name: ctx.auth.clientName ?? ctx.auth.clientId,
        scopes: ctx.auth.scopes,
        expires_at: ctx.auth.expiresAt ?? null,
        // Read-only self-introspection of the token's source grants —
        // widens nothing; absent grants serialize fail-closed (null / []).
        source_id: ctx.auth.sourceId ?? null,
        federated_read: ctx.auth.allowedSources ?? [],
      };
    }
    return {
      transport: 'legacy',
      token_name: ctx.auth.clientName ?? ctx.auth.clientId,
      scopes: ctx.auth.scopes,
      expires_at: null,
    };
  },
  cliHints: { name: 'whoami' },
};

const sources_add: Operation = {
  name: 'sources_add',
  description:
    'Register a new source. Supports either --path (existing v0.17 behavior) ' +
    'or --url (v0.28 federated remote-clone path: parses the URL through the ' +
    'SSRF gate, clones into $GBRAIN_HOME/clones/<id>/ via temp-dir + rename ' +
    'atomicity, and stores remote_url in sources.config). Pre-flight collision ' +
    'check on id; rollback on either-side failure.',
  params: {
    id: {
      type: 'string',
      required: true,
      description: 'Source id ([a-z0-9-]{1,32}). Immutable citation key.',
    },
    name: { type: 'string', description: 'Display name (defaults to id).' },
    path: { type: 'string', description: 'Local path. Mutually optional with url.' },
    url: {
      type: 'string',
      description:
        'HTTPS git URL. Cloned into $GBRAIN_HOME/clones/<id>/. SSRF-guarded.',
    },
    federated: {
      type: 'boolean',
      description: 'true → cross-source default search. false → isolated.',
    },
    clone_dir: {
      type: 'string',
      description:
        'Override clone destination (only valid with url). Default: $GBRAIN_HOME/clones/<id>/.',
    },
  },
  mutating: true,
  scope: 'sources_admin',
  handler: async (ctx, p) => {
    const { addSource } = await import('./sources-ops.ts');

    // v0.28.1 codex finding (CRITICAL + HIGH): a `sources_admin` token over
    // HTTP MCP must not be able to plant content at arbitrary host paths.
    //
    // - `path` lets a remote caller register `/etc/` (or any host dir) as a
    //   "source"; later `gbrain sync --all` walks every sources.local_path,
    //   which exfiltrates host content into the brain.
    // - `clone_dir` lets a remote caller name the destination directly;
    //   addSource's renameSync places the cloned tree there with no
    //   confinement, AND validateRepoState's degraded-state recovery later
    //   does rm -rf on src.local_path, so the same primitive doubles as
    //   arbitrary-delete.
    //
    // Both fields are CLI-only (the operator runs `gbrain sources add --path
    // /home/me/notes`). For HTTP MCP, ignore overrides — clone_dir defaults
    // to $GBRAIN_HOME/clones/<id>/ and path is rejected. Local CLI callers
    // (ctx.remote === false, per F7b fail-closed contract) keep the override.
    const isLocal = ctx.remote === false;
    const remotePath = isLocal ? (p.path as string | undefined) ?? null : null;
    const remoteCloneDir = isLocal ? (p.clone_dir as string | undefined) : undefined;
    if (!isLocal && p.path !== undefined) {
      throw new OperationError(
        'invalid_params',
        'sources_add: path is not honored over MCP (security confinement). ' +
          'Register with --url instead, or run `gbrain sources add --path ...` on the host CLI.',
        'Use --url to register a remote source, or run the command locally with --path.',
      );
    }

    const row = await addSource(ctx.engine, {
      id: p.id as string,
      name: p.name as string | undefined,
      localPath: remotePath,
      remoteUrl: p.url as string | undefined,
      federated:
        p.federated === undefined ? null : (p.federated as boolean),
      cloneDir: remoteCloneDir,
    });
    return row;
  },
  cliHints: { name: 'sources_add', hidden: true },
};

const sources_list: Operation = {
  name: 'sources_list',
  description:
    'List registered sources with page counts and remote_url. v0.28 surfaces ' +
    'the new remote_url field so a remote MCP caller can confirm a source is ' +
    'managed by clone+pull rather than user-supplied path.',
  params: {
    include_archived: { type: 'boolean', description: 'Include soft-deleted sources.' },
  },
  scope: 'read',
  handler: async (ctx, p) => {
    const { listSources } = await import('./sources-ops.ts');
    return {
      sources: await listSources(ctx.engine, {
        includeArchived: (p.include_archived as boolean) === true,
      }),
    };
  },
  cliHints: { name: 'sources_list', hidden: true },
};

const sources_remove: Operation = {
  name: 'sources_remove',
  description:
    'Hard-remove a source (cascades pages/chunks/embeddings). Refuses to ' +
    'delete the auto-managed clone dir unless its resolved path is confined ' +
    'under $GBRAIN_HOME/clones/ (realpath+lstat — symlink-safe). For most ' +
    'workflows prefer sources_archive for the soft-delete path.',
  params: {
    id: { type: 'string', required: true, description: "Source id to remove, as listed by sources_list (e.g. 'wiki'). A source id, not a page slug." },
    confirm_destructive: {
      type: 'boolean',
      description:
        'Required when the source has data (pages, chunks). Without it the op refuses.',
    },
    dry_run: { type: 'boolean', description: 'Preview impact without side effects.' },
    keep_storage: {
      type: 'boolean',
      description: 'Skip clone-dir cleanup even when the source is auto-managed.',
    },
  },
  mutating: true,
  scope: 'sources_admin',
  handler: async (ctx, p) => {
    const { removeSource } = await import('./sources-ops.ts');
    return removeSource(ctx.engine, {
      id: p.id as string,
      confirmDestructive: (p.confirm_destructive as boolean) === true,
      dryRun: (p.dry_run as boolean) === true || ctx.dryRun,
      keepStorage: (p.keep_storage as boolean) === true,
    });
  },
  cliHints: { name: 'sources_remove', hidden: true },
};

const sources_status: Operation = {
  name: 'sources_status',
  description:
    'Per-source diagnostic. Returns clone_state ("healthy" | "missing" | ' +
    '"not-a-dir" | "no-git" | "url-drift" | "corrupted" | "not-applicable") ' +
    'so a remote MCP caller can diagnose whether the on-disk clone is ' +
    'syncable without SSH access to the brain host.',
  params: {
    id: { type: 'string', required: true, description: "Source id to diagnose, as listed by sources_list (e.g. 'wiki'). A source id, not a page slug." },
  },
  scope: 'read',
  handler: async (ctx, p) => {
    const { getSourceStatus } = await import('./sources-ops.ts');
    return getSourceStatus(ctx.engine, p.id as string);
  },
  cliHints: { name: 'sources_status', hidden: true },
};

// ============================================================
// v0.31 — Hot memory ops: extract_facts / recall / forget_fact
// ============================================================

const extract_facts: Operation = {
  name: 'extract_facts',
  description:
    'v0.31: extract personal-knowledge facts (events, preferences, commitments, beliefs) from a conversation turn into the per-source hot memory. Sanitizes turn_text via INJECTION_PATTERNS, calls Haiku to extract structured claims, runs the cosine fast-path + classifier dedup pipeline, INSERTs into facts. Returns counts by status. Skips extraction when the turn is dream-generated content (anti-loop). For agent memory writes of a SINGLE already-formed fact, prefer the `remember` verb (zero LLM, mandatory provenance).',
  params: {
    turn_text: { type: 'string', required: true, description: 'The user message or page body to extract facts from. Sanitized via INJECTION_PATTERNS before the LLM call.' },
    session_id: { type: 'string', description: 'Opaque session id (e.g. topic-id from MCP _meta.session_id, or CLI --session). Stored on each fact for the recall --session filter. Not an auth surface.' },
    entity_hints: { type: 'array', items: { type: 'string' }, description: 'Existing canonical entity slugs the agent has already resolved. Helps the extractor pick the right slug.' },
    is_dream_generated: { type: 'boolean', description: 'When true, extraction is skipped (anti-loop). Caller flips this on for pages with dream_generated:true frontmatter.' },
    visibility: { type: 'string', description: 'Default visibility for extracted facts. private (default) | world.' },
  },
  mutating: true,
  scope: 'write',
  handler: async (ctx, p) => {
    if (ctx.dryRun) return { dry_run: true, action: 'extract_facts' };
    const { isFactsExtractionEnabled } = await import('./facts/extract.ts');
    const { runFactsPipeline } = await import('./facts/backstop.ts');

    // D15: kill switch. Operator can disable facts extraction across the
    // brain without binary downgrade by setting `facts.extraction_enabled`
    // to false. Returns zero-counts envelope so callers see a clean
    // success rather than a 'permission_denied' false alarm.
    if (!(await isFactsExtractionEnabled(ctx.engine))) {
      return { inserted: 0, duplicate: 0, superseded: 0, fact_ids: [], skipped: 'extraction_disabled' };
    }

    // v0.31.2: routed through the shared pipeline (PR1 commit 9). Anti-loop
    // dream-generated check stays at the op layer because extract_facts is
    // an explicit user op without a parsedPage — the eligibility predicate
    // doesn't apply, but the dream-generated guard still does.
    if (p.is_dream_generated === true) {
      return { inserted: 0, duplicate: 0, superseded: 0, fact_ids: [], skipped: 'dream_generated' };
    }

    const sourceId = ctx.sourceId ?? 'default';
    // [ENG-8] Explicit caller value wins; UNSET resolves through the shared
    // facts.default_visibility helper (the old ternary coerced unset →
    // 'private' before any config default could run). Garbage stays 'private'.
    const { resolveVisibilityParam } = await import('./facts/visibility.ts');
    const visibility: 'private' | 'world' = await resolveVisibilityParam(ctx.engine, p.visibility);

    const r = await runFactsPipeline(p.turn_text as string, {
      engine: ctx.engine,
      sourceId,
      sessionId: typeof p.session_id === 'string' ? p.session_id : null,
      entityHints: Array.isArray(p.entity_hints) ? (p.entity_hints as string[]) : undefined,
      source: 'mcp:extract_facts',
      visibility,
      mode: 'inline',  // declarative; runFactsPipeline always inline
    });

    return {
      inserted: r.inserted,
      duplicate: r.duplicate,
      superseded: r.superseded,
      fact_ids: r.fact_ids,
    };
  },
};

const recall: Operation = {
  name: 'recall',
  description:
    'MEMORY VERB (v1): retrieve saved facts/snippets — the protocol read verb. Filters hot-memory facts by entity / since / session_id; pass `query` to ALSO run hybrid search over pages (results[] arm); pass `budget_tokens` for server-side packing (response reports budget_used + dropped_count — never trims client-side). Remote callers see visibility=world facts only. Routing: for ONE known person/company/project card use `entity` (zero LLM); for broad questions needing reasoning use `synthesize` (expensive). Branch on structured fields (status/kind/evidence), never on prose. Every response carries protocol_version.',
  params: {
    entity: { type: 'string', description: 'Entity slug (canonical). Returns facts about this entity newest first.' },
    query: { type: 'string', description: 'MEMORY_VERBS v1: free-text retrieval over pages (hybrid search arm). Response adds results[] (slug, title, chunk, evidence, create_safety, provenance). Combinable with entity (both arms run). Degrades to keyword-only search when no embedding provider is configured (search_degraded notes it; never an error).' },
    budget_tokens: { type: 'number', description: 'MEMORY_VERBS v1: server-side token budget (char/4 estimate). Facts pack first, then results. Response adds budget_tokens, budget_used, dropped_count.' },
    since: { type: 'string', description: 'ISO 8601 datetime or duration shorthand (e.g. "8 hours ago"). Filters the FACTS arm only.' },
    session_id: { type: 'string', description: 'Source session id (e.g. topic-A). Returns facts captured in that session.' },
    include_expired: { type: 'boolean', description: 'When true, include expired_at IS NOT NULL rows. Default false.' },
    supersessions: { type: 'boolean', description: 'When true, return only the supersession audit log (expired_at + superseded_by both set).' },
    limit: { type: 'number', description: 'Per-arm cap: max fact rows AND max search results. Default 50, cap 100.' },
    grep: { type: 'string', description: 'Substring filter on fact text (case-insensitive). Applied client-side after recall.' },
    include_pending: { type: 'boolean', description: 'v0.32: when true, response includes pending_consolidation_count (facts not yet promoted to takes by the dream-cycle consolidate phase). One round trip; backward-compatible (field omitted when false).' },
  },
  scope: 'read',
  verb: true,
  annotations: { title: 'recall (memory read)', readOnlyHint: true },
  handler: async (ctx, p) => {
    const sourceId = ctx.sourceId ?? 'default';
    const limit = typeof p.limit === 'number' ? p.limit : 50;
    const includeExpired = p.include_expired === true;
    const grep = typeof p.grep === 'string' ? p.grep.toLowerCase() : null;

    // Visibility filter: remote callers see world-only unless their token
    // grants elevated visibility (future-proofing; v0.31 ships world-only
    // for remote, all for local CLI).
    const visibility =
      ctx.remote === false
        ? undefined
        : ['world'] as ('private' | 'world')[];

    let rows: Awaited<ReturnType<typeof ctx.engine.listFactsByEntity>> = [];

    if (p.supersessions === true) {
      const since = parseSinceParam(p.since);
      rows = await ctx.engine.listSupersessions(sourceId, { since: since ?? undefined, limit });
    } else if (typeof p.entity === 'string' && p.entity.length > 0) {
      const { resolveEntitySlug } = await import('./entities/resolve.ts');
      const slug = (await resolveEntitySlug(ctx.engine, sourceId, p.entity)) ?? p.entity;
      rows = await ctx.engine.listFactsByEntity(sourceId, slug, {
        activeOnly: !includeExpired,
        limit,
        visibility,
      });
    } else if (typeof p.session_id === 'string' && p.session_id.length > 0) {
      rows = await ctx.engine.listFactsBySession(sourceId, p.session_id, {
        activeOnly: !includeExpired,
        limit,
        visibility,
      });
    } else if (p.since !== undefined) {
      const since = parseSinceParam(p.since);
      if (since) {
        rows = await ctx.engine.listFactsSince(sourceId, since, {
          activeOnly: !includeExpired,
          limit,
          visibility,
        });
      }
    } else {
      // No filter: return recent across the source.
      rows = await ctx.engine.listFactsSince(sourceId, new Date(0), {
        activeOnly: !includeExpired,
        limit,
        visibility,
      });
    }

    if (grep) rows = rows.filter(r => r.fact.toLowerCase().includes(grep));

    // v0.32: optional pending-consolidation count piggy-backed on the recall
    // response. Single round trip on thin-client; omitted when not requested
    // so existing callers see no shape change.
    let pending_consolidation_count: number | undefined;
    if (p.include_pending === true) {
      try {
        pending_consolidation_count = await ctx.engine.countUnconsolidatedFacts(sourceId);
      } catch (e) {
        // Best-effort: if the count query fails we still return facts. Field
        // stays undefined so callers can tell the difference between "0
        // pending" and "we couldn't ask."
        process.stderr.write(
          `[recall] countUnconsolidatedFacts failed: ${(e as Error).message}\n`,
        );
      }
    }

    // ── MEMORY_VERBS v1 — query arm (G1B superset). Hybrid search over pages
    // when `query` is present; degrades to keyword-only with a note (never an
    // error) when no embedding provider is configured [F-B].
    const queryText = typeof p.query === 'string' && p.query.trim().length > 0 ? p.query.trim() : null;
    const budgetTokens =
      typeof p.budget_tokens === 'number' && Number.isFinite(p.budget_tokens) && p.budget_tokens > 0
        ? Math.floor(p.budget_tokens)
        : null;

    let searchResults: SearchResult[] = [];
    let searchDegraded: string | undefined;
    if (queryText) {
      const searchScope = sourceScopeOpts(ctx);
      if (!isAvailable('embedding')) {
        const raw = await ctx.engine.searchKeyword(queryText, { limit, ...searchScope });
        searchResults = dedupResults(raw);
        stampEvidenceSafe(searchResults);
        await stampContentFlags(ctx.engine, searchResults);
        searchDegraded = 'keyword_only_no_embedding_provider';
      } else {
        searchResults = await hybridSearchCached(ctx.engine, queryText, {
          limit,
          expansion: false,
          ...searchScope,
        });
      }
      bumpLastRetrievedAt(ctx.engine, searchResults.map(r => r.page_id));
    }

    // ── MEMORY_VERBS v1 — server-side budget packing. Facts pack first (cheap,
    // high-precision one-liners, per-arm limit-capped so starvation is bounded),
    // then search results take the remainder. packToBudget treats budget<=0 as
    // a no-op, so an exhausted remainder must drop explicitly.
    let packedFacts = rows;
    let packedResults = searchResults;
    let budgetUsed: number | undefined;
    let droppedCount: number | undefined;
    if (budgetTokens !== null) {
      const factsPack = packToBudget(rows, r => estimateTokens(r.fact), budgetTokens);
      packedFacts = factsPack.items;
      const remaining = budgetTokens - factsPack.meta.used;
      const resultsPack =
        remaining > 0
          ? packToBudget(searchResults, resultTokens, remaining)
          : { items: [] as SearchResult[], meta: { budget: 0, used: 0, dropped: searchResults.length, kept: 0 } };
      packedResults = resultsPack.items;
      budgetUsed = factsPack.meta.used + resultsPack.meta.used;
      droppedCount = factsPack.meta.dropped + resultsPack.meta.dropped;
    }

    return {
      facts: packedFacts.map(r => ({
        id: r.id,
        fact: r.fact,
        kind: r.kind,
        entity_slug: r.entity_slug,
        visibility: r.visibility,
        // v0.31.2: notability surfaced to recall consumers (CLI, MCP, admin).
        // Pre-v46 brains return 'medium' via the row mapper's fallback so the
        // contract stays total.
        notability: r.notability,
        valid_from: r.valid_from.toISOString(),
        valid_until: r.valid_until?.toISOString() ?? null,
        expired_at: r.expired_at?.toISOString() ?? null,
        superseded_by: r.superseded_by,
        consolidated_at: r.consolidated_at?.toISOString() ?? null,
        consolidated_into: r.consolidated_into,
        source: r.source,
        source_session: r.source_session,
        confidence: r.confidence,
        created_at: r.created_at.toISOString(),
        // MEMORY_VERBS v1 additive fields (G1B). `fact_id` is the opaque
        // STRING id the `forget` verb accepts (legacy numeric `id` stays for
        // pre-v1 consumers — legacy fields are frozen byte-equal). `provenance`
        // is the protocol name for the stored source attribution.
        fact_id: String(r.id),
        provenance: r.source,
      })),
      total: packedFacts.length,
      ...(pending_consolidation_count !== undefined ? { pending_consolidation_count } : {}),
      // MEMORY_VERBS v1 envelope (G1B superset — additive on every response).
      protocol_version: MEMORY_VERBS_VERSION,
      ...(queryText
        ? {
            results: packedResults.map(r => ({
              slug: r.slug,
              title: r.title,
              chunk: r.chunk_text,
              evidence: r.evidence,
              create_safety: r.create_safety,
              provenance: r.slug,
            })),
            ...(searchDegraded ? { search_degraded: searchDegraded } : {}),
          }
        : {}),
      ...(budgetTokens !== null
        ? { budget_tokens: budgetTokens, budget_used: budgetUsed, dropped_count: droppedCount }
        : {}),
    };
  },
};

/** Parse an `entities` param (comma-string or array) to a trimmed name list. */
function parseEntityList(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x) => typeof x === 'string' && x.trim()).map((x) => (x as string).trim());
  if (typeof v === 'string') return v.split(',').map((s) => s.trim()).filter(Boolean);
  return [];
}

const context_pack: Operation = {
  name: 'context_pack',
  description:
    'MEMORY VERB (v1): budget-packed session-boundary bundle for a set of standing entities — entity cards + open threads + hot facts, zero-LLM, sub-second. Call at session start (warm cold context) and after compaction (rehydrate what the summary lost). WORLD-ONLY by default; pass include_private (honored for LOCAL trusted callers only) to widen all arms. budget_tokens packs server-side (response reports budget_used + dropped_count; cards pack first, then facts). Branch on structured fields, never prose. protocol_version rides every response.',
  params: {
    entities: { type: 'string', required: true, description: 'Comma-separated entity names/slugs to bundle. Capped at 8.' },
    budget_tokens: { type: 'number', description: 'Server-side token budget (char/4). Cards pack first, then facts. Response adds budget_tokens, budget_used, dropped_count.' },
    since: { type: 'string', description: 'ISO 8601 datetime. When set, open-thread events are filtered to those after this cursor.' },
    session_id: { type: 'string', description: 'Opaque session id; keys the hot-memory cache and (on the push path) the session cursor.' },
    include_private: { type: 'boolean', description: 'Local trusted callers only: widen ALL arms to include private facts. Ignored (world-only) for remote callers. Default false.' },
  },
  scope: 'read',
  verb: true,
  cliHints: { name: 'context-pack' },
  annotations: { title: 'context_pack (boundary bundle)', readOnlyHint: true },
  handler: async (ctx, p) => {
    const { assembleContextPack, renderPack, isAfter, PACK_DEFAULT_MAX_ENTITIES } = await import('./context/turn-context.ts');
    const sourceId = ctx.sourceId ?? 'default';
    const rawSince = typeof p.since === 'string' && p.since.trim() ? p.since : undefined;
    if (rawSince !== undefined && !Number.isFinite(Date.parse(rawSince))) {
      throw verbError(
        'invalid_params',
        `context_pack: since is not a parseable timestamp: "${rawSince.slice(0, 60)}"`,
        'Pass an ISO 8601 datetime, e.g. since: "2026-08-11T00:00:00Z".',
      );
    }
    // Normalize to ISO (red-team F4): the filter + rendered text use it.
    const since = rawSince !== undefined ? new Date(Date.parse(rawSince)).toISOString() : undefined;
    // Echo the CAPPED list (pre-landing review): the assembler bundles at most
    // PACK_DEFAULT_MAX_ENTITIES, so echoing more would claim entities were
    // bundled that produced no cards.
    const entities = parseEntityList(p.entities).slice(0, PACK_DEFAULT_MAX_ENTITIES);
    // Fail-closed: private only when EXPLICITLY requested AND the caller is
    // trusted-local (ctx.remote === false). A remote caller never widens.
    const includePrivate = p.include_private === true && ctx.remote === false;
    const budgetTokens =
      typeof p.budget_tokens === 'number' && Number.isFinite(p.budget_tokens) && p.budget_tokens > 0
        ? Math.floor(p.budget_tokens)
        : null;
    const res = await assembleContextPack(ctx.engine, {
      sourceId,
      entities,
      since,
      sessionId: typeof p.session_id === 'string' ? p.session_id : undefined,
      includePrivate,
      maxEntities: PACK_DEFAULT_MAX_ENTITIES,
    });

    let cards = res.cards ?? [];
    let facts = res.facts ?? [];
    let budgetUsed: number | undefined;
    let droppedCount: number | undefined;
    if (budgetTokens !== null) {
      const cardCost = (c: (typeof cards)[number]) =>
        estimateTokens(`${c.entity.title} ${c.summary} ${(c.open_threads ?? []).map((t) => t.text).join(' ')}`);
      const cardPack = packToBudget(cards, cardCost, budgetTokens);
      cards = cardPack.items;
      const remaining = budgetTokens - cardPack.meta.used;
      const factPack =
        remaining > 0
          ? packToBudget(facts, (f) => estimateTokens(f.fact), remaining)
          : { items: [] as typeof facts, meta: { budget: 0, used: 0, dropped: facts.length, kept: 0 } };
      facts = factPack.items;
      budgetUsed = cardPack.meta.used + factPack.meta.used;
      droppedCount = cardPack.meta.dropped + factPack.meta.dropped;
    }
    // Recompute open_threads with the SAME since filter the assembler applied
    // (pre-landing review: the raw flatMap silently dropped the documented
    // `since` contract from the structured array whenever budget packing ran).
    const open_threads = cards
      .flatMap((c) => c.open_threads ?? [])
      .filter((t) => !since || (t.date !== null && isAfter(t.date, since)));
    // Re-render the injectable block from the FINAL sets (adversarial review):
    // `text` is what harnesses inject, so it must honor the same budget the
    // structured arrays report — the assembler's pre-budget rendering would
    // overrun the declared budget_tokens.
    const text = budgetTokens !== null ? renderPack(cards, open_threads, facts) : res.text;

    return {
      protocol_version: MEMORY_VERBS_VERSION,
      entities,
      cards: cards.map((c) => ({
        slug: c.entity.slug,
        title: c.entity.title,
        type: c.entity.type,
        summary: c.summary,
        open_threads: c.open_threads,
        edges: c.edges,
        backlink_count: c.backlink_count,
      })),
      open_threads,
      facts: facts.map((f) => ({
        fact: f.fact,
        kind: f.kind,
        entity_slug: f.entity_slug,
        valid_from: f.valid_from,
        confidence: f.confidence,
      })),
      text,
      ...(res.degradedReason ? { degraded_reason: res.degradedReason } : {}),
      ...(budgetTokens !== null
        ? { budget_tokens: budgetTokens, budget_used: budgetUsed, dropped_count: droppedCount }
        : {}),
    };
  },
};

const delta: Operation = {
  name: 'delta',
  description:
    'MEMORY VERB (v1): "what changed since T" for heartbeats — pages updated after `since` + hot facts newer than `since` + open-thread events after `since`, zero-LLM. Lets a periodic wake maintain warm state in O(changes) instead of re-deriving. Optionally scope thread deltas to `entities`. WORLD-ONLY by default; include_private honored for local trusted callers only. budget_tokens packs server-side (pages first, then facts). protocol_version rides every response.',
  params: {
    since: { type: 'string', description: 'ISO 8601 cursor. Returns pages/facts/thread-events newer than this timestamp. Optional when session_id carries an established cursor.' },
    since_slug: { type: 'string', description: 'Stateless keyset resume: pass back `next_cursor.slug` from the previous response (paired with `since`=next_cursor.since) to page through pages sharing one timestamp. Ignored when session_id is set (the session cursor carries it).' },
    entities: { type: 'string', description: 'Optional comma-separated entity scope for thread-event deltas. Capped at 8.' },
    budget_tokens: { type: 'number', description: 'Server-side token budget (char/4). Pages pack first, then facts. Response adds budget_tokens, budget_used, dropped_count.' },
    session_id: { type: 'string', description: 'Opaque session id. Drives the per-session cursor: the first call establishes it, each call advances it to the newest DELIVERED change (at-least-once — with has_more:true the undelivered tail returns on the next wake). Without it, pass an explicit `since` for a stateless delta.' },
    include_private: { type: 'boolean', description: 'Local trusted callers only: widen ALL arms to include private facts. Ignored (world-only) for remote callers. Default false.' },
  },
  scope: 'read',
  verb: true,
  cliHints: { name: 'delta' },
  annotations: { title: 'delta (what changed since)', readOnlyHint: true },
  handler: async (ctx, p) => {
    const { assembleDeltaContext, renderDelta, PACK_DEFAULT_MAX_ENTITIES } = await import('./context/turn-context.ts');
    const { getSessionContextState, upsertSessionContextState } = await import('./context/session-state.ts');
    const sourceId = ctx.sourceId ?? 'default';
    const rawSince = typeof p.since === 'string' && p.since.trim() ? p.since : null;
    if (rawSince !== null && !Number.isFinite(Date.parse(rawSince))) {
      throw verbError(
        'invalid_params',
        `delta: since is not a parseable timestamp: "${rawSince.slice(0, 60)}"`,
        'Pass an ISO 8601 datetime, e.g. since: "2026-08-11T00:00:00Z".',
      );
    }
    // NORMALIZE to ISO immediately (red-team F4): the raw string is echoed
    // into the injectable `text` block, so an attacker-shaped-but-parseable
    // `since` must never reach rendering verbatim.
    const explicitSince = rawSince !== null ? new Date(Date.parse(rawSince)).toISOString() : null;
    const sessionId = typeof p.session_id === 'string' && p.session_id.trim() ? p.session_id : null;
    // Cursor namespace (pre-landing review, fail-closed): 'local' is RESERVED
    // for the trusted CLI/hook lane, gated on STRICT ctx.remote === false —
    // anything else (true, undefined via cast bypass) is remote. Remote callers
    // use their auth client id; an auth-LESS or blank-id remote (stdio MCP)
    // gets the shared 'remote' sentinel — never collapsed into 'local'.
    const clientId = ctx.remote === false ? null : ctx.auth?.clientId?.trim() || 'remote';
    const includePrivate = p.include_private === true && ctx.remote === false;
    const budgetTokens =
      typeof p.budget_tokens === 'number' && Number.isFinite(p.budget_tokens) && p.budget_tokens > 0
        ? Math.floor(p.budget_tokens)
        : null;

    const state = sessionId ? await getSessionContextState(ctx.engine, sourceId, clientId, sessionId) : null;
    const effectiveSince = explicitSince ?? state?.last_wake_at ?? null;

    if (!effectiveSince) {
      if (!sessionId) {
        throw verbError(
          'invalid_params',
          'delta requires `since` (ISO 8601) or a `session_id` with an established cursor.',
          'Pass since ("2026-08-11T00:00:00Z") for a stateless delta, or a stable session_id — the first call establishes the cursor and later calls return only newer changes.',
        );
      }
      // First wake for this session: establish the cursor at now and report an
      // empty delta (there is no prior point to diff against yet). Opportunistic
      // GC on row creation bounds session-row accumulation on serve-less CLI
      // lanes and remote read callers minting session ids (pre-landing review).
      // AWAITED (v0.45.7): a floating engine promise here races the CLI lane's
      // engine teardown and wedges the process — `gbrain delta --session-id`
      // printed its response but never exited (the exact command the shipped
      // HEARTBEAT.md ambient-delta row tells agents to run). GC is two fast
      // DELETEs on a capped table and internally fail-open, so awaiting costs
      // one first-wake round-trip, never an error. The serve-boot call site
      // (src/mcp/server.ts) stays fire-and-forget — that process is long-lived.
      const now = new Date().toISOString();
      const { gcSessionContextState } = await import('./context/session-state.ts');
      await upsertSessionContextState(ctx.engine, sourceId, clientId, sessionId, { lastWakeAt: now });
      await gcSessionContextState(ctx.engine);
      return {
        protocol_version: MEMORY_VERBS_VERSION,
        since: now, pages: [], facts: [], threads: [], text: '', has_more: false,
        next_cursor: { since: now, slug: '' },
        ...(budgetTokens !== null
          ? { budget_tokens: budgetTokens, budget_used: 0, dropped_count: 0 }
          : {}),
      };
    }

    // Keyset cursor (red-team F1/F2 fix): pages page by (updated_at, slug), so
    // a >limit cluster at one timestamp is reachable and a delivered page never
    // re-appears unless it changes. The keyset slug lives in the session row
    // (surfaced_slugs[0]); an explicit-`since` caller has no stored slug and
    // resumes via the returned `next_cursor`.
    const cursorSlug = sessionId ? state?.surfaced_slugs?.[0] : undefined;
    const explicitSlug = typeof p.since_slug === 'string' ? p.since_slug : undefined;
    const sinceSlug = explicitSlug ?? cursorSlug;

    const res = await assembleDeltaContext(ctx.engine, {
      sourceId,
      since: effectiveSince,
      ...(sinceSlug !== undefined ? { sinceSlug } : {}),
      entities: parseEntityList(p.entities),
      sessionId: sessionId ?? undefined,
      includePrivate,
      maxEntities: PACK_DEFAULT_MAX_ENTITIES,
    });

    // Pages arrive OLDEST first by (updated_at, slug) — no client-side dedup
    // needed; the keyset already excludes everything at/before the cursor.
    let pages = res.deltaPages ?? [];
    let facts = res.facts ?? [];
    const threads = res.openThreads ?? [];
    let budgetUsed: number | undefined;
    let droppedCount: number | undefined;
    let factsDropped = 0;
    const fetchedPages = pages.length;
    if (budgetTokens !== null) {
      // packToBudget keeps a contiguous PREFIX (order-preserving, stops at the
      // first overflow) — with oldest-first pages the kept set stays contiguous
      // from the cursor, which the advance logic below depends on.
      const pagePack = packToBudget(pages, (pg) => estimateTokens(`${pg.title} ${pg.slug}`), budgetTokens);
      pages = pagePack.items;
      const remaining = budgetTokens - pagePack.meta.used;
      const factPack =
        remaining > 0
          ? packToBudget(facts, (f) => estimateTokens(f.fact), remaining)
          : { items: [] as typeof facts, meta: { budget: 0, used: 0, dropped: facts.length, kept: 0 } };
      facts = factPack.items;
      budgetUsed = pagePack.meta.used + factPack.meta.used;
      droppedCount = pagePack.meta.dropped + factPack.meta.dropped;
      factsDropped = factPack.meta.dropped;
    }
    const pagesDropped = fetchedPages - pages.length;
    // has_more covers ALL undelivered content — fetch-limit overflow, budget-
    // dropped pages, AND budget-dropped facts (pre-landing review: facts were
    // silently lost when pages fit but facts overflowed).
    const hasMore = res.deltaOverflow === true || pagesDropped > 0 || factsDropped > 0;

    // Cursor advance (keyset, at-least-once): advance to the last DELIVERED
    // (updated_at, slug). The keyset's strict `>` means the next wake starts
    // exactly after it — a >limit same-timestamp cluster drains one page at a
    // time across wakes (F1), and a delivered page never re-appears (F2). On a
    // page-less wake with nothing dropped, advance the TIME cursor to now()
    // minus a safety lag (in-flight write txns stamp updated_at at txn START)
    // and clear the keyset slug. If nothing delivered but something dropped, do
    // NOT advance (deliver-before-advance; a too-small budget must not eat it).
    const nextCursor =
      pages.length > 0
        ? { since: pages[pages.length - 1].updated_at, slug: pages[pages.length - 1].slug }
        : { since: effectiveSince, slug: sinceSlug ?? '' };
    if (sessionId) {
      if (pages.length > 0) {
        await upsertSessionContextState(ctx.engine, sourceId, clientId, sessionId, {
          lastWakeAt: nextCursor.since,
          cursorSlug: nextCursor.slug,
        });
      } else if (!hasMore) {
        await upsertSessionContextState(ctx.engine, sourceId, clientId, sessionId, {
          lastWakeAt: new Date(Date.now() - 2000).toISOString(),
          cursorSlug: '',
        });
      }
    }

    // Re-render the injectable block from the FINAL sets (adversarial review):
    // `text` must honor the budget AND the boundary-tie exclusion the
    // structured arrays reflect — the assembler's render predates both.
    const text = renderDelta(pages, facts, threads, effectiveSince);

    return {
      protocol_version: MEMORY_VERBS_VERSION,
      since: effectiveSince,
      pages,
      facts: facts.map((f) => ({
        fact: f.fact,
        kind: f.kind,
        entity_slug: f.entity_slug,
        valid_from: f.valid_from,
        confidence: f.confidence,
      })),
      threads,
      text,
      has_more: hasMore,
      // Stateless resume: a caller with no session_id passes these back as
      // `since` + `since_slug` on the next call to page deterministically.
      next_cursor: nextCursor,
      ...(res.degradedReason ? { degraded_reason: res.degradedReason } : {}),
      ...(budgetTokens !== null
        ? { budget_tokens: budgetTokens, budget_used: budgetUsed, dropped_count: droppedCount }
        : {}),
    };
  },
};

const forget_fact: Operation = {
  name: 'forget_fact',
  description: 'v0.32.2: forget a fact. Rewrites the page\'s `## Facts` fence to strike through the row and set valid_until=today (the DB\'s expired_at derives via valid_until + now() on the next reconcile so the forget survives `gbrain rebuild`). Falls back to legacy DB-only expire for pre-v51 / thin-client rows. Idempotent on already-expired or unknown ids.',
  params: {
    id: { type: 'number', required: true, description: 'Fact id to forget.' },
    reason: { type: 'string', required: false, description: 'Optional reason; written to the fence row\'s context cell as "forgotten: <reason>". Default: "forgotten".' },
  },
  mutating: true,
  scope: 'write',
  handler: async (ctx, p) => {
    if (ctx.dryRun) return { dry_run: true, action: 'forget_fact', id: p.id };
    const id = p.id as number;
    const reason = typeof p.reason === 'string' ? p.reason : undefined;
    const { forgetFactInFence } = await import('./facts/forget.ts');
    const result = await forgetFactInFence(ctx.engine, id, { reason });
    if (!result.ok && result.path === 'not_found') {
      throw new OperationError('fact_not_found', `Fact id ${id} not found.`);
    }
    if (!result.ok && result.path === 'already_expired') {
      throw new OperationError('fact_already_expired', `Fact id ${id} already expired.`);
    }
    return { id, expired: true, path: result.path, reason: result.reason };
  },
};

/**
 * Parse a `since` parameter into a Date. Accepts ISO 8601, plain duration
 * shorthand ("8 hours ago", "3 days ago", "30m", "1h", "2d", "7d"), or
 * Unix epoch millis. Returns null on unparseable input.
 */
function parseSinceParam(raw: unknown): Date | null {
  if (raw == null) return null;
  if (typeof raw === 'number' && Number.isFinite(raw)) return new Date(raw);
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s) return null;

  // Try ISO first.
  const iso = Date.parse(s);
  if (Number.isFinite(iso)) return new Date(iso);

  // "N (minutes|hours|days) ago" or compact forms.
  const ago = s.match(/^(\d+)\s*(s|sec|seconds?|m|min|minutes?|h|hr|hours?|d|days?)(?:\s+ago)?$/i);
  if (ago) {
    const n = parseInt(ago[1], 10);
    const unit = ago[2].toLowerCase();
    const ms =
      unit.startsWith('s') ? n * 1000 :
      unit.startsWith('m') ? n * 60 * 1000 :
      unit.startsWith('h') ? n * 60 * 60 * 1000 :
      n * 24 * 60 * 60 * 1000;
    return new Date(Date.now() - ms);
  }
  return null;
}

/**
 * MEMORY_VERBS v1 — parse the `remember` verb's `ttl` param into a
 * `valid_until` Date. Sibling of parseSinceParam, pointed FORWARD.
 *
 * Accepted forms (frozen in docs/protocol/MEMORY_VERBS_v1.md):
 *   - relative duration shorthand: '30d', '12h', '45m', '90s' (also
 *     spelled-out: '30 days', '12 hours') → now + duration
 *   - absolute ISO 8601 date or datetime: '2026-07-12', '2026-07-12T00:00:00Z'
 *
 * Explicitly REJECTED with a self-correcting suggestion: ISO-8601 duration
 * syntax ('P30D', 'PT12H') — agents that read "ISO 8601" as durations get a
 * fix, not a mystery. Returns null for null/undefined/empty (= never expires).
 * Throws verbError('invalid_params') on anything unparseable.
 */
export function parseTtlParam(raw: unknown): Date | null {
  if (raw == null) return null;
  if (typeof raw !== 'string') {
    throw verbError(
      'invalid_params',
      `ttl must be a string, got ${typeof raw}.`,
      'Pass a duration like "30d" or "12h", or an absolute ISO 8601 timestamp like "2026-07-12T00:00:00Z".',
    );
  }
  const s = raw.trim();
  if (!s) return null;

  // ISO-8601 DURATION syntax is a documented trap — reject with the fix.
  if (/^P(T|\d)/i.test(s) && /^P(?:\d+[YMWD])*(?:T(?:\d+[HMS])+)?$/i.test(s)) {
    throw verbError(
      'invalid_params',
      `ttl "${s}" looks like an ISO-8601 duration, which is not accepted.`,
      `Use the shorthand form instead (e.g. "${s.replace(/^PT?/i, '').toLowerCase()}" style: "30d", "12h"), or an absolute ISO 8601 expiry timestamp.`,
    );
  }

  // Relative duration shorthand → now + duration.
  const dur = s.match(/^(\d+)\s*(s|sec|seconds?|m|min|minutes?|h|hr|hours?|d|days?)$/i);
  if (dur) {
    const n = parseInt(dur[1], 10);
    const unit = dur[2].toLowerCase();
    const ms =
      unit.startsWith('s') ? n * 1000 :
      unit.startsWith('m') ? n * 60 * 1000 :
      unit.startsWith('h') ? n * 60 * 60 * 1000 :
      n * 24 * 60 * 60 * 1000;
    return new Date(Date.now() + ms);
  }

  // Absolute ISO 8601 date or datetime.
  const iso = Date.parse(s);
  if (Number.isFinite(iso)) return new Date(iso);

  throw verbError(
    'invalid_params',
    `Cannot parse ttl "${s}".`,
    'Pass a duration like "30d" or "12h", or an absolute ISO 8601 timestamp like "2026-07-12T00:00:00Z". Omit ttl for a fact that never expires.',
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// v0.34 Cathedral III — code-intelligence ops (MCP-exposed).
//
// Pre-v0.34 code-callers / code-callees / code-def / code-refs lived only in
// the CLI_ONLY set at cli.ts:30 — agents calling gbrain via MCP couldn't reach
// them and fell through to text search. These wrappers expose the existing
// engine + library functions to the MCP surface with resolver-grade
// descriptions (operations-descriptions.ts) so agents route to them
// automatically during plan-mode.
//
// All four are scope:'read'. Source-scoped via ctx.sourceId when set.
// Both `source_id` and `all_sources` are params so per-call overrides work.
// ──────────────────────────────────────────────────────────────────────────────

const code_callers: Operation = {
  name: 'code_callers',
  description: CODE_CALLERS_DESCRIPTION,
  params: {
    symbol: { type: 'string', required: true, description: 'Symbol to find callers of (bare or qualified name).' },
    limit: { type: 'number', description: 'Max edges returned. Default 100.' },
    source_id: { type: 'string', description: "Scope to a single source. Defaults to ctx.sourceId; '__all__' spans every source for trusted local callers, your granted sources for remote callers." },
    all_sources: { type: 'boolean', description: 'Span sources (equivalent to source_id=__all__): every source locally, your grant remotely.' },
  },
  scope: 'read',
  handler: async (ctx, p) => {
    const symbol = p.symbol as string;
    const limit = (p.limit as number) ?? 100;
    const sourceIdParam = typeof p.source_id === 'string' ? p.source_id : undefined;
    // Single trust+grant resolver: remote callers can't span sources outside
    // their grant, and `__all__` collapses to their grant (not the whole brain).
    const { allSources, sourceId } = resolveCodeIntelScope(ctx, sourceIdParam, p.all_sources === true);
    const edges = await ctx.engine.getCallersOf(symbol, {
      limit,
      allSources,
      sourceId,
    });
    const { resolveCodeReadiness } = await import('./code-graph-readiness.ts');
    const readiness = await resolveCodeReadiness(ctx.engine, {
      kind: 'edge', count: edges.length, sourceId, allSources,
    });
    return { symbol, count: edges.length, status: readiness.status, ready: readiness.ready, callers: edges };
  },
  cliHints: { name: 'code_callers', hidden: true },
};

const code_callees: Operation = {
  name: 'code_callees',
  description: CODE_CALLEES_DESCRIPTION,
  params: {
    symbol: { type: 'string', required: true, description: 'Symbol to find callees of (bare or qualified name).' },
    limit: { type: 'number', description: 'Max edges returned. Default 100.' },
    source_id: { type: 'string', description: "Scope to a single source. Defaults to ctx.sourceId; '__all__' spans every source for trusted local callers, your granted sources for remote callers." },
    all_sources: { type: 'boolean', description: 'Span sources: every source locally, your grant remotely.' },
  },
  scope: 'read',
  handler: async (ctx, p) => {
    const symbol = p.symbol as string;
    const limit = (p.limit as number) ?? 100;
    const sourceIdParam = typeof p.source_id === 'string' ? p.source_id : undefined;
    // Single trust+grant resolver (see code_callers).
    const { allSources, sourceId } = resolveCodeIntelScope(ctx, sourceIdParam, p.all_sources === true);
    const edges = await ctx.engine.getCalleesOf(symbol, {
      limit,
      allSources,
      sourceId,
    });
    const { resolveCodeReadiness } = await import('./code-graph-readiness.ts');
    const readiness = await resolveCodeReadiness(ctx.engine, {
      kind: 'edge', count: edges.length, sourceId, allSources,
    });
    return { symbol, count: edges.length, status: readiness.status, ready: readiness.ready, callees: edges };
  },
  cliHints: { name: 'code_callees', hidden: true },
};

const code_def: Operation = {
  name: 'code_def',
  description: CODE_DEF_DESCRIPTION,
  params: {
    symbol: { type: 'string', required: true, description: 'Symbol name (bare token; e.g., parseMarkdown, BrainEngine).' },
    limit: { type: 'number', description: 'Max definition sites returned. Default 20.' },
    lang: { type: 'string', description: "Filter by content_chunks.language (e.g. 'typescript', 'python')." },
  },
  scope: 'read',
  handler: async (ctx, p) => {
    const { findCodeDef } = await import('../commands/code-def.ts');
    const defs = await findCodeDef(ctx.engine, p.symbol as string, {
      limit: (p.limit as number) ?? 20,
      language: (p.lang as string) || undefined,
    });
    // code_def is brain-wide (not source-scoped); readiness is 'symbol' grain.
    const { resolveCodeReadiness } = await import('./code-graph-readiness.ts');
    const readiness = await resolveCodeReadiness(ctx.engine, { kind: 'symbol', count: defs.length });
    return { symbol: p.symbol as string, count: defs.length, status: readiness.status, ready: readiness.ready, defs };
  },
  cliHints: { name: 'code_def', hidden: true },
};

const code_refs: Operation = {
  name: 'code_refs',
  description: CODE_REFS_DESCRIPTION,
  params: {
    symbol: { type: 'string', required: true, description: 'Symbol to find references to.' },
    limit: { type: 'number', description: 'Max references returned. Default 50.' },
    lang: { type: 'string', description: "Filter by content_chunks.language." },
  },
  scope: 'read',
  handler: async (ctx, p) => {
    const { findCodeRefs } = await import('../commands/code-refs.ts');
    const refs = await findCodeRefs(ctx.engine, p.symbol as string, {
      limit: (p.limit as number) ?? 50,
      language: (p.lang as string) || undefined,
    });
    // code_refs is brain-wide (not source-scoped); readiness is 'symbol' grain.
    const { resolveCodeReadiness } = await import('./code-graph-readiness.ts');
    const readiness = await resolveCodeReadiness(ctx.engine, { kind: 'symbol', count: refs.length });
    return { symbol: p.symbol as string, count: refs.length, status: readiness.status, ready: readiness.ready, refs };
  },
  cliHints: { name: 'code_refs', hidden: true },
};

// --- v0.34 W3: recursive code_blast + code_flow ---

const code_blast: Operation = {
  name: 'code_blast',
  description: 'BEFORE editing any function, run code_blast with the symbol name to surface every transitive caller grouped by depth (direct → 2-hop → 3-hop). Use this during plan-mode to size the change. Returns up to 200 nodes. Returns: {result, depth_groups?, truncation?, cycles_detected?, did_you_mean?, candidates?}. Example ok: {result:"ok", depth_groups:[{depth:1, nodes:[{symbol,chunk_id}], confidence:0.77}], truncation:"none"}.',
  params: {
    symbol: { type: 'string', required: true, description: 'Bare or qualified symbol name (e.g. "performSync" or "src/foo::performSync")' },
    depth: { type: 'number', description: 'Hop cap (default 5, max 8)' },
    max_nodes: { type: 'number', description: 'Result-set cap (default 200)' },
    exact: { type: 'boolean', description: 'Skip bare-name disambiguation; treat symbol as exact qualified name' },
    source_id: { type: 'string', description: 'Source to traverse. Defaults to ctx.sourceId; federated clients with multiple granted sources must specify one.' },
  },
  scope: 'read',
  handler: async (ctx, p) => {
    const { runRecursiveWalk } = await import('./code-intel/recursive-walk.ts');
    const { getCachedOrCompute } = await import('./code-intel/traversal-cache.ts');
    const symbol = p.symbol as string;
    const depth = Math.min((p.depth as number) ?? 5, 8);
    const max_nodes = Math.min((p.max_nodes as number) ?? 200, 200);
    const exact = (p.exact as boolean) ?? false;
    // Single trust+grant resolver: a remote federated client can't traverse a
    // source outside its grant (pre-fix this scoped by bare ctx.sourceId only).
    // Falls back to ctx.sourceId (a required string) for the trusted-local case,
    // exactly preserving pre-fix local behavior.
    const { sourceId: scopedSourceId } = resolveCodeIntelScope(ctx, typeof p.source_id === 'string' ? p.source_id : undefined);
    const sourceId = scopedSourceId ?? ctx.sourceId;
    return getCachedOrCompute(
      ctx.engine,
      { symbol_qualified: symbol, depth, source_id: sourceId },
      () => runRecursiveWalk(ctx.engine, symbol, {
        direction: 'callers',
        depth,
        maxNodes: max_nodes,
        sourceId,
        exact,
      }),
    );
  },
  cliHints: { name: 'code_blast', hidden: true },
};

const code_flow: Operation = {
  name: 'code_flow',
  description: 'When tracing how a request flows through the codebase from entry point to side effect (DB write, HTTP call, file I/O), run code_flow from the entry point. Returns ordered execution chain with terminal-node tags. Returns: same envelope as code_blast plus terminal_nodes: [{symbol, sink_kind}] where sink_kind ∈ "db_call"|"http_call"|"file_io"|"process_exec"|"unknown".',
  params: {
    entry_point: { type: 'string', required: true, description: 'Entry-point symbol name (bare or qualified)' },
    depth: { type: 'number', description: 'Hop cap (default 8, max 12)' },
    max_nodes: { type: 'number', description: 'Result-set cap (default 200)' },
    exact: { type: 'boolean', description: 'Skip bare-name disambiguation' },
    source_id: { type: 'string', description: 'Source to traverse. Defaults to ctx.sourceId; federated clients with multiple granted sources must specify one.' },
  },
  scope: 'read',
  handler: async (ctx, p) => {
    const { runRecursiveWalk } = await import('./code-intel/recursive-walk.ts');
    const { getCachedOrCompute } = await import('./code-intel/traversal-cache.ts');
    const symbol = p.entry_point as string;
    const depth = Math.min((p.depth as number) ?? 8, 12);
    const max_nodes = Math.min((p.max_nodes as number) ?? 200, 200);
    const exact = (p.exact as boolean) ?? false;
    // Single trust+grant resolver (see code_blast).
    const { sourceId: scopedSourceId } = resolveCodeIntelScope(ctx, typeof p.source_id === 'string' ? p.source_id : undefined);
    const sourceId = scopedSourceId ?? ctx.sourceId;
    return getCachedOrCompute(
      ctx.engine,
      { symbol_qualified: symbol + ':flow', depth, source_id: sourceId },
      () => runRecursiveWalk(ctx.engine, symbol, {
        direction: 'callees',
        depth,
        maxNodes: max_nodes,
        sourceId,
        exact,
      }),
    );
  },
  cliHints: { name: 'code_flow', hidden: true },
};

// --- v0.34 W3b: code_traversal_cache admin op ---

const code_traversal_cache_clear: Operation = {
  name: 'code_traversal_cache_clear',
  description: 'Clear cached code_blast / code_flow traversal results. Source-scoped by default; pass all_sources=true to wipe everything (D8 destructive-guard).',
  params: {
    source_id: { type: 'string', description: 'Source to clear. Required unless all_sources=true.' },
    all_sources: { type: 'boolean', description: 'Wipe cache across every source. Explicit opt-out of source-scoping.' },
  },
  mutating: true,
  scope: 'admin',
  localOnly: true,
  handler: async (ctx, p) => {
    // INTENTIONAL exemption from resolveRequestedScope: this is a localOnly
    // admin/destructive op with its own D8 all_sources guard. The read-side
    // trust+grant resolver does not apply here (no remote caller reaches it).
    const { clearTraversalCache } = await import('./code-intel/traversal-cache.ts');
    const sourceId = (p.source_id as string | undefined) ?? ctx.sourceId;
    const allSources = (p.all_sources as boolean) ?? false;
    if (ctx.dryRun) {
      return { dry_run: true, action: 'code_traversal_cache_clear', source_id: sourceId, all_sources: allSources };
    }
    const deleted = await clearTraversalCache(ctx.engine, {
      sourceId: allSources ? undefined : sourceId,
      allSources,
    });
    return { deleted, source_id: allSources ? null : sourceId, all_sources: allSources };
  },
  cliHints: { name: 'code_traversal_cache_clear', hidden: true },
};

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
    } = await import('./embedding-migration.ts');
    const to = p.to as string;
    const dim = p.dim as number | undefined;
    let fromModel: string | undefined;
    let fromDims: number | undefined;
    try {
      const { getEmbeddingModel, getEmbeddingDimensions } = await import('./ai/gateway.ts');
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
    const { persistEmbeddingFileConfig, probeTargetProvider } = await import('../commands/migrate-embeddings.ts');
    // Safety parity with the CLI path: probe the target provider BEFORE any
    // mutation. Without this, `yes:true` would drop the embedding column and
    // only then discover the key/model/dim is wrong.
    const probe = await probeTargetProvider(plan.to_model, plan.to_dims);
    if (!probe.ok) return { status: 'failed', reason: probe.message, plan };
    const applied = await applyEmbeddingMigration(ctx.engine, plan, {
      persistConfig: (m, d) => persistEmbeddingFileConfig(m, d),
    });
    if (applied.status !== 'applied') return { ...applied, plan };
    const { runEmbedCore } = await import('../commands/embed.ts');
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

// --- v0.36 Phase 2: search_by_image (image-as-query) ---

const search_by_image: Operation = {
  name: 'search_by_image',
  description:
    'v0.36 cross-modal Phase 2: image-as-query retrieval. Accepts a local path (CLI), data: URI, or http(s):// URL ' +
    '(SSRF-defended). Returns visually-similar image chunks plus any OCR text they carry. Optional `query` text ' +
    'refinement merges via weighted RRF (D13 hybrid intersect). True image→full-text-knowledge requires Phase 3 ' +
    '(`gbrain reindex --multimodal` + `search.unified_multimodal: true`).',
  params: {
    image_path: { type: 'string', description: 'Absolute path to image (local CLI callers only — rejected for remote MCP per D18).' },
    image_url: { type: 'string', description: 'http(s):// URL to image. SSRF-defended; max 3 redirect hops; 10MB cap.' },
    image_data: { type: 'string', description: 'Base64-encoded image bytes (preferred for remote MCP callers). PNG/JPEG/WebP only.' },
    image_mime: { type: 'string', description: 'Optional MIME hint when ambiguous. Magic-byte sniff is authoritative.' },
    query: { type: 'string', description: 'Optional text refinement; runs hybrid intersect via D13 weighted RRF.' },
    limit: { type: 'number', description: 'Max results (default 20)' },
    offset: { type: 'number', description: 'Skip first N results (for pagination)' },
    source_id: { type: 'string', description: "Scope to a single source. Defaults to ctx.sourceId. '__all__' spans every source for trusted local callers, your granted sources for remote callers." },
  },
  scope: 'read',
  // NOT localOnly: remote MCP callers can pass image_url or image_data
  // (subject to D18 image_path ban + D12 size cap + D23-#6 spend cap).
  handler: async (ctx, p) => {
    const imagePath = p.image_path as string | undefined;
    const imageUrl = p.image_url as string | undefined;
    const imageData = p.image_data as string | undefined;
    const imageMime = (p.image_mime as string) || undefined;
    const queryRefinement = p.query as string | undefined;
    const sourceIdParam = typeof p.source_id === 'string' ? p.source_id : undefined;

    // D18 P0 — remote callers cannot pass image_path. Rejecting at handler
    // entry, before any file I/O fires. validateParams catches it too at the
    // dispatch layer; this is defense-in-depth.
    if (ctx.remote === true && imagePath) {
      throw new Error(
        'permission_denied: image_path is not permitted for remote callers (D18). ' +
        'Use image_url or image_data instead.',
      );
    }

    if (!imagePath && !imageUrl && !imageData) {
      throw new Error('search_by_image requires one of: image_path, image_url, image_data');
    }
    if ([imagePath, imageUrl, imageData].filter(Boolean).length > 1) {
      throw new Error('search_by_image accepts only one of: image_path, image_url, image_data');
    }

    // D23-#6 — remote OAuth clients are charged through the durable
    // reserve-then-settle ledger below. Local CLI callers bypass the cap
    // (clientId="") because they use their own provider credentials.
    const clientId = (ctx.remote === true ? (ctx.auth?.clientId ?? '') : '');

    // Resolve image bytes via the SSRF-defended loader. For remote callers,
    // tighter byte cap.
    const remoteCap = await getRemoteMaxBytes(ctx.engine);
    const localCap = await getLocalMaxBytes(ctx.engine);
    const cap = ctx.remote === true ? remoteCap : localCap;
    const { loadImageInput } = await import('./search/image-loader.ts');
    const loaded = await loadImageInput(
      (imagePath ?? imageUrl ?? `data:${imageMime ?? 'image/png'};base64,${imageData}`)!,
      { maxBytes: cap },
    );

    // Resolve source-scope through the single trust+grant resolver. Pre-fix
    // this branch computed resolvedSourceId then spread sourceScopeOpts(ctx)
    // after it (double-application: the spread silently won, and `__all__`
    // didn't opt out for local callers with ctx.sourceId set). One resolver,
    // one spread — `__all__` spans the brain only for trusted local callers.
    const imageSourceScope = resolveRequestedScope(ctx, sourceIdParam);

    // Reserve immediately before entering the paid search routine. Validation,
    // image loading, and scope resolution happen first so known no-charge
    // failures do not strand reservations. An ambiguous provider failure is
    // settled at this operation's fixed-price upper bound below; pessimistic
    // accounting is safer than reopening daily headroom after the TTL.
    let spendReservationId: string | null = null;
    let estimatedSpendCents = 0;
    if (clientId) {
      const { VOYAGE_MULTIMODAL_3_PER_IMAGE_CENTS } = await import('./spend-log.ts');
      const { reserve } = await import('./minions/budget-meter.ts');
      const calls = 1 + (queryRefinement ? 1 : 0);
      estimatedSpendCents = VOYAGE_MULTIMODAL_3_PER_IMAGE_CENTS * calls;
      const budgetUsd = await getDailyImageBudgetUsd(ctx.engine);
      const reservation = await reserve(ctx.engine, {
        clientId,
        estimatedCents: estimatedSpendCents,
        capCents: budgetUsd * 100,
        provider: 'voyage',
        model: 'voyage-multimodal-3',
      });
      spendReservationId = reservation.reservationId;
    }

    const { searchByImage } = await import('./search/by-image.ts');
    let results: Awaited<ReturnType<typeof searchByImage>>;
    try {
      results = await searchByImage(
        ctx.engine,
        { base64: loaded.base64, mime: loaded.contentType },
        {
          limit: (p.limit as number) || 20,
          offset: (p.offset as number) || 0,
          query: queryRefinement,
          ...imageSourceScope,
        },
      );
    } catch (providerError) {
      if (spendReservationId) {
        const { settle } = await import('./minions/budget-meter.ts');
        try {
          await settle(
            ctx.engine,
            spendReservationId,
            estimatedSpendCents,
            'search_by_image_error_pessimistic',
            ctx.auth?.clientName ?? null,
          );
        } catch (accountingError) {
          throw new AggregateError(
            [providerError, accountingError],
            'search_by_image provider call failed and its spend reservation could not be settled',
          );
        }
      }
      throw providerError;
    }

    // Settlement and the spend-log mirror commit in one transaction. A
    // database/accounting failure blocks the response and leaves the pending
    // reservation holding headroom rather than returning an unmetered success.
    if (spendReservationId) {
      const { settle } = await import('./minions/budget-meter.ts');
      await settle(
        ctx.engine,
        spendReservationId,
        estimatedSpendCents,
        'search_by_image',
        ctx.auth?.clientName ?? null,
      );
    }

    return results;
  },
  cliHints: { name: 'search-by-image' },
};

async function getDailyImageBudgetUsd(engine: BrainEngine): Promise<number> {
  try {
    const v = await engine.getConfig('search.image_query.daily_budget_usd_per_client');
    if (v == null) return 5; // default $5
    const n = parseFloat(v);
    return Number.isFinite(n) && n > 0 ? n : 5;
  } catch {
    return 5;
  }
}

async function getLocalMaxBytes(engine: BrainEngine): Promise<number> {
  try {
    const v = await engine.getConfig('search.image_query.max_bytes');
    if (v == null) return 10 * 1024 * 1024;
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : 10 * 1024 * 1024;
  } catch {
    return 10 * 1024 * 1024;
  }
}

async function getRemoteMaxBytes(engine: BrainEngine): Promise<number> {
  try {
    const v = await engine.getConfig('search.image_query.remote_max_bytes');
    if (v == null) return 2 * 1024 * 1024;
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : 2 * 1024 * 1024;
  } catch {
    return 2 * 1024 * 1024;
  }
}

// --- Exports ---

// ──────────────────────────────────────────────────────────────────────
// v0.40.6.0 Schema Cathedral v3 — 9 new MCP ops for the agent on-ramp.
//
// Read ops (scope: read; NOT localOnly) — any read-scope OAuth client.
// Write ops (scope: admin; NOT localOnly per D2) — admin-scope client
// (your OpenClaw and similar remote agents) can author schema packs
// remotely. Audit log captures actor=mcp:<clientId8> on every mutation
// (see src/core/schema-pack/mutate-audit.ts privacy posture per D20).
//
// Per-call schema_pack opt STAYS rejected for remote callers — that
// trust boundary is enforced by op-trust-gate.ts and is separate from
// the localOnly posture (R2 regression preserved).
// ──────────────────────────────────────────────────────────────────────

const get_active_schema_pack: Operation = {
  name: 'get_active_schema_pack',
  description: 'v0.40.6.0: cheap identity packet for the active schema pack. Returns {pack_name, version, sha8, page_types_count, link_types_count, primitive_summary, source_tier}. Useful for agents to know which pack they are operating against without paying full manifest load cost.',
  params: {},
  scope: 'read',
  handler: async (ctx) => {
    const { loadActivePack, resolveActivePackNameOnly } = await import('./schema-pack/load-active.ts');
    const { loadConfig } = await import('./config.ts');
    const cfg = loadConfig();
    const sourceOpts: Record<string, unknown> = {};
    if (ctx.sourceId) sourceOpts.sourceId = ctx.sourceId;
    const resolution = resolveActivePackNameOnly({ cfg, remote: ctx.remote ?? true, ...sourceOpts });
    const pack = await loadActivePack({ cfg, remote: ctx.remote ?? true, ...sourceOpts });
    const primitiveSummary: Record<string, number> = {};
    for (const t of pack.manifest.page_types) {
      primitiveSummary[t.primitive] = (primitiveSummary[t.primitive] ?? 0) + 1;
    }
    return {
      pack_name: pack.manifest.name,
      version: pack.manifest.version,
      sha8: pack.manifest_sha8,
      identity: pack.identity,
      page_types_count: pack.manifest.page_types.length,
      link_types_count: pack.manifest.link_types.length,
      primitive_summary: primitiveSummary,
      source_tier: resolution.source,
    };
  },
};

const list_schema_packs: Operation = {
  name: 'list_schema_packs',
  description: 'v0.40.6.0: list installed schema packs (bundled + user-installed). Returns {bundled: string[], installed: string[]}. Read-only directory listing.',
  params: {},
  scope: 'read',
  handler: async (_ctx) => {
    const { existsSync, readdirSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { gbrainPath } = await import('./config.ts');
    const { BUNDLED_PACK_NAMES } = await import('./schema-pack/bundled.ts');
    const bundled = [...BUNDLED_PACK_NAMES];
    const installedDir = gbrainPath('schema-packs');
    const installed: string[] = [];
    if (existsSync(installedDir)) {
      for (const entry of readdirSync(installedDir)) {
        const candidates = ['pack.yaml', 'pack.yml', 'pack.json'];
        for (const c of candidates) {
          if (existsSync(join(installedDir, entry, c))) { installed.push(entry); break; }
        }
      }
    }
    return { bundled, installed };
  },
};

const schema_stats: Operation = {
  name: 'schema_stats',
  description: 'v0.40.6.0: per-type page counts + typed-coverage from the DB. Returns {schema_version:1, pack_identity, aggregate, per_source, dead_prefixes}. Multi-source aware via ctx.sourceId/allowedSources.',
  params: {},
  scope: 'read',
  handler: async (ctx) => {
    const { runStatsCore } = await import('./schema-pack/stats.ts');
    const scope = sourceScopeOpts(ctx);
    const opts: { sourceId?: string; sourceIds?: string[] } = {};
    if (scope.sourceIds && scope.sourceIds.length > 0) opts.sourceIds = scope.sourceIds;
    else if (scope.sourceId) opts.sourceId = scope.sourceId;
    return runStatsCore(ctx, opts);
  },
};

const schema_lint: Operation = {
  name: 'schema_lint',
  description: 'v0.40.6.0: lint the active (or named) schema pack. File-plane rules only over MCP — the with_db option is rejected for remote callers (DB-aware rules require local CLI). Returns {ok, errors, warnings} structured report.',
  params: {
    pack: { type: 'string', description: 'Pack name (default: active pack)' },
  },
  scope: 'read',
  handler: async (ctx, p) => {
    const { runAllLintRules } = await import('./schema-pack/lint-rules.ts');
    const { loadActivePack } = await import('./schema-pack/load-active.ts');
    const { loadConfig, gbrainPath } = await import('./config.ts');
    const { existsSync } = await import('node:fs');
    const { join } = await import('node:path');
    const cfg = loadConfig();
    let manifest;
    if (p.pack) {
      // Locate by name without trust-gating per-call schema_pack opt
      // (that's a separate axis — this is just file lookup).
      const packName = p.pack as string;
      const candidates = ['pack.yaml', 'pack.yml', 'pack.json'];
      let path: string | null = null;
      for (const c of candidates) {
        const candidate = join(gbrainPath('schema-packs', packName), c);
        if (existsSync(candidate)) { path = candidate; break; }
      }
      if (!path) return { error: 'pack_not_found', pack: packName };
      const { loadPackFromFile: loader } = await import('./schema-pack/loader.ts');
      manifest = loader(path);
    } else {
      const resolved = await loadActivePack({ cfg, remote: ctx.remote ?? true, sourceId: ctx.sourceId });
      manifest = resolved.manifest;
    }
    // File-plane only over MCP; the engine-aware --with-db opt-in is
    // CLI-only (Phase 5 wiring). MCP callers get the 9 file-plane rules.
    return await runAllLintRules(manifest);
  },
};

const schema_graph: Operation = {
  name: 'schema_graph',
  description: 'v0.40.6.0: schema pack graph as JSON edges. Returns {nodes: [{name, primitive}], edges: [{from, verb, to}]} derived from link_types inference + frontmatter_links.',
  params: {},
  scope: 'read',
  handler: async (ctx) => {
    const { loadActivePack } = await import('./schema-pack/load-active.ts');
    const { loadConfig } = await import('./config.ts');
    const cfg = loadConfig();
    const pack = await loadActivePack({ cfg, remote: ctx.remote ?? true, sourceId: ctx.sourceId });
    const nodes = pack.manifest.page_types.map((t) => ({ name: t.name, primitive: t.primitive }));
    const edges: Array<{ from: string; verb: string; to: string }> = [];
    for (const lt of pack.manifest.link_types) {
      if (lt.inference?.page_type) {
        edges.push({
          from: lt.inference.page_type,
          verb: lt.name,
          to: lt.inference.target_type ?? '*',
        });
      }
    }
    for (const fl of pack.manifest.frontmatter_links) {
      edges.push({ from: fl.page_type, verb: fl.link_type, to: '*' });
    }
    return { schema_version: 1, pack: pack.manifest.name, nodes, edges };
  },
};

const schema_explain_type: Operation = {
  name: 'schema_explain_type',
  description: 'v0.40.6.0: resolved settings for a single page_type in the active pack. Returns {pack, type, primitive, path_prefixes, aliases, extractable, expert_routing}.',
  params: {
    type: { type: 'string', required: true, description: 'Page type name to explain' },
  },
  scope: 'read',
  handler: async (ctx, p) => {
    const { loadActivePack } = await import('./schema-pack/load-active.ts');
    const { loadConfig } = await import('./config.ts');
    const cfg = loadConfig();
    const pack = await loadActivePack({ cfg, remote: ctx.remote ?? true, sourceId: ctx.sourceId });
    const found = pack.manifest.page_types.find((t) => t.name === p.type);
    if (!found) return { error: 'type_not_found', type: p.type as string, pack: pack.manifest.name };
    return { schema_version: 1, pack: pack.manifest.name, type: found };
  },
};

const schema_review_orphans: Operation = {
  name: 'schema_review_orphans',
  description: 'v0.40.6.0: list pages with no active-pack type match. Returns {orphan_count, orphans: [{slug, source_id}]}.',
  params: {
    limit: { type: 'number', description: 'Max orphans to return (default 100)' },
  },
  scope: 'read',
  handler: async (ctx, p) => {
    const limit = Math.max(1, Math.min(10000, (p.limit as number) ?? 100));
    const scope = sourceScopeOpts(ctx);
    let where = `WHERE deleted_at IS NULL AND (type IS NULL OR type = '')`;
    const params: unknown[] = [];
    if (scope.sourceIds && scope.sourceIds.length > 0) {
      where += ` AND source_id = ANY($1::text[])`;
      params.push(scope.sourceIds);
    } else if (scope.sourceId) {
      where += ` AND source_id = $1`;
      params.push(scope.sourceId);
    }
    try {
      const rows = await ctx.engine.executeRaw<{ slug: string; source_id: string }>(
        `SELECT slug, COALESCE(source_id, 'default') AS source_id FROM pages ${where} ORDER BY source_id, slug LIMIT ${limit}`,
        params,
      );
      return {
        schema_version: 1,
        orphan_count: rows.length,
        orphans: rows.map((r) => ({ slug: r.slug, source_id: r.source_id })),
      };
    } catch {
      return { schema_version: 1, orphan_count: 0, orphans: [] };
    }
  },
};

const schema_apply_mutations: Operation = {
  name: 'schema_apply_mutations',
  description: 'v0.40.7.0: batched schema pack mutation. ATOMIC: every mutation is validated against an in-memory manifest first, and the pack file is written to disk at most once, after the FULL batch has proven valid — so a failure at any point leaves the pack file byte-identical to its pre-batch state (never a partial write). Audit log records one batch_id. Admin scope; NOT localOnly so remote agents (your OpenClaw, etc.) can author packs over normal MCP. Mutation shape per ApplyMutationsRequest type — supports add_type / remove_type / update_type / add_alias / remove_alias / add_prefix / remove_prefix / add_link_type / remove_link_type / set_extractable / set_expert_routing.',
  params: {
    pack: { type: 'string', required: true, description: 'Pack to mutate (must not be bundled)' },
    mutations: {
      type: 'array',
      required: true,
      description: 'Array of {op, ...args} mutation records to apply atomically',
      items: { type: 'object' },
    },
    force: { type: 'boolean', description: 'Steal stale per-pack lock' },
  },
  scope: 'admin',
  mutating: true,
  handler: async (ctx, p) => {
    const pack = p.pack as string;
    const mutations = p.mutations as Array<{ op: string; [k: string]: unknown }>;
    const force = p.force === true;
    if (!Array.isArray(mutations) || mutations.length === 0) {
      return { error: 'invalid_request', message: 'mutations must be a non-empty array' };
    }
    const batchId = `batch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const actor = ctx.auth?.clientId ? `mcp:${ctx.auth.clientId.slice(0, 8)}` : 'cli';
    const sourceId = ctx.sourceId;  // codex C5: write-side scoping
    // `applyMutationsAtomic` (issue #2581) owns the lock + single read +
    // single write for the whole batch: every mutation is validated
    // in-memory first, and the pack file is written at most once, only
    // after the FULL batch checks out. That is what makes this actually
    // atomic (a failure at any index can never leave earlier mutations on
    // disk), vs. the old per-mutation-writes-as-it-goes shape.
    const { applyMutationsAtomic } = await import('./schema-pack/mutate.ts');
    try {
      const results = await applyMutationsAtomic(pack, mutations, {
        actor: actor as 'cli' | `mcp:${string}`,
        batchId,
        engine: ctx.engine,
        ...(sourceId ? { sourceId } : {}),
        ...(force ? { force: true } : {}),
      });
      return {
        schema_version: 1,
        pack,
        batch_id: batchId,
        mutations_applied: results.length,
        results,
      };
    } catch (e) {
      const code = (e as { code?: string }).code ?? 'UNKNOWN';
      const failedAtIndex = (e as { details?: { index?: number } }).details?.index;
      return {
        error: 'mutation_failed',
        code,
        message: (e as Error).message,
        batch_id: batchId,
        // Nothing was written to disk — applyMutationsAtomic only writes
        // once, after every mutation in the batch has validated cleanly.
        // (Pre-fix, this field was `partial_results` and listed mutations
        // that HAD already landed on disk, because the old implementation
        // wrote as it went — that shape is gone; a failed batch can no
        // longer imply partial application.)
        mutations_applied: 0,
        pack_unchanged: true,
        ...(failedAtIndex !== undefined ? { failed_at_index: failedAtIndex } : {}),
      };
    }
  },
};

const reload_schema_pack: Operation = {
  name: 'reload_schema_pack',
  description: 'v0.40.6.0: flush the in-process schema pack cache so the next loadActivePack re-reads from disk. Cascades through extends-chain (codex C6). Admin scope; NOT localOnly. Returns {invalidated: string[]}.',
  params: {
    pack: { type: 'string', description: 'Pack name to invalidate (omit to flush all)' },
  },
  scope: 'admin',
  mutating: false,  // no DB writes
  handler: async (_ctx, p) => {
    const { invalidatePackCache } = await import('./schema-pack/registry.ts');
    return invalidatePackCache(p.pack as string | undefined);
  },
};

// v0.41.18.0 (A7 + T16, codex finding #5): MCP op for federated / thin-client
// brain installs to drive `gbrain onboard --auto` over MCP. Admin scope
// (NOT localOnly) so remote agents authenticated via OAuth can probe
// brain health + submit auto-eligible remediation handlers.
//
// Critical security gate (codex #5): admin scope alone is NOT sufficient
// to submit handlers in PROTECTED_JOB_NAMES (synthesize, patterns,
// consolidate, extract-takes-from-pages, contextual_reindex_per_chunk).
// Without this gate, an admin-scoped OAuth token would bypass the same
// guard that `submit_job` enforces. The new NAMED scope
// `run_protected_onboard` MUST be granted IN ADDITION TO admin for any
// protected child handler to fire.
//
// Behavior:
//   - mode='check' (default): returns the OnboardReport JSON envelope,
//     never submits jobs. Admin scope sufficient.
//   - mode='auto':            submits auto_apply tier. Admin + non-protected
//                             handlers only.
//   - mode='auto-with-prompt': submits auto_apply + prompt_required tier.
//                             Same protection check.
//
// Any LLM-bearing handler the plan would have submitted gets filtered out
// unless the caller has run_protected_onboard. Filtered items appear in
// the response with status='skipped_missing_scope' so the caller knows
// what they would have gotten with the right grants.
const run_onboard: Operation = {
  name: 'run_onboard',
  description: 'Probe brain health + optionally submit onboard remediations. Admin scope required. Protected handlers (LLM-bearing) require run_protected_onboard scope ADDITIONALLY.',
  params: {
    mode: { type: 'string', description: "'check' (default), 'auto', or 'auto-with-prompt'" },
    target_score: { type: 'number', description: 'Target brain_score (default 90)' },
    max_usd: { type: 'number', description: 'USD cap for autopilot path (required for auto modes)' },
  },
  mutating: true,
  scope: 'admin',
  handler: async (ctx, p) => {
    const mode = (typeof p.mode === 'string' ? p.mode : 'check') as 'check' | 'auto' | 'auto-with-prompt';
    const targetScore = typeof p.target_score === 'number' ? p.target_score : 90;
    const maxUsd = typeof p.max_usd === 'number' ? p.max_usd : undefined;

    const { computeRemediationPlan, runRemediation } = await import('./remediation/index.ts');
    const { runAllOnboardChecks } = await import('./onboard/checks.ts');
    const { buildOnboardReport } = await import('./onboard/render.ts');

    // Per A26: source-scope via sourceScopeOpts(ctx). The recommendation
    // planner is brain-wide today; future extension can scope by reading
    // ctx.sourceId / ctx.auth.allowedSources for per-source plans.

    let extraRemediations: import('./remediation-step.ts').RemediationStep[] = [];
    try {
      const checkResults = await runAllOnboardChecks(ctx.engine);
      extraRemediations = checkResults.flatMap((r) => r.remediations);
    } catch {
      // Fail-open per A19 — return plan without extras rather than error.
    }

    // 'check' mode: just return the plan + JSON envelope. No submission.
    if (mode === 'check') {
      const plan = await computeRemediationPlan(ctx.engine, { targetScore, extraRemediations });
      const report = buildOnboardReport(plan);
      return report;
    }

    // 'auto' and 'auto-with-prompt' modes: require --max-usd per A12 + A20
    // safety posture (cron-safety; refuses surprise spend).
    if (maxUsd === undefined) {
      throw new OperationError('invalid_params', `mode='${mode}' requires max_usd (cron-safety cap)`);
    }

    // Critical T16 + codex #5 security gate: filter out PROTECTED_JOB_NAMES
    // unless the caller has the run_protected_onboard scope IN ADDITION
    // to admin. Admin alone is insufficient.
    const grantedScopes = ctx.auth?.scopes ?? [];
    const canRunProtected = grantedScopes.includes('run_protected_onboard');
    const { isProtectedJobName } = await import('./minions/protected-names.ts');

    const skippedMissingScope: Array<{ id: string; job: string; reason: string }> = [];
    const allowedExtras = extraRemediations.filter((r) => {
      if (canRunProtected) return true;
      if (isProtectedJobName(r.job)) {
        skippedMissingScope.push({ id: r.id, job: r.job, reason: 'requires run_protected_onboard scope' });
        return false;
      }
      return true;
    });

    // Run remediation with filtered extras. Hooks emit nothing — MCP
    // returns structured result. Per A23 client_id attribution: stamp
    // job.data.client_id on each submission so the spend chain (T10)
    // attributes correctly. The library doesn't do this today; the
    // upstream submit-side gating in submit_job filters protected names
    // for ctx.remote !== false callers, so even if MCP run_onboard had a
    // typo, the underlying queue.add would reject. Defense-in-depth.
    const result = await runRemediation(
      ctx.engine,
      { targetScore, maxUsd, extraRemediations: allowedExtras },
      {},
    );

    return {
      ...result,
      skipped_missing_scope: skippedMissingScope,
    };
  },
};

// v0.41.20.0 SkillOpt — MCP exposure (admin scope + per-skill allowlist
// via the resolver inside the handler). Designed for trusted admin tokens
// that want to drive optimization remotely; the same trust gates as the
// CLI fire (working tree, install path, lock acquisition, bundled-skill
// guard). NOT localOnly so admin HTTP MCP clients can invoke.
const run_skillopt: Operation = {
  name: 'run_skillopt',
  description: 'Run SkillOpt against a single skill. Admin scope; mutating; rate-limited per-skill via DB lock. See gbrain skillopt CLI for the full flag surface.',
  params: {
    skill_name: { type: 'string', required: true, description: 'Kebab-case skill name (resolves to skills/<name>/SKILL.md)' },
    benchmark_path: { type: 'string', description: 'Absolute path to benchmark JSONL; defaults to skills/<name>/skillopt-benchmark.jsonl' },
    epochs: { type: 'number', description: 'Default 4' },
    batch_size: { type: 'number', description: 'Default 8' },
    lr: { type: 'number', description: 'Default 4' },
    max_cost_usd: { type: 'number', description: 'Default 5.00' },
    no_mutate: { type: 'boolean', description: 'Write proposed.md without replacing SKILL.md' },
    allow_mutate_bundled: { type: 'boolean', description: 'Required to mutate bundled skills' },
    held_out_path: { type: 'string', description: 'Path to a held-out test set (JSONL). REQUIRED (>=5 rows) to mutate a bundled skill in place — otherwise the run hard-refuses. Remote callers: must resolve within the skills directory.' },
    dry_run: { type: 'boolean', description: 'Cost preview, no LLM calls' },
  },
  mutating: true,
  scope: 'admin',
  localOnly: false,
  handler: async (ctx, p) => {
    // SECURITY: skill_name is joined into filesystem paths (SKILL.md, default
    // benchmark, checkpoint, history, best.md, proposed.md). A traversal-shaped
    // name (`../`, absolute) would escape the skills dir even WITH the
    // caller-supplied-path confinement below. Validate kebab-only up front so
    // every derived path is contained by construction. Applies to all callers.
    const skillNameRaw = (p.skill_name as string) ?? '';
    if (!/^[a-z0-9][a-z0-9-]*$/.test(skillNameRaw)) {
      throw new OperationError(`run_skillopt: skill_name must be kebab-case (matching ^[a-z0-9][a-z0-9-]*$); got '${skillNameRaw}'`, 'invalid_params');
    }
    if (ctx.remote !== false) {
      // Remote: enforce per-skill allowlist read from config.
      // `skillopt.allowed_skills` is a JSON-array config of skill names
      // an admin-scoped OAuth client may target. Default DENY-ALL: when
      // unset, MCP cannot drive skillopt on any skill.
      const allowedRaw = await ctx.engine.getConfig('skillopt.allowed_skills');
      let allowed: string[] = [];
      try {
        if (allowedRaw) allowed = JSON.parse(allowedRaw) as string[];
      } catch { /* fall through to deny */ }
      const skillName = (p.skill_name as string) ?? '';
      if (!allowed.includes(skillName)) {
        throw new OperationError(`run_skillopt: skill '${skillName}' is not in skillopt.allowed_skills allowlist (default deny-all for remote callers)`, 'permission_denied');
      }
    }
    const { runSkillOpt } = await import('./skillopt/orchestrator.ts');
    const { autoDetectSkillsDirReadOnly } = await import('./repo-root.ts');
    const { resolveModel } = await import('./model-config.ts');
    const detected = autoDetectSkillsDirReadOnly(process.cwd());
    const skillsDir = detected.dir;
    if (!skillsDir) {
      throw new OperationError('run_skillopt: skills directory not found', 'config_error');
    }
    const optimizerModel = await resolveModel(ctx.engine, { tier: 'deep', fallback: 'anthropic:claude-opus-4-7' });
    const targetModel = await resolveModel(ctx.engine, { tier: 'subagent', fallback: 'anthropic:claude-sonnet-4-6' });
    const judgeModel = await resolveModel(ctx.engine, { tier: 'reasoning', fallback: 'anthropic:claude-sonnet-4-6' });
    const skillName = p.skill_name as string;
    const benchmarkPath = (p.benchmark_path as string) ??
      `${skillsDir}/${skillName}/skillopt-benchmark.jsonl`;
    const heldOutPath = p.held_out_path as string | undefined;
    // SECURITY: remote callers must NOT be able to point benchmark/held-out at
    // arbitrary host files (loadBenchmark → fs.readFileSync would otherwise be an
    // arbitrary-read + existence oracle). Confine any caller-supplied path to the
    // skills directory. Local CLI callers (ctx.remote === false) are unconfined.
    if (ctx.remote !== false) {
      const nodePath = await import('node:path');
      const nodeFs = await import('node:fs');
      const rootReal = (() => {
        try { return nodeFs.realpathSync(skillsDir); } catch { return nodePath.resolve(skillsDir); }
      })();
      const confine = (label: string, candidate: string | undefined): void => {
        if (!candidate) return;
        const resolved = nodePath.resolve(candidate);
        let real = resolved;
        try {
          real = nodeFs.realpathSync(resolved);
        } catch {
          // Not yet present: canonicalize the nearest existing ancestor so a
          // legit in-dir path under a symlinked skillsDir (e.g. macOS /tmp ->
          // /private/tmp, Conductor worktrees) isn't wrongly rejected.
          try { real = nodePath.join(nodeFs.realpathSync(nodePath.dirname(resolved)), nodePath.basename(resolved)); }
          catch { /* parent also missing; fall back to resolved form */ }
        }
        if (real !== rootReal && !real.startsWith(rootReal + nodePath.sep)) {
          throw new OperationError(`run_skillopt: ${label} must resolve within the skills directory for remote callers`, 'permission_denied');
        }
      };
      confine('benchmark_path', p.benchmark_path as string | undefined);
      confine('held_out_path', heldOutPath);
    }
    const result = await runSkillOpt({
      engine: ctx.engine,
      skillName,
      skillsDir,
      benchmarkPath,
      epochs: (p.epochs as number) ?? 4,
      batchSize: (p.batch_size as number) ?? 8,
      lr: (p.lr as number) ?? 4,
      lrSchedule: 'cosine',
      split: [4, 1, 5],
      optimizerModel,
      targetModel,
      judgeModel,
      mode: 'patch',
      dryRun: (p.dry_run as boolean) === true,
      noMutate: (p.no_mutate as boolean) === true,
      allowMutateBundled: (p.allow_mutate_bundled as boolean) === true,
      bootstrapReviewed: false,
      ...(heldOutPath ? { heldOutPath } : {}),
      json: true,
      maxCostUsd: (p.max_cost_usd as number) ?? 5.0,
      maxRuntimeMin: 30,
      force: false,
    });
    return {
      outcome: result.outcome,
      receipt: result.receipt,
      mutated_skill_file: result.mutatedSkillFile,
      proposed_path: result.proposedPath,
    };
  },
};

// ── v0.42.x — Life Chronicle (#2390) timeline read ops ───────────────────
// CLI names avoid the existing `timeline` (get_timeline, a page's own timeline):
// `gbrain day <date>` / `gbrain since <date>` / `gbrain last-seen <entity>`.
// All route through sourceScopeOpts(ctx) so reads honor source isolation.
const chronicle_day: Operation = {
  name: 'chronicle_day',
  description:
    'Life Chronicle: events + timeline entries on a given day (or its ISO week when week=true), ' +
    "ordered chronologically; each row backlinks to its depth page. Distinct from `get_timeline`/" +
    "`gbrain timeline <slug>`, which shows ONE page's timeline. CLI: `gbrain day <date>`.",
  scope: 'read',
  params: {
    date: { type: 'string', required: true, description: 'Day as YYYY-MM-DD.' },
    week: { type: 'boolean', description: 'Expand to the ISO week (Mon–Sun) containing the date.' },
    limit: { type: 'number', description: 'Max rows (default 200).' },
    narrative: { type: 'boolean', description: 'Also return a prose day-by-day narrative.' },
  },
  handler: async (ctx, p) => {
    const rows = await ctx.engine.getTimelineForDate(String(p.date), {
      week: p.week === true,
      limit: typeof p.limit === 'number' ? p.limit : undefined,
      ...sourceScopeOpts(ctx),
    });
    if (p.narrative === true) {
      const { renderTimelineNarrative } = await import('./chronicle/narrative.ts');
      return { date: String(p.date), narrative: renderTimelineNarrative(rows), events: rows };
    }
    return rows;
  },
  cliHints: { name: 'day', positional: ['date'] },
};

const chronicle_on_this_day: Operation = {
  name: 'chronicle_on_this_day',
  description:
    'Life Chronicle: events from the same calendar day in PRIOR years ("on this day"). ' +
    'CLI: `gbrain on-this-day [--date YYYY-MM-DD]`.',
  scope: 'read',
  params: {
    date: { type: 'string', description: 'Anchor day YYYY-MM-DD (default today); matches its month-day in prior years.' },
    limit: { type: 'number', description: 'Max rows (default 50).' },
  },
  handler: async (ctx, p) => ctx.engine.getOnThisDay({
    date: typeof p.date === 'string' ? p.date : undefined,
    limit: typeof p.limit === 'number' ? p.limit : undefined,
    ...sourceScopeOpts(ctx),
  }),
  cliHints: { name: 'on-this-day' },
};

const chronicle_since: Operation = {
  name: 'chronicle_since',
  description:
    'Life Chronicle: events + timeline entries on or after a date, optionally filtered by event kind. ' +
    'CLI: `gbrain since <date> [--kind commitment]`.',
  scope: 'read',
  params: {
    date: { type: 'string', required: true, description: 'Lower-bound day as YYYY-MM-DD (inclusive).' },
    kind: { type: 'string', description: "Filter event projections by event.kind (e.g. 'commitment')." },
    limit: { type: 'number', description: 'Max rows (default 200).' },
  },
  handler: async (ctx, p) => {
    return ctx.engine.getSince(String(p.date), {
      kind: typeof p.kind === 'string' ? p.kind : undefined,
      limit: typeof p.limit === 'number' ? p.limit : undefined,
      ...sourceScopeOpts(ctx),
    });
  },
  cliHints: { name: 'since', positional: ['date'] },
};

const chronicle_last_seen: Operation = {
  name: 'chronicle_last_seen',
  description:
    "Life Chronicle: when an entity was last seen — its own timeline rows OR an event's `who`. " +
    'Returns last_date, the event slug, and days_ago. CLI: `gbrain last-seen <entity-slug>`.',
  scope: 'read',
  params: {
    entity: { type: 'string', required: true, description: 'Entity page slug (e.g. people/sarah-chen).' },
    asof: { type: 'string', description: 'Reference day YYYY-MM-DD for days_ago (default today).' },
  },
  handler: async (ctx, p) => {
    return ctx.engine.getLastSeen(String(p.entity), {
      asof: typeof p.asof === 'string' ? p.asof : undefined,
      ...sourceScopeOpts(ctx),
    });
  },
  cliHints: { name: 'last-seen', positional: ['entity'] },
};

const ontology_get: Operation = {
  name: 'ontology_get',
  description:
    "Life Chronicle: the current resolved per-entity ontology (dimension → value) at `asof` " +
    "(default now), with provenance + confidence + validity. CLI: `gbrain ontology <entity> [--asof YYYY-MM-DD]`.",
  scope: 'read',
  params: {
    entity: { type: 'string', required: true, description: 'Entity page slug (e.g. people/sarah-chen).' },
    asof: { type: 'string', description: 'Valid-time as-of day YYYY-MM-DD (time-travel; default now).' },
    min_confidence: { type: 'number', description: 'Only return observations at/above this confidence (0..1).' },
    include_quarantined: { type: 'boolean', description: 'Include quarantined novel dimensions (default false).' },
  },
  handler: async (ctx, p) => {
    const rows = await ctx.engine.getOntology(String(p.entity), {
      asof: typeof p.asof === 'string' ? p.asof : undefined,
      minConfidence: typeof p.min_confidence === 'number' ? p.min_confidence : undefined,
      includeQuarantined: p.include_quarantined === true,
      ...sourceScopeOpts(ctx),
    });
    // Remote redaction: never surface diary-sourced ontology to untrusted callers.
    return ctx.remote !== false ? rows.filter((r) => !(r.source ?? '').startsWith('life/diary/')) : rows;
  },
  cliHints: { name: 'ontology', positional: ['entity'] },
};

const ontology_propose: Operation = {
  name: 'ontology_propose',
  description:
    'Life Chronicle: record one ontology observation (entity has dimension=value), sourced + ' +
    'confidence-weighted + bi-temporal. Idempotent on (entity,dimension,value,source). A new value ' +
    'supersedes the prior; a backdated conflict is flagged not rewritten. CLI: `gbrain ontology-add <entity> <dimension> <value>`.',
  scope: 'write',
  mutating: true,
  params: {
    entity: { type: 'string', required: true, description: 'Entity page slug.' },
    dimension: { type: 'string', required: true, description: 'Dimension (e.g. role, risk_tolerance). Normalized at write.' },
    value: { type: 'string', required: true, description: 'The resolved value (e.g. advisor).' },
    confidence: { type: 'number', description: '0..1; default 0.7.' },
    source: { type: 'string', description: 'Provenance (page slug / uri); default "manual".' },
    valid_from: { type: 'string', description: 'ISO date the value became true (default: now).' },
    valid_to: { type: 'string', description: 'ISO date the value stopped being true (default: open).' },
    visibility: { type: 'string', enum: ['private', 'world'], description: 'Default private.' },
  },
  handler: async (ctx, p) => {
    // [ENG-8] Same unset-vs-explicit ladder as extract_facts: explicit
    // caller visibility wins; unset resolves facts.default_visibility.
    const { resolveVisibilityParam } = await import('./facts/visibility.ts');
    return ctx.engine.mergeOntologyFact({
      entitySlug: String(p.entity),
      dimension: String(p.dimension),
      value: String(p.value),
      confidence: typeof p.confidence === 'number' ? p.confidence : undefined,
      source: typeof p.source === 'string' && p.source ? p.source : 'manual',
      validFrom: typeof p.valid_from === 'string' ? p.valid_from : undefined,
      validTo: typeof p.valid_to === 'string' ? p.valid_to : undefined,
      visibility: await resolveVisibilityParam(ctx.engine, p.visibility),
      sourceId: ctx.sourceId,
    });
  },
  cliHints: { name: 'ontology-add', positional: ['entity', 'dimension', 'value'] },
};

const ontology_dimensions: Operation = {
  name: 'ontology_dimensions',
  description:
    'Life Chronicle meta-ontology: which dimensions the brain tracks across entities, with ' +
    'entity + observation counts. CLI: `gbrain ontology-dimensions`.',
  scope: 'read',
  params: {},
  handler: async (ctx) => ctx.engine.discoverOntologyDimensions(sourceScopeOpts(ctx)),
  cliHints: { name: 'ontology-dimensions' },
};

const ontology_conflicts: Operation = {
  name: 'ontology_conflicts',
  description:
    'Life Chronicle: dimensions with ≥2 distinct current values from ≥2 provenances (genuine ' +
    'disagreement, not temporal supersession). CLI: `gbrain ontology-contradictions`.',
  scope: 'read',
  params: {
    min_confidence: { type: 'number', description: 'Only consider observations at/above this confidence (0..1).' },
  },
  handler: async (ctx, p) => {
    const conflicts = await ctx.engine.findOntologyConflicts({
      minConfidence: typeof p.min_confidence === 'number' ? p.min_confidence : undefined,
      ...sourceScopeOpts(ctx),
    });
    if (ctx.remote === false) return conflicts;
    // Remote: redact diary-sourced values; drop conflicts that no longer have
    // ≥2 distinct values once diary provenance is removed (no leak via conflicts).
    return conflicts
      .map((c) => ({ ...c, values: c.values.filter((v) => !(v.source ?? '').startsWith('life/diary/')) }))
      .filter((c) => new Set(c.values.map((v) => v.value)).size >= 2);
  },
  cliHints: { name: 'ontology-contradictions' },
};

const volunteer_chronicle: Operation = {
  name: 'volunteer_chronicle',
  description:
    'Life Chronicle agent-orientation: the recent timeline (last N days) + the current ' +
    'validity-resolved ontology for the named entities, in one zero-LLM payload, so an agent ' +
    'orients before acting. Diary-sourced ontology is redacted for remote callers. ' +
    'CLI: `gbrain orient [--days 7] [--entities people/a,people/b]`.',
  scope: 'read',
  params: {
    days: { type: 'number', description: 'Recent-timeline lookback in days (default 7).' },
    entities: { type: 'string', description: 'Comma-separated entity slugs to resolve ontology for.' },
    limit: { type: 'number', description: 'Max timeline rows (default 50).' },
  },
  handler: async (ctx, p) => {
    const { loadChronicleContext } = await import('./context/chronicle-context.ts');
    const entities = typeof p.entities === 'string'
      ? p.entities.split(',').map((s) => s.trim()).filter(Boolean)
      : undefined;
    return loadChronicleContext(ctx.engine, {
      days: typeof p.days === 'number' ? p.days : undefined,
      entities,
      limit: typeof p.limit === 'number' ? p.limit : undefined,
      remote: ctx.remote !== false,
      ...sourceScopeOpts(ctx),
    });
  },
  cliHints: { name: 'orient' },
};

const chronicle_backfill: Operation = {
  name: 'chronicle_backfill',
  description:
    'Life Chronicle: sweep existing meeting/conversation/calendar pages into timeline events by ' +
    'enqueuing chronicle_extract jobs (one per eligible page). --dry-run counts without enqueuing. ' +
    'Local-only bulk op. CLI: `gbrain chronicle-backfill [--since YYYY-MM-DD] [--limit N] [--dry-run]`.',
  scope: 'admin',
  mutating: true,
  localOnly: true,
  params: {
    since: { type: 'string', description: 'Only pages updated on/after this date (YYYY-MM-DD).' },
    limit: { type: 'number', description: 'Max pages per type to sweep (default 1000).' },
    dry_run: { type: 'boolean', description: 'Count eligible pages without enqueuing.' },
  },
  handler: async (ctx, p) => {
    const { isChronicleEligible } = await import('./chronicle/eligibility.ts');
    const TYPES = ['meeting', 'conversation', 'calendar-event'] as const;
    const limit = typeof p.limit === 'number' ? p.limit : 1000;
    const updated_after = typeof p.since === 'string' ? p.since : undefined;
    const dryRun = p.dry_run === true;
    const scope = sourceScopeOpts(ctx);
    type QueueLike = { add: (n: string, d: Record<string, unknown>) => Promise<unknown> };
    let queue: QueueLike | null = null;
    if (!dryRun) {
      const { MinionQueue } = await import('./minions/queue.ts');
      queue = new MinionQueue(ctx.engine) as unknown as QueueLike;
    }
    let scanned = 0, eligible = 0, enqueued = 0;
    const errors: { slug: string; error: string }[] = [];
    for (const type of TYPES) {
      const pages = await ctx.engine.listPages({ type, updated_after, limit, ...scope });
      for (const page of pages) {
        scanned++;
        const dreamGenerated = (page.frontmatter as Record<string, unknown> | undefined)?.dream_generated === true;
        const elig = isChronicleEligible({ type: page.type, slug: page.slug, body: page.compiled_truth, dreamGenerated });
        if (!elig.ok) continue;
        eligible++;
        if (dryRun || !queue) continue;
        try {
          await queue.add('chronicle_extract', { slug: page.slug, sourceId: ctx.sourceId ?? 'default' });
          enqueued++;
        } catch (e) {
          // Never swallow — surface per-page failures (the #2057 no-swallow pattern).
          errors.push({ slug: page.slug, error: e instanceof Error ? e.message : String(e) });
        }
      }
    }
    return { scanned, eligible, enqueued, dry_run: dryRun, errors };
  },
  cliHints: { name: 'chronicle-backfill' },
};

// ---------------------------------------------------------------------------
// Extraction quarantine lane (issue #160)
//
// `extractAndEnrich` regex-extracts entity names from arbitrary text and
// creates people/ + companies/ stub pages. These three ops are its ONLY
// sanctioned surface:
//   - extract_entities    — run extraction. Direct authoritative writes need
//                           BOTH the trusted local CLI (ctx.remote === false)
//                           AND the explicit --trusted-extraction flag;
//                           everything else lands in the quarantine lane
//                           (frontmatter provenance/status markers).
//   - extraction_pending  — list unverified stubs awaiting review.
//   - extraction_review   — promote (status → verified) or reject
//                           (soft-delete) in batch. Owner-only (fail-closed
//                           on ctx.remote): THIS surface never lets a remote
//                           caller flip the status markers. Scope note: the
//                           markers are ordinary frontmatter, so a caller who
//                           already holds generic remote put_page write scope
//                           can rewrite the page (markers included) — that
//                           caller could equally author an unmarked people/
//                           page directly, so the lane adds no privilege
//                           there; put_page authz is its own boundary.
// ---------------------------------------------------------------------------

// Resource guards for extract_entities (#160 hardening): bound the work a
// single remote write-scope call can trigger. ponytail: flat caps; make them
// config knobs only if a real workload hits them.
const MAX_EXTRACT_TEXT_CHARS = 200_000;
const MAX_EXTRACT_ENTITIES = 200;

const extract_entities: Operation = {
  name: 'extract_entities',
  description: 'Extract entity names (people, companies) from text and create/update their brain stub pages. Stubs from untrusted input land in the quarantine lane (frontmatter `provenance: auto-extracted` + `status: unverified`) — excluded from authoritative retrieval boosts until reviewed. Direct authoritative writes require the trusted local CLI AND --trusted-extraction.',
  params: {
    text: { type: 'string', required: true, description: 'The text to extract entities from (email, transcript, pasted content, …). Max 200k characters — split larger inputs.' },
    source_slug: { type: 'string', required: true, description: 'Slug of the source page the text came from (used for backlinks + timeline attribution).' },
    trusted_extraction: { type: 'boolean', required: false, description: 'Local CLI only: write stubs directly as authoritative pages, skipping the quarantine lane. Ignored (always quarantined) for remote callers.' },
  },
  mutating: true,
  scope: 'write',
  handler: async (ctx, p) => {
    // Trust rule (#160, fail-closed like the CV6 provenance gate above):
    // `ctx.remote === false` is the ONLY truthy condition that can admit a
    // direct authoritative write, and even then the caller must opt in
    // explicitly. Remote/unset trust → quarantine lane, flag ignored.
    const trusted = ctx.remote === false && p.trusted_extraction === true;
    const text = p.text as string;
    // Resource guards: the greedy name regex on a huge paste can yield tens
    // of thousands of "entities", each costing several DB round-trips. Cap
    // input size loudly and entity count softly (surfaced as `truncated`).
    if (text.length > MAX_EXTRACT_TEXT_CHARS) {
      throw new OperationError(
        'invalid_params',
        `extract_entities: text is ${text.length} chars (max ${MAX_EXTRACT_TEXT_CHARS}).`,
        'Split the input and call extract_entities per section.',
      );
    }
    if (ctx.dryRun) return { dry_run: true, action: 'extract_entities', trusted };
    const { extractEntities, enrichEntities } = await import('./enrichment-service.ts');
    const found = extractEntities(text);
    const capped = found.slice(0, MAX_EXTRACT_ENTITIES);
    const results = await enrichEntities(
      ctx.engine,
      capped.map((e) => ({ entityName: e.name, entityType: e.type, context: e.context, sourceSlug: p.source_slug as string })),
      {
        trusted,
        ...(ctx.sourceId ? { sourceId: ctx.sourceId } : {}),
        // Pure local DB writes — no external API call to pace, so the
        // system-load capacity gate would only stall the caller.
        throttle: false,
      },
    );
    return {
      status: 'ok',
      trusted,
      quarantined: results.filter((r) => r.quarantined === true).length,
      count: results.length,
      entities_found: found.length,
      truncated: found.length > capped.length,
      entities: results,
    };
  },
  cliHints: { name: 'extract-entities' },
};

const extraction_pending: Operation = {
  name: 'extraction_pending',
  description: 'List unverified auto-extracted entity stubs awaiting owner review (the quarantine lane from extract_entities). Promote or reject them with extraction_review.',
  params: {
    limit: { type: 'number', required: false, description: 'Max rows (default 100, cap 500).' },
    offset: { type: 'number', required: false, description: 'Pagination offset.' },
  },
  scope: 'read',
  handler: async (ctx, p) => {
    const limit = Math.min(Math.max(Number(p.limit ?? 100) || 100, 1), 500);
    const offset = Math.max(Number(p.offset ?? 0) || 0, 0);
    // Read-side source isolation: route through sourceScopeOpts (federated
    // array > scalar > nothing), applied in SQL below.
    const scope = sourceScopeOpts(ctx);
    const params: unknown[] = [];
    let srcClause = '';
    if (scope.sourceIds && scope.sourceIds.length > 0) {
      params.push(scope.sourceIds);
      srcClause = `AND p.source_id = ANY($${params.length}::text[])`;
    } else if (scope.sourceId) {
      params.push(scope.sourceId);
      srcClause = `AND p.source_id = $${params.length}`;
    }
    params.push(limit, offset);
    const rows = await ctx.engine.executeRaw<{
      slug: string; title: string; type: string; source_id: string;
      extracted_from: string | null; created_at: string;
    }>(
      `SELECT p.slug, p.title, p.type, p.source_id,
              p.frontmatter ->> 'source' AS extracted_from,
              p.created_at::text AS created_at
       FROM pages p
       JOIN sources s ON s.id = p.source_id
       WHERE ${unverifiedExtractionFragment('p')}
         ${buildVisibilityClause('p', 's')}
         ${srcClause}
       ORDER BY p.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return { count: rows.length, pending: rows };
  },
  cliHints: { name: 'extraction-pending' },
};

const extraction_review: Operation = {
  name: 'extraction_review',
  description: 'Promote or reject unverified auto-extracted entity stubs (batch). Promote flips `status` to verified (provenance kept for audit); reject soft-deletes the stub. Owner-only: this op is refused for any non-local caller. (The markers are ordinary frontmatter — the boundary against rewriting them wholesale is put_page write authz, same as for any page.)',
  params: {
    action: { type: 'string', required: true, description: "'promote' or 'reject'." },
    slugs: { type: 'array', required: true, items: { type: 'string' }, description: 'Stub slugs to act on (batch).' },
  },
  mutating: true,
  scope: 'write',
  localOnly: true,
  handler: async (ctx, p) => {
    // The review decision IS the trust gate — if a remote caller could
    // promote, injected content could self-promote and the quarantine lane
    // would be decorative. Fail-closed: only strictly-local callers pass.
    if (ctx.remote !== false) {
      throw new OperationError(
        'permission_denied',
        'extraction_review is owner-only: promote/reject decisions must come from the trusted local CLI.',
        'Run `gbrain extraction-review <promote|reject> --slugs ...` on the host machine.',
      );
    }
    const action = p.action as string;
    if (action !== 'promote' && action !== 'reject') {
      throw new OperationError('invalid_params', `extraction_review: action must be 'promote' or 'reject'; got '${action}'.`);
    }
    // CLI passes `--slugs a,b,c` as one string; MCP passes a real array.
    const slugs = Array.isArray(p.slugs)
      ? (p.slugs as string[])
      : typeof p.slugs === 'string'
        ? p.slugs.split(',').map((s) => s.trim()).filter(Boolean)
        : [];
    if (slugs.length === 0) {
      throw new OperationError('invalid_params', 'extraction_review: slugs must be a non-empty array (CLI: --slugs slug1,slug2).');
    }
    if (ctx.dryRun) return { dry_run: true, action: `extraction_review:${action}`, slugs };
    const results: Array<{ slug: string; status: string }> = [];
    for (const slug of slugs) {
      const page = await ctx.engine.getPage(slug, ctx.sourceId ? { sourceId: ctx.sourceId } : undefined);
      if (!page) {
        results.push({ slug, status: 'not_found' });
        continue;
      }
      if (!isUnverifiedExtraction(page.frontmatter)) {
        results.push({ slug, status: 'not_unverified' });
        continue;
      }
      if (action === 'promote') {
        // Frontmatter-only flip via a targeted JSONB merge — NOT putPage,
        // whose upsert would reset non-carried columns (page_kind →
        // 'markdown', content_hash, …) for a change that only touches one
        // frontmatter key. provenance stays 'auto-extracted' as the audit
        // trail of HOW the page came to exist; status → 'verified' records
        // the owner's call. jsonb_build_object binds as text (no
        // JSON.stringify-into-::jsonb hazard); identical on both engines.
        await ctx.engine.executeRaw(
          `UPDATE pages
           SET frontmatter = COALESCE(frontmatter, '{}'::jsonb) || jsonb_build_object($1::text, $2::text),
               updated_at = now()
           WHERE slug = $3 AND source_id = $4`,
          [EXTRACTION_STATUS_KEY, STATUS_VERIFIED, slug, page.source_id],
        );
        results.push({ slug, status: 'promoted' });
      } else {
        await ctx.engine.softDeletePage(slug, { sourceId: page.source_id });
        results.push({ slug, status: 'rejected' });
      }
    }
    return { status: 'ok', action, results };
  },
  cliHints: { name: 'extraction-review', positional: ['action'] },
};

// --- WP4 (T9): request_tools — discovery + pull-based per-client unlock ---

/**
 * D14.5: per-client rate limit on the persist branch (~5 surface persists /
 * hour / client). Module-level token bucket (bounded LRU — attacker-chosen
 * client ids can't grow memory); `let` + reset seam so tests don't leak
 * bucket state across files.
 */
let requestToolsPersistLimiter = new RateLimiter({ limit: 5, windowMs: 3_600_000, lruCap: 5_000 });

/** Test seam: fresh persist-rate-limit buckets. */
export function __resetRequestToolsPersistLimiterForTests(): void {
  requestToolsPersistLimiter = new RateLimiter({ limit: 5, windowMs: 3_600_000, lruCap: 5_000 });
}

/**
 * One-line catalog summary: the first sentence of an op description,
 * capped. Non-contractual rendering — full schemas come from the
 * `{tools: [...]}` branch.
 */
function firstSentenceOf(description: string): string {
  const t = description.trim();
  const m = t.match(/^.*?[.!?](?=\s|$)/);
  const s = (m ? m[0] : t).trim();
  return s.length > 160 ? `${s.slice(0, 157)}...` : s;
}

/**
 * The set of ops VISIBLE to this caller (never leak hidden names — C8/
 * amendment 11 class): bounded by the server ceiling (ops above it can
 * never be served, so naming them would recreate listed-but-denied at the
 * persist level), minus localOnly on network transports (stdio and the
 * trusted local CLI keep them — D7), minus ops outside the caller's scopes
 * (agent-callable carve-out per FOV-4), minus bound-client-fenced ops (same
 * predicate as tools/list, ENG-3), minus publish-gated ops whose gate is off
 * (stdio and the trusted local CLI bypass gates — the D7 local-surface
 * posture, matching assertPublishEnabled's remote===false exemption; a
 * failed gate read hides the gated ops, fail-closed).
 */
async function visibleOpsForCaller(
  ctx: OperationContext,
  ceiling: 'verbs' | 'starter' | 'full',
): Promise<Operation[]> {
  const { filterOpsForSurface } = await import('../mcp/surface.ts');
  // Trusted local callers: the stdio pipe, or the local CLI (remote is
  // strictly false — the fail-closed trust marker). Both CAN call localOnly
  // and gated ops, so hiding them would make the catalog dishonest.
  const isLocal = ctx.transport === 'stdio' || ctx.remote === false;

  let gateDisabled: ReadonlySet<string> = new Set();
  if (!isLocal) {
    try {
      const { disabledOpsForPublishGates } = await import('../mcp/publish-gates.ts');
      gateDisabled = await disabledOpsForPublishGates(ctx.engine, ctx.config);
    } catch {
      // Fail-closed: if the resolver can't even load, hide every gated op.
      gateDisabled = new Set(operations.filter(o => o.publishGateKey).map(o => o.name));
    }
  }

  // Auth-less transports (stdio) and grandfathered legacy bearer tokens
  // (empty scopes array — that transport does no call-time scope checks
  // either) skip scope filtering: for them the whole surface IS callable,
  // so hiding by scope would make the catalog LESS honest, not more.
  const scopes = ctx.auth?.scopes && ctx.auth.scopes.length > 0 ? ctx.auth.scopes : null;

  return filterOpsForSurface(operations, ceiling).filter(op =>
    (isLocal || !op.localOnly)
    && (scopes === null
      || hasScope(scopes, op.scope ?? 'read')
      || (op.agentCallable === true && hasScope(scopes, 'agent')))
    && opAllowedForBoundClient(ctx.auth, op)
    && !gateDisabled.has(op.name),
  );
}

const request_tools: Operation = {
  name: 'request_tools',
  description:
    'Discover this brain\'s tool catalog and optionally unlock a wider tool surface for your client. ' +
    'No arguments → the catalog visible to YOUR credentials, grouped by area (tool names + one-line summaries). ' +
    '{tools: ["name", ...]} → full read-only schemas for the visible subset of those names (unknown/hidden names are silently omitted). ' +
    '{surface: "verbs"|"starter"|"full"} → persist that tool surface for this client (bounded by the server ceiling; denied when an operator pinned the surface; ~5 changes/hour), then re-issue tools/list to see the new catalog.',
  area: 'discovery',
  // FOV-4: callable by read OR agent scope — discovery for every token class.
  agentCallable: true,
  params: {
    tools: {
      type: 'array',
      items: { type: 'string', description: 'A tool name from the catalog.' },
      description: 'Fetch full read-only tool schemas for these names. Names outside your visible surface are silently omitted (D5).',
    },
    surface: {
      type: 'string',
      enum: ['verbs', 'starter', 'full'],
      description: 'Persist this tool surface for your client. Must not exceed the server ceiling; ignored surfaces stay available via no-arg discovery. Takes effect on your next tools/list.',
    },
  },
  scope: 'read',
  // D9: mutating because the persist branch writes oauth_clients.surface.
  // The bound-client fence exempts it via BOUND_CLIENT_META_OPS (see the
  // carve-out comment at opAllowedForBoundClient); the persist branch
  // self-enforces ceiling + operator lock + scopes + rate limit.
  mutating: true,
  handler: async (ctx, p) => {
    const { surfaceWiderThan, isMcpSurface } = await import('../mcp/surface.ts');
    // Unset ceiling (local CLI / direct dispatch) = 'full' — trusted-local
    // callers were never surface-bounded.
    const ceiling = ctx.surfaceCeiling ?? 'full';

    // D5: the three branches are mutually exclusive. {surface, tools}
    // together is ambiguous (persist vs descriptor fetch) — reject loudly
    // rather than silently persisting and ignoring the tools list.
    if (p.surface !== undefined && p.tools !== undefined) {
      throw new OperationError(
        'invalid_params',
        'pass either {surface} (persist) or {tools} (descriptor fetch), not both.',
      );
    }

    // ── persist branch (D5: accepts ONLY {surface}) ─────────────────────
    if (p.surface !== undefined) {
      const requested = p.surface as string;
      if (!isMcpSurface(requested)) {
        // Backstop for direct handler calls — MCP dispatch already rejects
        // via the enum in validateParams (invalid_params naming the valid set).
        throw new OperationError('invalid_params', `surface must be one of: verbs, starter, full (got an unrecognized value)`);
      }
      const clientId = ctx.auth?.clientId;
      if (!clientId) {
        // stdio has no per-token identity; a surface persist has nowhere to land.
        return { persisted: false, reason: 'no per-client surface on this transport; use --surface' };
      }
      if (surfaceWiderThan(requested, ceiling)) {
        const e = new OperationError(
          'permission_denied',
          `surface '${requested}' is above this server's ceiling '${ceiling}' (D2: per-client surfaces narrow, never widen).`,
          `The operator caps this transport at --surface ${ceiling}; widening requires a server restart with a wider --surface.`,
        );
        e.detail = `ceiling=${ceiling}`; // amendment 4 key=value denial grammar; ENG-11 assign-after
        throw e;
      }
      let rows: Record<string, unknown>[];
      try {
        rows = await ctx.engine.executeRaw(
          `SELECT surface, surface_set_by FROM oauth_clients WHERE client_id = $1`,
          [clientId],
        );
      } catch (err) {
        if (isUndefinedColumnError(err, 'surface') || isUndefinedColumnError(err, 'surface_set_by')) {
          // D5: a capability-negotiation op never returns internal_error for
          // a pre-migration brain — report the gap and keep serving.
          return { persisted: false, reason: 'migration pending' };
        }
        throw err;
      }
      if (rows.length === 0) {
        // Legacy bearer tokens carry a clientId that is not an oauth_clients row.
        return { persisted: false, reason: 'no per-client surface on this transport; use --surface' };
      }
      const current = rows[0] as { surface?: string | null; surface_set_by?: string | null };
      const operatorLocked = () => {
        const e = new OperationError(
          'permission_denied',
          "this client's surface is operator-pinned and cannot be self-changed (amendment 19).",
          `Ask the brain operator to change it: gbrain auth rescope-client ${clientId} --surface ${requested}`,
        );
        e.detail = 'locked_by=operator';
        return e;
      };
      if (current.surface_set_by === 'operator') throw operatorLocked();
      // A dry-run preview exercises every denial above but must not consume
      // the persist budget — the limiter meters actual writes only.
      if (ctx.dryRun) {
        return { persisted: false, dry_run: true, surface: requested, reason: 'dry_run' };
      }
      const rl = requestToolsPersistLimiter.check(clientId);
      if (!rl.allowed) {
        throw new OperationError(
          'rate_limited',
          'surface persistence is rate-limited to ~5 changes per hour per client (D14.5).',
          `Retry after ~${rl.retryAfter ?? 60}s.`,
        );
      }
      // Atomic re-check: a concurrent operator pin between the SELECT and
      // this UPDATE must still win.
      const updated = await ctx.engine.executeRaw(
        `UPDATE oauth_clients SET surface = $1, surface_set_by = 'self'
         WHERE client_id = $2 AND (surface_set_by IS DISTINCT FROM 'operator')
         RETURNING client_id`,
        [requested, clientId],
      );
      if (updated.length === 0) {
        // Concurrent operator pin won the race: the denial must not consume
        // the client's persist budget (the limiter meters actual writes).
        requestToolsPersistLimiter.refund(clientId);
        throw operatorLocked();
      }
      await writeSurfaceChangeAudit(ctx.engine, {
        actor: clientId,
        client_id: clientId,
        old: (current.surface as string | null) ?? null,
        new: requested,
        via: 'request_tools',
      });
      return { persisted: true, surface: requested, note: 're-issue tools/list to see the new catalog' };
    }

    const visible = await visibleOpsForCaller(ctx, ceiling);

    // ── descriptor branch (D5: read-only) ───────────────────────────────
    if (p.tools !== undefined) {
      const requested = (p.tools as unknown[]).filter((t): t is string => typeof t === 'string');
      const byName = new Map(visible.map(o => [o.name, o]));
      const picked: Operation[] = [];
      const seen = new Set<string>();
      for (const name of requested) {
        if (seen.has(name)) continue;
        seen.add(name);
        const op = byName.get(name);
        if (op) picked.push(op); // invisible names silently omitted (D5)
      }
      const { buildToolDefs } = await import('../mcp/tool-defs.ts');
      const { resolveStrictParamsMode } = await import('../mcp/validate-params.ts');
      const strictParams = (await resolveStrictParamsMode(ctx.engine, ctx.config)) === 'reject';
      return { tools: buildToolDefs(picked, { strictParams }) };
    }

    // ── catalog branch (no args) ────────────────────────────────────────
    const groups = new Map<string, Array<{ name: string; one_line: string }>>();
    for (const op of visible) {
      // Area names are non-contractual grouping labels (amendment 22).
      const area = op.area ?? 'other';
      const bucket = groups.get(area) ?? [];
      bucket.push({ name: op.name, one_line: firstSentenceOf(op.description) });
      groups.set(area, bucket);
    }
    const catalog = [...groups.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([area, tools]) => ({ area, tools }));
    return {
      catalog,
      total_tools: visible.length,
      note: 'Call request_tools {tools: ["name", ...]} for full schemas, or {surface: "starter"|"full"} to persist a wider tool surface (within the server ceiling), then re-issue tools/list.',
    };
  },
};

export const operations: Operation[] = [
  // MEMORY_VERBS v1 (Cathedral 1) — remember/entity/synthesize/forget live in
  // verbs.ts; the remaining three of the seven verbs (the extended `recall`,
  // plus the v0.45.x boundary verbs `context_pack`/`delta`) are defined below.
  // Spread first so `--surface verbs` agents see them at the top of the list.
  ...verbOperations,
  // Page CRUD (get_page, put_page, delete_page, list_pages + the v0.26.5
  // destructive-guard ops restore_page, purge_deleted_pages) — ops/pages.ts
  ...pagesOperations,
  // Search (search, query) — ops/search.ts
  ...searchOperations,
  // v0.36 Phase 2: image-as-query
  search_by_image,
  // Tags (add_tag, remove_tag, get_tags) — ops/tags.ts
  ...tagsOperations,
  // Links (add_link, remove_link, get_links, get_backlinks,
  // list_link_sources, traverse_graph) — ops/links.ts
  ...linksOperations,
  // Timeline (add_timeline_entry, get_timeline) — ops/timeline.ts
  ...timelineOperations,
  // Admin (get_stats, get_health, run_doctor, get_versions, revert_version
  // + the v0.31.1 banner packet get_brain_identity) — ops/admin.ts
  ...adminOperations,
  // PR1: skill catalog over MCP (list_skills, get_skill, list_brain_skillpack,
  // advisor) + v0.41.19.0 get_status_snapshot — ops/skills-catalog.ts
  ...skillsCatalogOperations,
  // Sync (sync_brain) — ops/sync-status.ts
  ...syncStatusOperations,
  // Raw data (put_raw_data, get_raw_data) — ops/raw-data.ts
  ...rawDataOperations,
  // Resolution & chunks (resolve_slugs, get_chunks) — ops/chunks.ts
  ...chunksOperations,
  // Ingest log (log_ingest, get_ingest_log) — ops/ingest-log.ts
  ...ingestLogOperations,
  // Files (file_list, file_upload, file_url) — ops/files.ts
  ...filesOperations,
  // Jobs (Minions: submit_job, get_job, list_jobs, cancel_job, retry_job,
  // get_job_progress, pause_job, resume_job, replay_job, send_job_message)
  // + v0.38 Slice 3 agent lane (submit_agent, get_agent_job) — ops/jobs.ts
  ...jobsOperations,
  // Orphans (find_orphans) — ops/orphans.ts
  ...orphansOperations,
  // v0.36.1.0 (T7) — Hindsight calibration wave (get_calibration_profile) —
  // ops/calibration.ts
  ...calibrationOperations,
  // v0.28: Takes + think (takes_list, takes_search, think) + v0.30
  // calibration aggregates (takes_scorecard, takes_calibration) — ops/takes.ts
  ...takesOperations,
  // v0.28: whoami + scoped sources management
  whoami, sources_add, sources_list, sources_remove, sources_status,
  // WP4 (T9): discovery + pull-based per-client surface unlock (D4/D5/D9)
  request_tools,
  // v0.29: Salience + anomalies (get_recent_salience, find_anomalies —
  // ops/salience.ts) + recent transcripts
  ...salienceOperations, get_recent_transcripts,
  // v0.42.x (#2390): Life Chronicle timeline reads
  chronicle_day, chronicle_on_this_day, chronicle_since, chronicle_last_seen,
  ontology_get, ontology_propose, ontology_dimensions, ontology_conflicts,
  volunteer_chronicle, chronicle_backfill,
  // v0.43 (#2095): push-based context
  volunteer_context,
  // Extraction quarantine lane (#160): gated entity extraction + review queue
  extract_entities, extraction_pending, extraction_review,
  // v0.31: hot memory (facts table)
  extract_facts, recall, context_pack, delta, forget_fact,
  // v0.32.6: contradiction probe MCP surface (M3)
  find_contradictions,
  // v0.33: expertise + relationship-proximity routing
  find_experts,
  // v0.35.4: temporal trajectory (typed claims over time + regression detection)
  find_trajectory,
  // v0.33.3: Cathedral III code-intelligence (MCP-exposed; were CLI_ONLY pre-v0.33.3)
  code_callers, code_callees, code_def, code_refs,
  // v0.34 W3: recursive code_blast + code_flow
  code_blast, code_flow,
  // v0.34 W3b: code_traversal_cache admin clear op
  code_traversal_cache_clear,
  // #3390: provider-agnostic embedding migration (local-only admin)
  migrate_embeddings,
  // v0.40.6.0 Schema Cathedral v3: 9 new ops — 7 read + 2 admin (NOT
  // localOnly per D2 so remote agents (your OpenClaw, etc.) can author packs).
  // schema_apply_mutations is batched per D10 — one MCP tool, N
  // mutations applied atomically inside one withPackLock scope.
  get_active_schema_pack, list_schema_packs,
  schema_stats, schema_lint, schema_graph, schema_explain_type,
  schema_review_orphans,
  schema_apply_mutations, reload_schema_pack,
  // v0.41.18.0 (T16, A7, codex #5)
  run_onboard,
  // v0.41.20.0 SkillOpt — admin-scoped MCP op for remote optimization.
  // Per-skill allowlist via `skillopt.allowed_skills` config (default
  // deny-all for remote callers). NOT localOnly so admin OAuth clients
  // can submit; CLI bypass via ctx.remote === false.
  run_skillopt,
];

// ---------------------------------------------------------------------------
// WP4 (amendment 22) — area taxonomy.
//
// One central map (single reviewable block) rather than 100+ scattered inline
// fields. Area NAMES ARE NON-CONTRACTUAL: they group the request_tools
// catalog and the generated tool-catalog doc; renaming or regrouping is never
// a breaking change. Every non-localOnly op MUST have an area — enforced by
// the CI walker in test/mcp-tool-defs.test.ts, so a future op missing from
// this map fails at PR time. localOnly ops are covered too (harmless; the
// walker only requires non-localOnly). Ops that declare `area` inline
// (request_tools) win over this map.
// ---------------------------------------------------------------------------
const OP_AREAS: Record<string, string> = {
  // memory verbs (the frozen protocol facade)
  recall: 'memory-verbs', remember: 'memory-verbs', entity: 'memory-verbs',
  synthesize: 'memory-verbs', forget: 'memory-verbs',
  context_pack: 'memory-verbs', delta: 'memory-verbs',
  // pages (CRUD, versions, raw payloads, resolution)
  get_page: 'pages', put_page: 'pages', delete_page: 'pages', list_pages: 'pages',
  restore_page: 'pages', purge_deleted_pages: 'pages',
  get_versions: 'pages', revert_version: 'pages',
  resolve_slugs: 'pages', get_chunks: 'pages',
  put_raw_data: 'pages', get_raw_data: 'pages',
  // search
  search: 'search', query: 'search', search_by_image: 'search',
  // tags
  add_tag: 'tags', remove_tag: 'tags', get_tags: 'tags',
  // links + graph
  add_link: 'links', remove_link: 'links', get_links: 'links',
  get_backlinks: 'links', list_link_sources: 'links', traverse_graph: 'links',
  find_orphans: 'links',
  // timeline
  add_timeline_entry: 'timeline', get_timeline: 'timeline',
  // life chronicle
  chronicle_day: 'chronicle', chronicle_on_this_day: 'chronicle',
  chronicle_since: 'chronicle', chronicle_last_seen: 'chronicle',
  volunteer_chronicle: 'chronicle', chronicle_backfill: 'chronicle',
  // ontology
  ontology_get: 'ontology', ontology_propose: 'ontology',
  ontology_dimensions: 'ontology', ontology_conflicts: 'ontology',
  // admin + operations
  get_stats: 'admin', get_health: 'admin', run_doctor: 'admin',
  get_status_snapshot: 'admin', run_onboard: 'admin', run_skillopt: 'admin',
  migrate_embeddings: 'admin', code_traversal_cache_clear: 'admin',
  // identity
  whoami: 'identity', get_brain_identity: 'identity',
  // skills
  list_skills: 'skills', get_skill: 'skills', list_brain_skillpack: 'skills',
  // advisor
  advisor: 'advisor',
  // sources
  sources_add: 'sources', sources_list: 'sources', sources_remove: 'sources',
  sources_status: 'sources',
  // sync (localOnly)
  sync_brain: 'sync',
  // ingest log
  log_ingest: 'ingest', get_ingest_log: 'ingest',
  // files (localOnly)
  file_list: 'files', file_upload: 'files', file_url: 'files',
  // jobs (Minions + agent lane)
  submit_job: 'jobs', get_job: 'jobs', list_jobs: 'jobs', cancel_job: 'jobs',
  retry_job: 'jobs', get_job_progress: 'jobs', pause_job: 'jobs',
  resume_job: 'jobs', replay_job: 'jobs', send_job_message: 'jobs',
  submit_agent: 'jobs', get_agent_job: 'jobs',
  // takes + think
  takes_list: 'takes', takes_search: 'takes', think: 'takes',
  takes_scorecard: 'takes', takes_calibration: 'takes',
  // hot memory (facts)
  extract_facts: 'memory', forget_fact: 'memory',
  // entity extraction lane
  extract_entities: 'entities', extraction_pending: 'entities',
  extraction_review: 'entities',
  // insight / signal reads
  get_recent_salience: 'insights', find_anomalies: 'insights',
  find_contradictions: 'insights', find_experts: 'insights',
  find_trajectory: 'insights', get_calibration_profile: 'insights',
  volunteer_context: 'insights', get_recent_transcripts: 'insights',
  // code intelligence
  code_callers: 'code', code_callees: 'code', code_def: 'code',
  code_refs: 'code', code_blast: 'code', code_flow: 'code',
  // schema packs
  get_active_schema_pack: 'schema', list_schema_packs: 'schema',
  schema_stats: 'schema', schema_lint: 'schema', schema_graph: 'schema',
  schema_explain_type: 'schema', schema_review_orphans: 'schema',
  schema_apply_mutations: 'schema', reload_schema_pack: 'schema',
  // discovery
  request_tools: 'discovery',
};
for (const op of operations) {
  if (op.area === undefined && OP_AREAS[op.name] !== undefined) {
    op.area = OP_AREAS[op.name];
  }
}

export const operationsByName = Object.fromEntries(
  operations.map(op => [op.name, op]),
) as Record<string, Operation>;
