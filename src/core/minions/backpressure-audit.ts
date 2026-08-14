/**
 * Backpressure audit log — operational trace for `maxWaiting` AND `maxPending`
 * coalesce events.
 *
 * Mirrors the shell-audit.ts pattern (ISO-week-rotated JSONL, best-effort writes,
 * failures go to stderr but never block submission). The incident that motivated
 * maxWaiting (autopilot pile-up during a 90+ min queue wedge) was invisible
 * precisely because the coalesce silently dropped repeat submissions. This
 * trail answers "why is queue depth steady at 2 for this name?" without any
 * doctor scan.
 *
 * A maxWaiting event carries waiting_count/max_waiting; a maxPending event
 * carries pending_count/max_pending. Both use decision:'coalesced'.
 *
 * File: `~/.gbrain/audit/backpressure-YYYY-Www.jsonl` (override dir via
 * `GBRAIN_AUDIT_DIR` for container/sandbox deployments where `$HOME` is read-only).
 *
 * `gbrain jobs stats` surfaces a 24h coalesce summary from this file (the
 * Backpressure line); deeper per-decision history stays a follow-up. The audit
 * trail is for operators debugging live queues, not for compliance — a
 * disk-full attacker can silently disable it.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { gbrainPath } from '../config.ts';

export interface BackpressureAuditEvent {
  ts: string;
  queue: string;
  name: string;
  /** Present on maxWaiting coalesce events. */
  waiting_count?: number;
  max_waiting?: number;
  /** Present on maxPending (single-flight) coalesce events. */
  pending_count?: number;
  max_pending?: number;
  decision: 'coalesced';
  returned_job_id: number;
}

/** Compute `backpressure-YYYY-Www.jsonl` using ISO-8601 week numbering.
 *
 *  Copy of the shell-audit computeAuditFilename algorithm, parameterized on
 *  the filename prefix. Keeping the math inline (rather than re-exporting from
 *  shell-audit.ts) avoids a cross-module dependency between two best-effort
 *  audit surfaces — one can be rewritten without touching the other.
 */
export function computeAuditFilename(now: Date = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dayNum = (d.getUTCDay() + 6) % 7; // Mon=0, Sun=6
  d.setUTCDate(d.getUTCDate() - dayNum + 3); // shift to Thursday
  const isoYear = d.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstThursdayDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstThursdayDayNum + 3);
  const weekNum = Math.round((d.getTime() - firstThursday.getTime()) / (7 * 86400000)) + 1;
  const ww = String(weekNum).padStart(2, '0');
  return `backpressure-${isoYear}-W${ww}.jsonl`;
}

/** Honors `GBRAIN_AUDIT_DIR` for container/sandbox deployments. */
export function resolveAuditDir(): string {
  const override = process.env.GBRAIN_AUDIT_DIR;
  if (override && override.trim().length > 0) return override;
  return gbrainPath('audit');
}

/**
 * Per-name coalesce counts within the window, for `jobs stats`.
 *
 * Reads the CURRENT and PREVIOUS ISO-week files — a 24h window crosses the
 * week boundary for the first day of each ISO week, and a one-file read
 * would silently under-count exactly then. Filters to the queue the stats
 * command is scoped to. Best-effort: missing/unreadable files and malformed
 * lines are skipped; callers omit the display line when the map is empty.
 */
export function readRecentCoalesceCounts(opts: {
  queue: string;
  windowMs: number;
  now?: Date;
}): Map<string, number> {
  const now = opts.now ?? new Date();
  const dir = resolveAuditDir();
  const cutoff = now.getTime() - opts.windowMs;
  const files = new Set([
    computeAuditFilename(now),
    computeAuditFilename(new Date(now.getTime() - 7 * 86400000)),
  ]);
  const counts = new Map<string, number>();
  for (const filename of files) {
    let raw: string;
    try {
      raw = fs.readFileSync(path.join(dir, filename), 'utf8');
    } catch {
      continue; // missing file for that week — fine
    }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line) as BackpressureAuditEvent;
        if (ev.decision !== 'coalesced') continue;
        if (ev.queue !== opts.queue) continue;
        const t = Date.parse(ev.ts);
        if (!Number.isFinite(t) || t < cutoff || t > now.getTime()) continue;
        counts.set(ev.name, (counts.get(ev.name) ?? 0) + 1);
      } catch {
        // malformed line — skip
      }
    }
  }
  return counts;
}

export function logBackpressureCoalesce(event: Omit<BackpressureAuditEvent, 'ts' | 'decision'>): void {
  const dir = resolveAuditDir();
  const filename = computeAuditFilename();
  const fullPath = path.join(dir, filename);
  const line = JSON.stringify({
    ...event,
    decision: 'coalesced' as const,
    ts: new Date().toISOString(),
  }) + '\n';

  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(fullPath, line, { encoding: 'utf8' });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[backpressure-audit] write failed (${msg}); submission continues\n`);
  }
}
