/**
 * volunteer_channels doctor check — per-channel push-context visibility.
 *
 * Engine-aware sibling of retrieval_reflex_health: groups
 * context_volunteer_events by channel (7 days) so operators can see which
 * push channels (reflex/op/watch/claude-code/codex) actually fire. Info-only
 * (status never worse than ok); pre-v117 brains (no table) degrade to a note
 * instead of throwing. Hermetic: stub engine, no real DB.
 */
import { describe, test, expect } from 'bun:test';
import { checkVolunteerChannels } from '../src/commands/doctor.ts';
import type { BrainEngine } from '../src/core/engine.ts';

function stubEngine(rows: Array<{ channel: string; n: number; last_fired: string | null }> | Error): BrainEngine {
  return {
    executeRaw: async () => {
      if (rows instanceof Error) throw rows;
      return rows;
    },
  } as unknown as BrainEngine;
}

describe('checkVolunteerChannels', () => {
  test('groups active channels with counts + last_fired; status ok', async () => {
    const check = await checkVolunteerChannels(
      stubEngine([
        { channel: 'claude-code', n: 12, last_fired: '2026-08-10T10:00:00Z' },
        { channel: 'reflex', n: 40, last_fired: '2026-08-11T09:00:00Z' },
      ]),
    );
    expect(check.name).toBe('volunteer_channels');
    expect(check.status).toBe('ok');
    expect(check.message).toContain('claude-code=12');
    expect(check.message).toContain('reflex=40');
    const channels = (check.details as { channels: Record<string, { count: number; last_fired: string | null }> }).channels;
    expect(channels['claude-code'].count).toBe(12);
    expect(channels['claude-code'].last_fired).toContain('2026-08-10');
  });

  test('quiet week: message separates unregistered-hook from quiet-channel diagnosis', async () => {
    const check = await checkVolunteerChannels(stubEngine([]));
    expect(check.status).toBe('ok'); // info-only — most installs use a subset of channels
    expect(check.message).toContain('no push-context activity');
    expect(check.message).toContain('RESTARTED'); // hooks snapshot at session start
  });

  test('pre-v117 brain (table absent) → ok with a note, never a throw', async () => {
    const check = await checkVolunteerChannels(stubEngine(new Error('relation "context_volunteer_events" does not exist')));
    expect(check.status).toBe('ok');
    expect(check.message).toContain('pre-v117');
    expect((check.details as { channels: object }).channels).toEqual({});
  });
});
