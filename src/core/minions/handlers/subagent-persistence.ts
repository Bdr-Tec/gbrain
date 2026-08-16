/**
 * Subagent transcript + tool-execution persistence (peeled from subagent.ts).
 *
 * One module owns every read/write of `subagent_messages` and
 * `subagent_tool_executions` used by the subagent handler's loops and the
 * crash-replay reconciliation. JSONB discipline throughout: values are
 * pre-serialized to a JSON string and bound through `$N::text::jsonb` — never
 * JSON.stringify into a bare `::jsonb` cast (#2339 class; PGLite hides it).
 */

import type { BrainEngine } from '../../engine.ts';
import type { ContentBlock, SubagentResult } from '../types.ts';
import { UnrecoverableError } from '../types.ts';

export interface PersistedMessage {
  message_idx: number;
  role: 'user' | 'assistant';
  content_blocks: ContentBlock[];
  tokens_in: number | null;
  tokens_out: number | null;
  tokens_cache_read: number | null;
  tokens_cache_create: number | null;
  model: string | null;
}

export interface PersistedToolExec {
  message_idx: number;
  tool_use_id: string;
  tool_name: string;
  input: unknown;
  status: 'pending' | 'complete' | 'failed';
  output: unknown;
  error: string | null;
}

export interface PriorToolV2Row {
  stableKey: string;
  status: 'pending' | 'complete' | 'failed';
  output: unknown;
  error: string | null;
}

/**
 * Load prior tool executions keyed by a stable key.
 *
 *   - v2 rows: gbrain_tool_use_id is the stable key (set at first observation
 *     by onToolCallStart).
 *   - v1 legacy rows: D5 shim synthesizes a stable key from
 *     (job_id, message_idx, ordinal-position-by-array-index, tool_name).
 *
 * Both forms resolve to the same Map<stableKey, outcome> the gateway loop
 * consults during replay.
 */
export async function loadPriorToolsV2(engine: BrainEngine, jobId: number): Promise<PriorToolV2Row[]> {
  const rows = await engine.executeRaw<Record<string, unknown>>(
    `SELECT message_idx, tool_use_id, tool_name, ordinal, gbrain_tool_use_id::text AS gbrain_tool_use_id,
            status, output, error
       FROM subagent_tool_executions
      WHERE job_id = $1
      ORDER BY message_idx, COALESCE(ordinal, 0), id`,
    [jobId],
  );
  return rows.map(r => {
    const gbrainId = r.gbrain_tool_use_id as string | null;
    const stableKey = gbrainId
      ? gbrainId
      // D5 legacy shim: derive a stable key from (job, msg_idx, tool_name, tool_use_id).
      // Pre-v81 rows don't have ordinal; the provider tool_use_id is stable
      // within a single Anthropic turn so it's safe as a fallback hash input.
      : `legacy:${jobId}:${r.message_idx}:${r.tool_use_id}:${r.tool_name}`;
    return {
      stableKey,
      status: r.status as 'pending' | 'complete' | 'failed',
      output: r.output,
      error: (r.error as string | null) ?? null,
    };
  });
}

export async function loadPriorMessages(engine: BrainEngine, jobId: number): Promise<PersistedMessage[]> {
  const rows = await engine.executeRaw<Record<string, unknown>>(
    `SELECT message_idx, role, content_blocks, tokens_in, tokens_out,
            tokens_cache_read, tokens_cache_create, model
       FROM subagent_messages
      WHERE job_id = $1
      ORDER BY message_idx ASC`,
    [jobId],
  );
  return rows.map(r => ({
    message_idx: r.message_idx as number,
    role: r.role as 'user' | 'assistant',
    content_blocks: (typeof r.content_blocks === 'string'
      ? JSON.parse(r.content_blocks as string)
      : r.content_blocks) as ContentBlock[],
    tokens_in: (r.tokens_in as number) ?? null,
    tokens_out: (r.tokens_out as number) ?? null,
    tokens_cache_read: (r.tokens_cache_read as number) ?? null,
    tokens_cache_create: (r.tokens_cache_create as number) ?? null,
    model: (r.model as string) ?? null,
  }));
}

export async function loadPriorTools(engine: BrainEngine, jobId: number): Promise<PersistedToolExec[]> {
  const rows = await engine.executeRaw<Record<string, unknown>>(
    `SELECT message_idx, tool_use_id, tool_name, input, status, output, error
       FROM subagent_tool_executions
      WHERE job_id = $1
      ORDER BY message_idx, COALESCE(ordinal, 0), id`,
    [jobId],
  );
  return rows.map(r => ({
    message_idx: r.message_idx as number,
    tool_use_id: r.tool_use_id as string,
    tool_name: r.tool_name as string,
    input: typeof r.input === 'string' ? JSON.parse(r.input) : r.input,
    status: r.status as 'pending' | 'complete' | 'failed',
    output: r.output == null
      ? null
      : (typeof r.output === 'string' ? JSON.parse(r.output) : r.output),
    error: (r.error as string) ?? null,
  }));
}

export async function persistMessage(engine: BrainEngine, jobId: number, msg: PersistedMessage): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO subagent_messages (job_id, message_idx, role, content_blocks,
        tokens_in, tokens_out, tokens_cache_read, tokens_cache_create, model)
     VALUES ($1, $2, $3, $4::text::jsonb, $5, $6, $7, $8, $9)
     ON CONFLICT (job_id, message_idx) DO NOTHING`,
    [
      jobId,
      msg.message_idx,
      msg.role,
      JSON.stringify(msg.content_blocks),
      msg.tokens_in,
      msg.tokens_out,
      msg.tokens_cache_read,
      msg.tokens_cache_create,
      msg.model,
    ],
  );
}

export async function persistToolExecPending(
  engine: BrainEngine,
  jobId: number,
  messageIdx: number,
  toolUseId: string,
  toolName: string,
  input: unknown,
): Promise<void> {
  // Serialize to a JSON string, then bind through $5::text::jsonb. The value is
  // ALWAYS a string here (pre-serialized input, or JSON.stringify) — binding a
  // string to a bare $5::jsonb double-encodes it into a jsonb scalar string under
  // postgres.js .unsafe() (#2339 class; PGLite hides it). The ::text cast makes
  // the text→jsonb parse produce a real jsonb object.
  const jsonStr = typeof input === 'string' ? input : JSON.stringify(input);
  await engine.executeRaw(
    `INSERT INTO subagent_tool_executions (job_id, message_idx, tool_use_id, tool_name, input, status)
     VALUES ($1, $2, $3, $4, $5::text::jsonb, 'pending')
     ON CONFLICT (job_id, tool_use_id) DO NOTHING`,
    [jobId, messageIdx, toolUseId, toolName, jsonStr],
  );
}

export async function persistToolExecComplete(
  engine: BrainEngine,
  jobId: number,
  toolUseId: string,
  output: unknown,
): Promise<void> {
  await engine.executeRaw(
    `UPDATE subagent_tool_executions
        SET status = 'complete', output = $3::text::jsonb, ended_at = now()
      WHERE job_id = $1 AND tool_use_id = $2`,
    [jobId, toolUseId, typeof output === 'string' ? output : JSON.stringify(output)],
  );
}

/**
 * #4217 — structural write accounting. A subagent job's status used to reflect
 * only "the agent turn finished"; 22 consecutive jobs once reported
 * `completed` while every put_page failed (embedding-dimension mismatch) and
 * the dream cycle silently produced nothing for 9 hours.
 *
 * Counts are derived from the job's own tool-execution ledger and merged into
 * the result for EVERY subagent job. Predicate discipline (OV-2): `attempted`
 * counts settled rows only — complete + failed; pending rows (crash-orphaned
 * dispatches that never settled) count toward NEITHER side.
 *
 * When the submitter set `require_writes` (dream synthesize / patterns
 * fan-out — jobs whose entire purpose is writing pages), attempted > 0 with
 * zero successes throws UnrecoverableError: retrying is provably futile (the
 * replay path short-circuits to the persisted terminal turn and can never
 * re-run the failed tools), so the job routes straight to dead and the
 * idempotency key releases for the next cycle.
 *
 * `scopeToolUseIdPrefix` narrows the ledger scan (the oneshot runner scopes to
 * its own invocation's rows so a prior invocation's outcome can't distort the
 * verdict); agentic jobs scan job-wide.
 */
export async function finalizeWriteAccounting(
  engine: BrainEngine,
  jobId: number,
  result: SubagentResult,
  opts: { requireWrites: boolean; scopeToolUseIdPrefix?: string },
): Promise<SubagentResult> {
  let rows: Array<{ status: string; error: string | null }>;
  try {
    rows = await engine.executeRaw<{ status: string; error: string | null }>(
      opts.scopeToolUseIdPrefix
        ? `SELECT status, error FROM subagent_tool_executions
            WHERE job_id = $1 AND tool_name = 'brain_put_page' AND tool_use_id LIKE $2`
        : `SELECT status, error FROM subagent_tool_executions
            WHERE job_id = $1 AND tool_name = 'brain_put_page'`,
      opts.scopeToolUseIdPrefix ? [jobId, `${opts.scopeToolUseIdPrefix}%`] : [jobId],
    );
  } catch (e) {
    // Accounting must never turn a finished job into a crash on a transient
    // read error — surface zeroed counts and keep the handler result.
    process.stderr.write(`[subagent] write accounting read failed for job ${jobId}: ${e instanceof Error ? e.message : String(e)}\n`);
    return result;
  }
  const written = rows.filter(r => r.status === 'complete').length;
  const failed = rows.filter(r => r.status === 'failed').length;
  const attempted = written + failed;
  const accounted: SubagentResult = {
    ...result,
    pages_attempted: attempted,
    pages_written: written,
    pages_failed: failed,
  };
  if (opts.requireWrites && attempted > 0 && written === 0) {
    const firstError = rows.find(r => r.status === 'failed' && r.error)?.error ?? 'unknown write error';
    throw new UnrecoverableError(
      `all ${failed} put_page write(s) failed — job produced zero pages (first error: ${firstError})`,
    );
  }
  return accounted;
}

export async function persistToolExecFailed(
  engine: BrainEngine,
  jobId: number,
  messageIdx: number,
  toolUseId: string,
  toolName: string,
  input: unknown,
  error: string,
): Promise<void> {
  // INSERT-or-UPDATE to failed — covers both "no pending row yet" (tool
  // rejected upfront) and "pending row exists" (tool threw mid-execute).
  await engine.executeRaw(
    `INSERT INTO subagent_tool_executions (job_id, message_idx, tool_use_id, tool_name, input, status, error, ended_at)
     VALUES ($1, $2, $3, $4, $5::text::jsonb, 'failed', $6, now())
     ON CONFLICT (job_id, tool_use_id) DO UPDATE
       SET status = 'failed', error = EXCLUDED.error, ended_at = now()`,
    [jobId, messageIdx, toolUseId, toolName, typeof input === 'string' ? input : JSON.stringify(input), error],
  );
}
