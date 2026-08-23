/**
 * Tests for the additive session-receipts JSONL (session-receipts.ts).
 * Runs under a temp GBRAIN_HOME so nothing touches ~/.gbrain.
 */

import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withEnv } from './helpers/with-env.ts';
import {
  appendSessionReceipt,
  readSessionReceiptsTail,
  sessionReceiptsPath,
} from '../src/core/context/hook-heartbeat.ts';

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), 'gbrain-receipts-'));
}

describe('session-receipts', () => {
  test('append then read round-trips the full entry', async () => {
    const home = tempHome();
    try {
      await withEnv({ GBRAIN_HOME: home }, async () => {
        await appendSessionReceipt({
          session_id: 'sess-1',
          harness: 'claude-code',
          corpus_path: '/tmp/sess-1.txt',
          content_hash: 'abc123',
          turn_count: 4,
          workspace_root: '/repo',
          tool_calls_json: '[{"name":"bash","input":{"command":"pytest"}}]',
          secret_scan_ok: true,
        });
        const tail = await readSessionReceiptsTail(10);
        expect(tail.length).toBe(1);
        expect(tail[0].session_id).toBe('sess-1');
        expect(tail[0].harness).toBe('claude-code');
        expect(tail[0].content_hash).toBe('abc123');
        expect(tail[0].secret_scan_ok).toBe(true);
        expect(typeof tail[0].ts).toBe('string');
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('multiple appends keep oldest → newest order, tail(n) takes the last n', async () => {
    const home = tempHome();
    try {
      await withEnv({ GBRAIN_HOME: home }, async () => {
        for (const id of ['a', 'b', 'c']) {
          await appendSessionReceipt({
            session_id: id,
            harness: 'codex',
            corpus_path: `/tmp/${id}.txt`,
            content_hash: id,
            turn_count: 1,
            workspace_root: '/repo',
            tool_calls_json: '[{"name":"bash","input":{"command":"pytest"}}]',
            secret_scan_ok: true,
          });
        }
        const tail = await readSessionReceiptsTail(2);
        expect(tail.map((e) => e.session_id)).toEqual(['b', 'c']);
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('secret_scan_ok:false is preserved (the scan_unavailable degrade signal)', async () => {
    const home = tempHome();
    try {
      await withEnv({ GBRAIN_HOME: home }, async () => {
        await appendSessionReceipt({
          session_id: 'sess-unscanned',
          harness: 'opencode',
          corpus_path: '/tmp/sess-unscanned.txt',
          content_hash: 'def456',
          turn_count: 2,
          workspace_root: '/repo',
          tool_calls_json: '[]',
          secret_scan_ok: false,
        });
        const tail = await readSessionReceiptsTail(1);
        expect(tail[0].secret_scan_ok).toBe(false);
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('reading before any append returns an empty array, never throws', async () => {
    const home = tempHome();
    try {
      await withEnv({ GBRAIN_HOME: home }, async () => {
        expect(await readSessionReceiptsTail(10)).toEqual([]);
        expect(await sessionReceiptsPath()).toContain('session-receipts.jsonl');
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
