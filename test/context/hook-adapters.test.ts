/**
 * Harness hook adapters — payload parsing, transcript-tail confinement, and
 * the injected-block dedupe input (T0 evidence fixture: a REAL Claude Code
 * transcript captured 2026-08-07 with a UserPromptSubmit hook installed —
 * test/fixtures/hook-transcript.jsonl).
 */
import { describe, test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, symlinkSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import {
  parseHookPayload,
  parseTranscriptTail,
  readTranscriptTail,
  emitHookEnvelope,
  TRANSCRIPT_TAIL_MAX_BYTES,
} from '../../src/core/context/hook-adapters.ts';
import { withEnv } from '../helpers/with-env.ts';

const FIXTURE = join(import.meta.dir, '..', 'fixtures', 'hook-transcript.jsonl');

describe('parseHookPayload', () => {
  const base = {
    session_id: 'sess-123',
    transcript_path: '/tmp/t.jsonl',
    cwd: '/tmp/repo',
    hook_event_name: 'UserPromptSubmit',
    prompt: 'Tell me about Acme Example',
  };

  test('UserPromptSubmit happy path (T0-verified key set)', () => {
    const p = parseHookPayload(JSON.stringify(base));
    expect(p).not.toBeNull();
    expect(p!.event).toBe('UserPromptSubmit');
    expect(p!.text).toBe('Tell me about Acme Example');
    expect(p!.sessionId).toBe('sess-123');
    expect(p!.transcriptPath).toBe('/tmp/t.jsonl');
    expect(p!.cwd).toBe('/tmp/repo');
  });

  test('defensive text keys: user_prompt / text accepted', () => {
    const { prompt: _drop, ...rest } = base;
    expect(parseHookPayload(JSON.stringify({ ...rest, user_prompt: 'via user_prompt' }))!.text).toBe('via user_prompt');
    expect(parseHookPayload(JSON.stringify({ ...rest, text: 'via text' }))!.text).toBe('via text');
  });

  test('PostToolUse payload accepted (parser supports it even though v1 recipes register UserPromptSubmit only)', () => {
    const p = parseHookPayload(JSON.stringify({ ...base, hook_event_name: 'PostToolUse', tool_response: 'Acme Example appears in the result' }));
    expect(p).not.toBeNull();
    expect(p!.event).toBe('PostToolUse');
    expect(p!.text).toContain('Acme Example');
    // object-shaped tool_response is stringified
    const p2 = parseHookPayload(JSON.stringify({ ...base, hook_event_name: 'PostToolUse', tool_response: { output: 'Acme' } }));
    expect(p2!.text).toContain('Acme');
  });

  test('unknown event / junk / empty → null (silence)', () => {
    expect(parseHookPayload(JSON.stringify({ ...base, hook_event_name: 'SessionStart' }))).toBeNull();
    expect(parseHookPayload('not json at all')).toBeNull();
    expect(parseHookPayload('')).toBeNull();
    expect(parseHookPayload('[]')).toBeNull();
    expect(parseHookPayload(JSON.stringify({ ...base, prompt: '   ' }))).toBeNull();
  });

  test('oversized session_id is clamped to 256 (untrusted stdin, op precedent)', () => {
    const p = parseHookPayload(JSON.stringify({ ...base, session_id: 'x'.repeat(1000) }));
    expect(p!.sessionId!.length).toBe(256);
  });
});

describe('parseTranscriptTail (pure)', () => {
  test('T0 fixture: recovers turns AND both injected blocks structurally', () => {
    const text = readFileSync(FIXTURE, 'utf8');
    const { turns, injectedBlocks } = parseTranscriptTail(text, 8);
    // Two user prompts + two assistant replies (T0 session)
    expect(turns.map((t) => t.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(turns[0].text).toBe('Reply with exactly: OK');
    expect(turns[3].text).toBe('OK2');
    // Both hook injections recovered from hook_additional_context attachments
    expect(injectedBlocks).toHaveLength(2);
    expect(injectedBlocks[0]).toContain('companies/acme-example');
    expect(injectedBlocks[0]).toContain('Brain pages mentioned this turn');
  });

  test('over-suppression pin: entity text in a USER prompt is NOT an injected block', () => {
    const lines = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'I met Widget Co yesterday' } }),
      JSON.stringify({ type: 'attachment', attachment: { type: 'hook_additional_context', content: ['- **Acme** → `companies/acme`'] } }),
    ].join('\n');
    const { injectedBlocks } = parseTranscriptTail(lines, 4);
    // Only the structured injection is dedupe input — the user's own mention
    // of Widget Co must NOT suppress a future Widget Co pointer.
    expect(injectedBlocks).toHaveLength(1);
    expect(injectedBlocks[0]).not.toContain('Widget');
  });

  test('malformed lines are skipped individually; the rest parse', () => {
    const lines = [
      '{"type":"user","message":{"role":"user","content":"good line"}}',
      '{corrupted json!!!',
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"reply"}]}}',
    ].join('\n');
    const { turns } = parseTranscriptTail(lines, 4);
    expect(turns).toHaveLength(2);
  });

  test('tool-result user lines (array content) are not turns', () => {
    const lines = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'big payload' }] } }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'real prompt' } }),
    ].join('\n');
    const { turns } = parseTranscriptTail(lines, 4);
    expect(turns).toHaveLength(1);
    expect(turns[0].text).toBe('real prompt');
  });

  test('maxTurns keeps only the newest turns', () => {
    const lines = Array.from({ length: 6 }, (_, i) =>
      JSON.stringify({ type: 'user', message: { role: 'user', content: `prompt ${i}` } }),
    ).join('\n');
    const { turns } = parseTranscriptTail(lines, 2);
    expect(turns.map((t) => t.text)).toEqual(['prompt 4', 'prompt 5']);
  });
});

describe('readTranscriptTail (confined IO)', () => {
  test('reads $HOME per call — withEnv HOME redirection works mid-process', async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'hook-home-'));
    const inside = join(fakeHome, 'session.jsonl');
    writeFileSync(inside, JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi from fake home' } }) + '\n');
    await withEnv({ HOME: fakeHome }, () => {
      const tail = readTranscriptTail(inside, { maxTurns: 4 });
      expect(tail).not.toBeNull();
      expect(tail!.turns[0].text).toBe('hi from fake home');
    });
    rmSync(fakeHome, { recursive: true, force: true });
  });

  test('refusal matrix: missing / non-jsonl / outside $HOME / symlink escape → null', async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'hook-home-'));
    const outside = mkdtempSync(join(tmpdir(), 'hook-outside-'));
    const outsideFile = join(outside, 'session.jsonl');
    writeFileSync(outsideFile, '{"type":"user","message":{"role":"user","content":"outside"}}\n');
    const escapeLink = join(fakeHome, 'link.jsonl');
    symlinkSync(outsideFile, escapeLink);
    const notJsonl = join(fakeHome, 'notes.txt');
    writeFileSync(notJsonl, 'text');
    await withEnv({ HOME: fakeHome }, () => {
      expect(readTranscriptTail(join(fakeHome, 'missing.jsonl'))).toBeNull();
      expect(readTranscriptTail(notJsonl)).toBeNull();
      expect(readTranscriptTail(outsideFile)).toBeNull(); // outside $HOME
      expect(readTranscriptTail(escapeLink)).toBeNull(); // symlink escaping $HOME
    });
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  test('oversized transcript: only the tail is read, leading partial line dropped', async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'hook-home-'));
    const f = join(fakeHome, 'big.jsonl');
    const filler = JSON.stringify({ type: 'user', message: { role: 'user', content: 'old '.repeat(400) } });
    const lines: string[] = [];
    while (lines.length * (filler.length + 1) < TRANSCRIPT_TAIL_MAX_BYTES * 2) lines.push(filler);
    lines.push(JSON.stringify({ type: 'user', message: { role: 'user', content: 'newest prompt' } }));
    writeFileSync(f, lines.join('\n') + '\n');
    await withEnv({ HOME: fakeHome }, () => {
      const tail = readTranscriptTail(f, { maxTurns: 2 });
      expect(tail).not.toBeNull();
      expect(tail!.turns[tail!.turns.length - 1].text).toBe('newest prompt');
    });
    rmSync(fakeHome, { recursive: true, force: true });
  });

  test('real transcript under the real $HOME parses (fixture copied under $HOME)', () => {
    // The fixture lives in the repo (under $HOME on dev machines). Guard: if
    // the repo is outside $HOME (CI), copy it under $HOME first.
    const home = homedir();
    let path = FIXTURE;
    let cleanup: string | null = null;
    if (!FIXTURE.startsWith(home)) {
      const dir = mkdtempSync(join(home, '.hook-adapters-test-'));
      path = join(dir, 'hook-transcript.jsonl');
      writeFileSync(path, readFileSync(FIXTURE));
      cleanup = dir;
    }
    const tail = readTranscriptTail(path, { maxTurns: 8 });
    expect(tail).not.toBeNull();
    expect(tail!.injectedBlocks).toHaveLength(2);
    if (cleanup) rmSync(cleanup, { recursive: true, force: true });
  });
});

describe('emitHookEnvelope', () => {
  test('exact wire shape (pins Claude Code AND codex-cli 0.136.0 compatibility)', () => {
    const out = emitHookEnvelope('UserPromptSubmit', 'CONTEXT TEXT');
    expect(JSON.parse(out)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: 'CONTEXT TEXT',
      },
    });
  });
});
