/**
 * loop-detect — the zero-LLM thread-state machine.
 *
 * For every synced Gmail thread, decide deterministically whether someone is
 * waiting: the last substantive message is inbound and unanswered
 * (unanswered_inbound — I owe the reply) or outbound and unanswered
 * (unanswered_outbound — I'm waiting on them). Loops close automatically
 * when the state stops holding (a reply landed).
 *
 * Precision IS the product (plan §Phase 4): the exclusion rules below are
 * pinned by the labeled fixture corpus in test/google-loop-detect.test.ts —
 * every new false-positive class gets a fixture before its fix.
 *  - noise senders never open loops (noreply/notifications/…)
 *  - list mail (List-Unsubscribe) never opens loops
 *  - self-threads (all participants are my addresses) never open loops
 *  - CC-only inbound does not owe a reply (must be in To:)
 *  - outbound without a question mark is FYI, not an ask
 *  - suppressed senders/threads (gbrain loops mute) never open NEW loops;
 *    existing loops keep their state
 *  - grace windows: inbound 24h, outbound 72h — fresh mail is not a loop yet
 *
 * Pure verdict function + a thin apply step; the apply step is called from
 * runGoogleSync per touched thread and must never fail the sync.
 */

import type { BrainEngine } from '../engine.ts';
import {
  closeThreadLoops,
  loadSuppressions,
  upsertOpenLoop,
  type LoopEvidence,
  type SuppressionSet,
} from '../loops/loops-store.ts';
import { isNoiseSender } from './google-render.ts';
import type { GmailMessageMeta, GmailThreadData } from './types.ts';

export const INBOUND_GRACE_HOURS = 24;
export const OUTBOUND_GRACE_HOURS = 72;

export interface ThreadLoopSpec {
  loopType: 'unanswered_inbound' | 'unanswered_outbound';
  counterpartyEmail: string;
  summary: string;
  evidence: LoopEvidence[];
  lastActivityMs: number;
}

export interface ThreadLoopVerdict {
  /** Desired end-state; anything not listed here gets closed. */
  open: ThreadLoopSpec[];
}

function isMine(m: GmailMessageMeta, myAddresses: Set<string>): boolean {
  return m.labelIds.includes('SENT') || myAddresses.has(m.fromAddress);
}

function ageHours(ms: number, now: Date): number {
  return (now.getTime() - ms) / 3_600_000;
}

function daysAgo(ms: number, now: Date): number {
  return Math.floor((now.getTime() - ms) / 86_400_000);
}

function quote(m: GmailMessageMeta): string {
  const q = m.bodyText.replace(/\s+/g, ' ').trim().slice(0, 200);
  return q;
}

/**
 * Pure detector. `suppressions` filters NEW loops only — closes still apply
 * so a muted thread that gets a reply still closes its old loop.
 */
export function detectThreadLoop(
  thread: GmailThreadData,
  myAddresses: Set<string>,
  now: Date,
  suppressions?: SuppressionSet,
): ThreadLoopVerdict {
  const messages = thread.messages.filter((m) => m.internalDateMs > 0);
  if (messages.length === 0) return { open: [] };

  // Substantive = not from a noise sender. Noise threads carry no loops.
  const substantive = messages.filter((m) => !isNoiseSender(m.fromAddress));
  if (substantive.length === 0) return { open: [] };

  const last = substantive[substantive.length - 1];
  const subject = (last.subject || substantive[0].subject || '(no subject)').replace(/^((re|fwd?|aw):\s*)+/i, '');

  // Self-thread: every participant is me (notes-to-self, drafts).
  const participants = new Set<string>();
  for (const m of substantive) {
    if (m.fromAddress) participants.add(m.fromAddress);
    for (const a of [...m.to, ...m.cc]) participants.add(a);
  }
  const external = [...participants].filter((p) => !myAddresses.has(p));
  if (external.length === 0) return { open: [] };

  const threadSuppressed = suppressions?.threads.has(thread.threadId) ?? false;

  if (!isMine(last, myAddresses)) {
    // ── Last word is theirs: do I owe a reply? ──
    // List mail never owes a reply.
    if (last.listUnsubscribe) return { open: [] };
    // CC-only (or bcc/list delivery with no To: match) does not owe a reply.
    const inTo = last.to.some((a) => myAddresses.has(a));
    if (!inTo) return { open: [] };
    if (threadSuppressed || suppressions?.senders.has(last.fromAddress)) return { open: [] };
    if (ageHours(last.internalDateMs, now) < INBOUND_GRACE_HOURS) return { open: [] };
    return {
      open: [
        {
          loopType: 'unanswered_inbound',
          counterpartyEmail: last.fromAddress,
          summary: `Reply owed to ${last.fromAddress}: "${subject}" (${daysAgo(last.internalDateMs, now)}d)`,
          evidence: [{ message_id: last.id, quote: quote(last) }],
          lastActivityMs: last.internalDateMs,
        },
      ],
    };
  }

  // ── Last word is mine: am I waiting on them? ──
  // No question mark → FYI/forward, not an ask.
  if (!last.bodyText.includes('?')) return { open: [] };
  const recipients = last.to.filter((a) => !myAddresses.has(a));
  if (recipients.length === 0) return { open: [] };
  const counterparty = recipients[0];
  if (threadSuppressed || suppressions?.senders.has(counterparty)) return { open: [] };
  if (ageHours(last.internalDateMs, now) < OUTBOUND_GRACE_HOURS) return { open: [] };
  return {
    open: [
      {
        loopType: 'unanswered_outbound',
        counterpartyEmail: counterparty,
        summary: `Waiting on ${counterparty}: "${subject}" (asked ${daysAgo(last.internalDateMs, now)}d ago)`,
        evidence: [{ message_id: last.id, quote: quote(last) }],
        lastActivityMs: last.internalDateMs,
      },
    ],
  };
}

// Suppression sets are cheap but per-thread queries add up on a backfill;
// cache per source for one process, refreshed on a 60s TTL.
const suppressionCache = new Map<string, { set: SuppressionSet; loadedAt: number }>();

async function suppressionsFor(engine: BrainEngine, sourceId: string): Promise<SuppressionSet> {
  const hit = suppressionCache.get(sourceId);
  if (hit && Date.now() - hit.loadedAt < 60_000) return hit.set;
  const set = await loadSuppressions(engine, sourceId);
  suppressionCache.set(sourceId, { set, loadedAt: Date.now() });
  return set;
}

/** Test seam: drop the cache between cases. */
export function __clearSuppressionCacheForTests(): void {
  suppressionCache.clear();
}

/**
 * Apply the verdict: close thread loops that no longer hold, upsert the ones
 * that do (dedup key 'thread:<threadId>:<loop_type>' — reopen on conflict).
 * Counterparty slug resolution is alias-exact within the same source.
 */
export async function applyThreadLoopVerdict(
  engine: BrainEngine,
  sourceId: string,
  thread: GmailThreadData,
  myAddresses: Set<string>,
  pageSlug: string | null,
  now: Date = new Date(),
): Promise<void> {
  const suppressions = await suppressionsFor(engine, sourceId);
  // Two verdicts, two jobs: the RAW verdict (no suppressions) decides what
  // genuinely stopped holding (a reply landed) and may CLOSE; the suppressed
  // verdict decides what may OPEN. Muting must never close an existing loop
  // — "suppressed senders/threads never open NEW loops; existing loops keep
  // their state" — and must never stamp closed_by:'reply_detected' on a
  // loop nobody replied to.
  const rawVerdict = detectThreadLoop(thread, myAddresses, now);
  const verdict = detectThreadLoop(thread, myAddresses, now, suppressions);

  const stillHolding = new Set(rawVerdict.open.map((s) => s.loopType));
  const allTypes: Array<'unanswered_inbound' | 'unanswered_outbound'> = [
    'unanswered_inbound',
    'unanswered_outbound',
  ];
  const toClose = allTypes.filter((t) => !stillHolding.has(t));
  if (toClose.length > 0) {
    await closeThreadLoops(engine, sourceId, thread.threadId, 'reply_detected', toClose);
  }

  for (const spec of verdict.open) {
    let counterpartySlug: string | null = null;
    try {
      const { resolveEntitySlugWithSource } = await import('../entities/resolve.ts');
      const resolved = await resolveEntitySlugWithSource(engine, sourceId, spec.counterpartyEmail);
      // Only alias-exact/high-confidence resolutions count — a slugify
      // fallback would fabricate a person that doesn't exist.
      if (resolved && resolved.source !== 'fallback_slugify') counterpartySlug = resolved.slug;
    } catch {
      /* resolution is best-effort */
    }
    await upsertOpenLoop(engine, {
      sourceId,
      dedupKey: `thread:${thread.threadId}:${spec.loopType}`,
      loopType: spec.loopType,
      counterpartySlug,
      counterpartyEmail: spec.counterpartyEmail,
      summary: spec.summary,
      evidence: spec.evidence.map((e) => ({ ...e, ...(pageSlug ? { page_slug: pageSlug } : {}) })),
      threadId: thread.threadId,
      pageSlug,
      detector: 'deterministic_thread',
      lastActivityAt: new Date(spec.lastActivityMs).toISOString(),
    });
  }
}
