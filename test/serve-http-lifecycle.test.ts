import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'events';
import { waitForHttpServerLifecycle } from '../src/commands/serve-http.ts';

class FakeHttpServer extends EventEmitter {
  listening = true;
  closeCalls = 0;

  close(callback?: (error?: Error) => void): this {
    this.closeCalls++;
    this.listening = false;
    queueMicrotask(() => {
      callback?.();
      this.emit('close');
    });
    return this;
  }
}

describe('HTTP server lifecycle', () => {
  test('waits for shared cleanup to close the server', async () => {
    const server = new FakeHttpServer();
    const signals = new EventEmitter();
    let cleanup: (() => Promise<void>) | undefined;
    let deregistered = false;
    let resolved = false;

    const lifecycle = waitForHttpServerLifecycle(server, {
      signals,
      register(_name, fn) {
        cleanup = fn;
        return () => { deregistered = true; };
      },
    }).then(() => { resolved = true; });

    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(cleanup).toBeDefined();

    await cleanup!();
    await lifecycle;

    expect(server.closeCalls).toBe(1);
    expect(deregistered).toBe(true);
    expect(signals.listenerCount('SIGINT')).toBe(0);
  });

  test('SIGINT closes the server through the same idempotent path', async () => {
    const server = new FakeHttpServer();
    const signals = new EventEmitter();

    const lifecycle = waitForHttpServerLifecycle(server, {
      signals,
      register() {
        return () => {};
      },
    });

    signals.emit('SIGINT');
    await lifecycle;

    expect(server.closeCalls).toBe(1);
  });

  // The shipped hang: `close()` waits for open connections to drain, and an
  // attached admin-SSE stream never drains. A fake whose close() always
  // succeeds on the next microtask cannot observe that, so pin the teardown
  // itself — this is a change-detector for the severing, and the real proof is
  // a spawned-process signal run.
  test('severs live connections so close() cannot block on them', async () => {
    const server = new FakeHttpServer();
    const signals = new EventEmitter();

    const live = { destroyed: false, destroy() { this.destroyed = true; }, once() {} };
    const gone = { destroyed: false, destroy() { this.destroyed = true; }, once(_e: string, cb: () => void) { cb(); } };

    const lifecycle = waitForHttpServerLifecycle(server, {
      signals,
      register() { return () => {}; },
    });

    server.emit('connection', live);
    server.emit('connection', gone); // deregisters itself immediately via 'close'

    signals.emit('SIGINT');
    await lifecycle;

    expect(live.destroyed).toBe(true);
    // Already-closed sockets are dropped from the set, so shutdown does not
    // touch them — destroying a dead socket is harmless but the bookkeeping
    // leaking would not be.
    expect(gone.destroyed).toBe(false);
  });

  // Whichever signal lands first settles the promise; every later one is a
  // no-op. A second settle in a daemon is an unhandled rejection, i.e. a
  // crash-loop. (Note: once settled, the 'error' listener is removed, so a
  // genuinely later server 'error' becomes an uncaughtException — pre-existing
  // behavior, and it degrades to a clean exit(1) via the cleanup pass rather
  // than a silent hang.)
  test.each([
    ['close then close', ['close', 'close'], { resolves: 1, rejects: 0 }],
    ['error then close', ['error', 'close'], { resolves: 0, rejects: 1 }],
  ])('settles exactly once: %s', async (_label, events, expected) => {
    const server = new FakeHttpServer();
    const signals = new EventEmitter();
    let resolves = 0;
    let rejects = 0;

    const lifecycle = waitForHttpServerLifecycle(server, {
      signals,
      register() { return () => {}; },
    }).then(() => { resolves++; }, () => { rejects++; });

    for (const event of events) {
      // Re-emitting after settle would throw for 'error' (no listener left),
      // so only emit what still has a listener — the point is that the SECOND
      // signal cannot settle the promise again.
      if (server.listenerCount(event) > 0) server.emit(event, new Error('boom'));
    }
    await lifecycle;

    expect({ resolves, rejects }).toEqual(expected);
    expect(server.listenerCount('close')).toBe(0);
    expect(server.listenerCount('error')).toBe(0);
    expect(signals.listenerCount('SIGINT')).toBe(0);
  });
});
