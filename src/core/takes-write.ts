/**
 * Shared takes write-through core — consumed by the `gbrain takes` CLI
 * (src/commands/takes.ts) and the takes_* MCP ops (src/core/ops/takes.ts).
 *
 * MARKDOWN IS CANONICAL (the extract-takes contract, src/core/cycle/
 * extract-takes.ts): the md→DB reconcile upserts ON CONFLICT(page_id,row_num)
 * and `--rebuild` deletes+reinserts from md, so any writer that creates
 * DB-only rows gets silently clobbered by the next sync/extract. Every
 * mutation here is therefore md-FIRST — row numbers derive from the fence
 * (takes-fence.ts), the .md file is written before the DB — and the markdown
 * write is REQUIRED: when the page file can't be located the write REFUSES
 * (TakesWriteError 'mirror_unavailable') instead of creating divergence.
 *
 * Every mutate runs this pipeline:
 *
 *   lock(slug, timeout) ─▶ page id (DB, source-scoped) ─▶ read .md
 *        │                                                   │
 *        │                    row lookup + holder fence ◀────┘ (fence rows,
 *        │                          │                          md-canonical)
 *        │                    fence edit ─▶ write .md ─▶ DB mirror ─▶ release
 *        ▼
 *   [contended → 'page_locked' (retryable)]
 *
 * The DB mirror for add/update/supersede is addTakesBatch's upsert of the
 * affected fence rows — the same primitive the extract pipeline uses, so the
 * mirror can never disagree with a later reconcile. Its DO UPDATE clause
 * touches base columns only (resolution columns preserved). resolve mirrors
 * via engine.resolveTake (resolution fields aren't in TakeBatchInput);
 * a drifted DB missing the row is self-healed by upserting the base row
 * first — md is the truth being propagated.
 *
 * Holder fence (remote callers): callers pass `allowList` (null/undefined =
 * trusted local, unfenced; [] = deny-all). Row-level checks look up the
 * PARSED FENCE row and a fenced holder presents as 'row_not_found' — the
 * same shape as a genuinely missing row — hiding content and holder.
 * (Existence-by-count via dense row numbers is a documented, accepted
 * limitation — see ops/takes.ts.)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { BrainEngine, TakeBatchInput, TakeKind } from './engine.ts';
import {
  parseTakesFence,
  renderTakesFence,
  upsertTakeRow,
  supersedeRow,
  TAKES_FENCE_BEGIN,
  TAKES_FENCE_END,
  type ParsedTake,
} from './takes-fence.ts';
import { withPageLock } from './page-lock.ts';

export type TakesWriteErrorCode =
  | 'page_not_found'      // slug has no pages row (scoped)
  | 'row_not_found'       // fence lacks the row OR the holder fence masks it
  | 'already_resolved'    // resolved rows are immutable; supersede instead
  | 'row_inactive'        // superseded rows can't be updated/resolved again
  | 'holder_denied'       // add with a holder outside the allow-list
  | 'no_fields'           // update with zero mutable fields
  | 'mirror_unavailable'  // sync.repo_path unset or page file absent
  | 'page_locked';        // lock contention within the timeout (retryable)

export class TakesWriteError extends Error {
  code: TakesWriteErrorCode;
  hint?: string;
  constructor(code: TakesWriteErrorCode, message: string, hint?: string) {
    super(message);
    this.name = 'TakesWriteError';
    this.code = code;
    this.hint = hint;
  }
}

/** null/undefined = trusted local (unfenced); [] = deny-all. */
export type HolderAllowList = readonly string[] | null | undefined;

export interface TakesWriteTarget {
  engine: BrainEngine;
  slug: string;
  /** Brain repo dir (resolveTakesRepoDir or an explicit CLI --dir). */
  brainDir: string;
  /** Scalar source scope for the pages lookup (writes are scalar). */
  sourceId?: string;
  allowList?: HolderAllowList;
  /** Lock wait budget. CLI keeps the 30s default; ops pass ~2000. */
  lockTimeoutMs?: number;
}

export interface TakeMirror { written: true; path: string }

/**
 * Resolve the markdown brain dir for takes write-through. Returns null when
 * `sync.repo_path` is unset or missing on disk — callers decide the refusal
 * shape (ops: 'mirror_unavailable'; CLI: its historical error text + exit 1).
 */
export async function resolveTakesRepoDir(engine: BrainEngine): Promise<string | null> {
  const configured = await engine.getConfig('sync.repo_path');
  if (configured && existsSync(configured)) return configured;
  return null;
}

function pageFilePath(brainDir: string, slug: string): string {
  return join(brainDir, `${slug}.md`);
}

async function getPageId(engine: BrainEngine, slug: string, sourceId?: string): Promise<number> {
  const rows = sourceId
    ? await engine.executeRaw<{ id: number }>(
        `SELECT id FROM pages WHERE slug = $1 AND source_id = $2 LIMIT 1`,
        [slug, sourceId],
      )
    : await engine.executeRaw<{ id: number }>(
        `SELECT id FROM pages WHERE slug = $1 LIMIT 1`,
        [slug],
      );
  if (!rows[0]) {
    throw new TakesWriteError(
      'page_not_found',
      `Page not found in brain: ${slug}${sourceId ? ` (source=${sourceId})` : ''}.`,
      'Run a brain sync first, or check the slug/source.',
    );
  }
  return rows[0].id;
}

function assertHolderAllowed(holder: string, allowList: HolderAllowList): void {
  if (allowList === null || allowList === undefined) return; // trusted local
  if (!allowList.includes(holder)) {
    throw new TakesWriteError(
      'holder_denied',
      `holder '${holder}' is not in this caller's takes-holder allow-list.`,
      'holder_not_in_allowlist',
    );
  }
}

/**
 * Row lookup with the no-existence-leak masking: a row that is absent from
 * the fence AND a row whose holder the caller cannot see produce the SAME
 * error shape.
 */
function findFenceRow(takes: ParsedTake[], rowNum: number, allowList: HolderAllowList, slug: string): ParsedTake {
  const target = takes.find(t => t.rowNum === rowNum);
  const visible = target
    && (allowList === null || allowList === undefined || allowList.includes(target.holder));
  if (!target || !visible) {
    throw new TakesWriteError('row_not_found', `Row #${rowNum} not found on ${slug}.`);
  }
  return target;
}

function readPageBody(brainDir: string, slug: string): { path: string; body: string } {
  const path = pageFilePath(brainDir, slug);
  if (!existsSync(path)) {
    throw new TakesWriteError(
      'mirror_unavailable',
      `Page file not found at ${path} — takes are markdown-canonical, so the write is refused.`,
      'takes_mirror_unavailable',
    );
  }
  return { path, body: readFileSync(path, 'utf-8') };
}

function writePageBody(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, 'utf-8');
}

function replaceFence(body: string, rows: ParsedTake[]): string {
  const newFence = renderTakesFence(rows);
  const beginIdx = body.indexOf(TAKES_FENCE_BEGIN);
  const endIdx = body.indexOf(TAKES_FENCE_END, beginIdx + TAKES_FENCE_BEGIN.length);
  return body.slice(0, beginIdx) + newFence + body.slice(endIdx + TAKES_FENCE_END.length);
}

function toBatchInput(pageId: number, t: ParsedTake, supersededBy?: number | null): TakeBatchInput {
  return {
    page_id: pageId,
    row_num: t.rowNum,
    claim: t.claim,
    kind: t.kind,
    holder: t.holder,
    weight: t.weight,
    since_date: t.sinceDate,
    until_date: t.untilDate,
    source: t.source,
    active: t.active,
    superseded_by: supersededBy ?? null,
  };
}

async function withTakesLock<T>(target: TakesWriteTarget, fn: () => Promise<T>): Promise<T> {
  try {
    return await withPageLock(target.slug, fn, {
      ...(target.lockTimeoutMs !== undefined ? { timeoutMs: target.lockTimeoutMs } : {}),
    });
  } catch (err) {
    if (err instanceof TakesWriteError) throw err;
    if (err instanceof Error && err.message.includes('could not acquire lock')) {
      throw new TakesWriteError(
        'page_locked',
        `Another writer holds the page lock for ${target.slug} — retry shortly.`,
        'retryable',
      );
    }
    throw err;
  }
}

export interface AddTakeInput {
  claim: string;
  kind: TakeKind;
  holder: string;
  weight?: number;
  source?: string;
  sinceDate?: string;
}

export async function addTakeToPage(
  target: TakesWriteTarget,
  input: AddTakeInput,
): Promise<{ rowNum: number; mirror: TakeMirror }> {
  assertHolderAllowed(input.holder, target.allowList);
  return withTakesLock(target, async () => {
    // Resolve the page BEFORE touching the markdown (the historical CLI
    // ordering): failing after a fence write would leave a take on disk the
    // DB never saw until the next reconcile.
    const pageId = await getPageId(target.engine, target.slug, target.sourceId);
    // add is the one mutate that may CREATE the page file + fence (first take
    // on a page) — readPageBody's existence refusal applies to row-targeting
    // mutates, not appends; the page itself was verified in the DB above.
    const path = pageFilePath(target.brainDir, target.slug);
    const body = existsSync(path) ? readFileSync(path, 'utf-8') : '';
    const { body: nextBody, rowNum } = upsertTakeRow(body, {
      claim: input.claim,
      kind: input.kind,
      holder: input.holder,
      weight: input.weight ?? 0.5,
      source: input.source,
      sinceDate: input.sinceDate,
      active: true,
    });
    writePageBody(path, nextBody);
    await target.engine.addTakesBatch([{
      page_id: pageId, row_num: rowNum, claim: input.claim, kind: input.kind,
      holder: input.holder, weight: input.weight ?? 0.5,
      since_date: input.sinceDate, source: input.source,
      active: true, superseded_by: null,
    }]);
    return { rowNum, mirror: { written: true, path } };
  });
}

export interface UpdateTakeFields {
  weight?: number;
  source?: string;
  sinceDate?: string;
}

export async function updateTakeOnPage(
  target: TakesWriteTarget,
  rowNum: number,
  fields: UpdateTakeFields,
): Promise<{ rowNum: number; mirror: TakeMirror }> {
  if (fields.weight === undefined && fields.source === undefined && fields.sinceDate === undefined) {
    throw new TakesWriteError('no_fields', 'No mutable fields given (weight, source, since date).');
  }
  return withTakesLock(target, async () => {
    const pageId = await getPageId(target.engine, target.slug, target.sourceId);
    const { path, body } = readPageBody(target.brainDir, target.slug);
    const parsed = parseTakesFence(body);
    const targetRow = findFenceRow(parsed.takes, rowNum, target.allowList, target.slug);
    if (targetRow.resolvedAt) {
      throw new TakesWriteError('already_resolved', `Row #${rowNum} on ${target.slug} is resolved — resolved takes are immutable.`, 'Supersede instead.');
    }
    const updated: ParsedTake = {
      ...targetRow,
      weight: fields.weight ?? targetRow.weight,
      source: fields.source ?? targetRow.source,
      sinceDate: fields.sinceDate ?? targetRow.sinceDate,
    };
    const allRows = parsed.takes.map(t => (t.rowNum === rowNum ? updated : t));
    writePageBody(path, replaceFence(body, allRows));
    // Mirror md→DB with the reconcile primitive (upsert on (page_id,row_num));
    // base columns only, resolution columns preserved by the DO UPDATE list.
    await target.engine.addTakesBatch([toBatchInput(pageId, updated)]);
    return { rowNum, mirror: { written: true, path } };
  });
}

export interface SupersedeTakeInput {
  claim: string;
  kind?: TakeKind;
  holder?: string;
  weight?: number;
  source?: string;
  sinceDate?: string;
}

export async function supersedeTakeOnPage(
  target: TakesWriteTarget,
  rowNum: number,
  input: SupersedeTakeInput,
): Promise<{ oldRow: number; newRow: number; mirror: TakeMirror }> {
  return withTakesLock(target, async () => {
    const pageId = await getPageId(target.engine, target.slug, target.sourceId);
    const { path, body } = readPageBody(target.brainDir, target.slug);
    const parsed = parseTakesFence(body);
    const targetRow = findFenceRow(parsed.takes, rowNum, target.allowList, target.slug);
    if (!targetRow.active) {
      throw new TakesWriteError('row_inactive', `Row #${rowNum} on ${target.slug} is already superseded.`);
    }
    if (targetRow.resolvedAt) {
      throw new TakesWriteError('already_resolved', `Row #${rowNum} on ${target.slug} is resolved — resolved takes are immutable.`, 'Add a new take instead.');
    }
    const holder = input.holder ?? targetRow.holder;
    // An explicit replacement holder must clear the fence too (an allow-listed
    // caller must not mint rows held by identities it can't see).
    if (input.holder !== undefined) assertHolderAllowed(input.holder, target.allowList);
    // CLI-parity default: unset weight decays the target's by 0.1.
    const weight = input.weight ?? Math.max(0, targetRow.weight - 0.1);
    const { body: nextBody, newRowNum } = supersedeRow(body, rowNum, {
      claim: input.claim,
      kind: input.kind ?? targetRow.kind,
      holder,
      weight,
      sinceDate: input.sinceDate,
      source: input.source,
    });
    writePageBody(path, nextBody);
    // Mirror BOTH affected rows exactly as the fence now states them:
    // old → inactive + superseded_by pointer, new → active append.
    const after = parseTakesFence(nextBody).takes;
    const oldAfter = after.find(t => t.rowNum === rowNum);
    const newAfter = after.find(t => t.rowNum === newRowNum);
    const mirrorRows: TakeBatchInput[] = [];
    if (oldAfter) mirrorRows.push(toBatchInput(pageId, oldAfter, newRowNum));
    if (newAfter) mirrorRows.push(toBatchInput(pageId, newAfter, null));
    await target.engine.addTakesBatch(mirrorRows);
    return { oldRow: rowNum, newRow: newRowNum, mirror: { written: true, path } };
  });
}

export type ResolveQuality = 'correct' | 'incorrect' | 'partial' | 'unresolvable';

export interface ResolveTakeInput {
  quality: ResolveQuality;
  /** Evidence text (stored as the resolution source). */
  evidence?: string;
  value?: number;
  unit?: string;
  resolvedBy: string;
}

export async function resolveTakeOnPage(
  target: TakesWriteTarget,
  rowNum: number,
  input: ResolveTakeInput,
): Promise<{ rowNum: number; quality: ResolveQuality; mirror: TakeMirror }> {
  return withTakesLock(target, async () => {
    const pageId = await getPageId(target.engine, target.slug, target.sourceId);
    const { path, body } = readPageBody(target.brainDir, target.slug);
    const parsed = parseTakesFence(body);
    const targetRow = findFenceRow(parsed.takes, rowNum, target.allowList, target.slug);
    if (targetRow.resolvedAt) {
      throw new TakesWriteError('already_resolved', `Row #${rowNum} on ${target.slug} is already resolved.`);
    }
    // quality → outcome per the schema CHECK (v74): correct↔true,
    // incorrect↔false, partial/unresolvable↔NULL.
    const outcome = input.quality === 'correct' ? true
      : input.quality === 'incorrect' ? false : undefined;
    const updated: ParsedTake = {
      ...targetRow,
      resolvedAt: new Date().toISOString().slice(0, 10),
      resolvedQuality: input.quality,
      resolvedOutcome: outcome,
      resolvedEvidence: input.evidence,
      resolvedValue: input.value,
      resolvedUnit: input.unit,
      resolvedBy: input.resolvedBy,
    };
    const allRows = parsed.takes.map(t => (t.rowNum === rowNum ? updated : t));
    writePageBody(path, replaceFence(body, allRows));
    // Resolution fields aren't in TakeBatchInput — mirror via resolveTake.
    // A drifted DB missing the row is self-healed md→DB (upsert the base row,
    // then resolve): the markdown is the truth being propagated.
    try {
      await target.engine.resolveTake(pageId, rowNum, {
        quality: input.quality,
        outcome,
        value: input.value,
        unit: input.unit,
        source: input.evidence,
        resolvedBy: input.resolvedBy,
      });
    } catch (err) {
      if (err instanceof Error && err.message.includes('TAKE_ROW_NOT_FOUND')) {
        await target.engine.addTakesBatch([toBatchInput(pageId, targetRow)]);
        await target.engine.resolveTake(pageId, rowNum, {
          quality: input.quality,
          outcome,
          value: input.value,
          unit: input.unit,
          source: input.evidence,
          resolvedBy: input.resolvedBy,
        });
      } else {
        throw err;
      }
    }
    return { rowNum, quality: input.quality, mirror: { written: true, path } };
  });
}
