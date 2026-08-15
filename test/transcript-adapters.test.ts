/**
 * transcript-adapters.test.ts — the cathedral-4 adapter seam.
 *
 * Carries the MANDATORY regression pin (plan T12): parseTranscript's output
 * on the shipped fixture is pinned EXACTLY — the hook session-end lane and
 * ambient hooks consume it, and the import lane's additive
 * parseClaudeSessionFile must never change it.
 */
import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  parseTranscript,
  parseClaudeSessionFile,
} from '../src/core/transcripts/claude-code-jsonl.ts';
import { claudeCodeAdapter } from '../src/core/transcripts/claude-code.ts';
import {
  detectAdapter,
  harnessRoots,
  readSample,
} from '../src/core/transcripts/detect.ts';
import {
  buildTranscriptSlug,
  transcriptId8,
  type FileDiagnostics,
  type ParsedSession,
} from '../src/core/transcripts/types.ts';

const FIXTURE = join(import.meta.dir, 'fixtures', 'conversation-formats', 'claude-code.jsonl');

let tmp: string | null = null;
function tdir(): string {
  tmp = mkdtempSync(join(tmpdir(), 'gb-adapters-'));
  return tmp;
}
afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

async function drain(
  gen: AsyncGenerator<ParsedSession, FileDiagnostics>,
): Promise<{ sessions: ParsedSession[]; diag: FileDiagnostics }> {
  const sessions: ParsedSession[] = [];
  let r = await gen.next();
  while (!r.done) {
    sessions.push(r.value);
    r = await gen.next();
  }
  return { sessions, diag: r.value };
}

// ── T12: REGRESSION PIN on the shipped hook-lane parser ─────────────────────

describe('parseTranscript regression pin [T12 — hook lane must not move]', () => {
  test('fixture output is byte-identical to the pinned shape', () => {
    const r = parseTranscript(FIXTURE);
    expect(r.parsedLines).toBe(8);
    expect(r.skippedLines).toBe(1);
    expect(r.compactBoundaries).toBe(1);
    expect(r.injectedContextBlocks).toEqual([]);
    expect(r.turns).toEqual([
      { role: 'user', text: "What do we know about widget-co's seed round?" },
      {
        role: 'assistant',
        text:
          'widget-co raised a seed round led by fund-a.\n' +
          'alice-example introduced the founders to charlie-example.',
      },
      {
        role: 'assistant',
        text: 'Let me check the brain for acme-example connections.\n[tool: search_brain]',
      },
      { role: 'user', text: '[tool result]\n[image]' },
      {
        role: 'assistant',
        text:
          '[thinking]\nSummary: the widget-co seed closed in early 2026 with ' +
          'fund-a leading and fund-b participating.',
      },
    ]);
  });
});

// ── parseClaudeSessionFile (additive import lane) ───────────────────────────

describe('parseClaudeSessionFile [timestamps preserved, never invented]', () => {
  test('turns carry real source timestamps and match the hook-lane turns 1:1', () => {
    const s = parseClaudeSessionFile(FIXTURE);
    expect(s.sessionId).toBe('fixture-session-1');
    expect(s.cwd).toBe('/home/alice-example/agent-workspace');
    expect(s.startedAt).toBe('2026-08-01T10:00:00.000Z');
    expect(s.skippedLines).toBe(1);
    expect(s.turns.map((t) => t.timestamp)).toEqual([
      '2026-08-01T10:00:00.000Z',
      '2026-08-01T10:00:05.000Z',
      '2026-08-01T10:00:09.000Z',
      '2026-08-01T10:00:11.000Z',
      '2026-08-01T10:00:20.000Z',
    ]);
    const hookTurns = parseTranscript(FIXTURE).turns;
    expect(s.turns.map(({ role, text }) => ({ role, text }))).toEqual(hookTurns);
  });

  test('rejects (never tail-reads) a file over the cap', () => {
    expect(() => parseClaudeSessionFile(FIXTURE, { maxBytes: 64 })).toThrow(/too large/);
  });
});

// ── Slug builder [one helper, collision-proof suffixes] ─────────────────────

describe('buildTranscriptSlug', () => {
  test('harness sessions get per-day format+id8 slugs', () => {
    expect(
      buildTranscriptSlug('codex', '2026-08-14T15:12:45.000Z', { sessionId: 'AB12cd34ef56' }),
    ).toBe('conversations/sessions/2026-08-14-codex-ab12cd34');
  });
  test('exports get per-provider dirs with title + id8', () => {
    expect(
      buildTranscriptSlug('chatgpt', '2026-01-02T03:04:05Z', {
        sessionId: 'thread-777xyz00',
        title: 'Planning the Widget Co launch!',
      }),
    ).toBe('conversations/chatgpt/2026-01-02-planning-the-widget-co-launch-thread77');
    expect(
      buildTranscriptSlug('claude-export', '2026-01-02T03:04:05Z', { sessionId: 'thread-777xyz00' }),
    ).toBe('conversations/claude/2026-01-02-untitled-thread77');
  });
  test('id8 hashes ids that are not slug-safe enough', () => {
    const a = transcriptId8('!!');
    const b = transcriptId8('!?');
    expect(a).toMatch(/^[0-9a-f]{8}$/);
    expect(b).toMatch(/^[0-9a-f]{8}$/);
    expect(a).not.toBe(b);
    // Deterministic across calls.
    expect(transcriptId8('!!')).toBe(a);
  });
});

// ── Detection registry ──────────────────────────────────────────────────────

describe('detectAdapter', () => {
  test('detects the claude-code fixture', () => {
    const r = detectAdapter(FIXTURE);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.adapter.format).toBe('claude-code');
  });

  test('unknown format names every detector tried', () => {
    const d = tdir();
    const p = join(d, 'mystery.jsonl');
    writeFileSync(p, '{"totally":"unrelated"}\n');
    const r = detectAdapter(p);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('unknown_format');
      expect(r.tried).toContain('claude-code');
    }
  });

  test('rejects symlinks (lstat, never followed)', () => {
    const d = tdir();
    const link = join(d, 'link.jsonl');
    symlinkSync(FIXTURE, link);
    const r = detectAdapter(link);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('symlink');
  });

  test('explicit format wins over sniffing', () => {
    const d = tdir();
    const p = join(d, 'whatever.txt');
    writeFileSync(p, 'not json at all');
    const r = detectAdapter(p, { explicitFormat: 'claude-code' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.adapter.format).toBe('claude-code');
  });
});

describe('harnessRoots', () => {
  test('covers the four harnesses and is override-injectable for tests', () => {
    const formats = harnessRoots().map((r) => r.format);
    expect(formats).toEqual(['claude-code', 'codex', 'openclaw', 'hermes']);
    const injected = harnessRoots([{ format: 'codex', root: '/tmp/x', extension: '.jsonl' }]);
    expect(injected).toHaveLength(1);
    expect(injected[0].root).toBe('/tmp/x');
  });
});

// ── Claude adapter through the seam ─────────────────────────────────────────

describe('claudeCodeAdapter', () => {
  test('yields one session with diagnostics on the fixture', async () => {
    const { sessions, diag } = await drain(claudeCodeAdapter.parse(FIXTURE));
    expect(sessions).toHaveLength(1);
    const s = sessions[0];
    expect(s.meta.harness).toBe('claude-code');
    expect(s.meta.sessionId).toBe('fixture-session-1');
    expect(s.messages).toHaveLength(5);
    expect(s.messages[0].timestamp).toBe('2026-08-01T10:00:00.000Z');
    expect(diag.sessions).toBe(1);
    expect(diag.skippedLines).toBe(1);
    expect(diag.bytesRead).toBeGreaterThan(0);
    expect(diag.truncated).toBe(false);
  });

  test('zero-turn file explains itself (drift signal shape)', async () => {
    const d = tdir();
    const p = join(d, 'empty-turns.jsonl');
    writeFileSync(p, '{"type":"summary","summary":"nothing"}\n');
    const { sessions, diag } = await drain(claudeCodeAdapter.parse(p));
    expect(sessions).toHaveLength(0);
    expect(diag.sessions).toBe(0);
    expect(diag.bytesRead).toBeGreaterThan(0);
    expect(diag.zeroSessionsReason).toBeTruthy();
  });

  test('detect sniffs the first line shape', () => {
    expect(claudeCodeAdapter.detect(FIXTURE, readSample(FIXTURE))).toBe(true);
  });
});
