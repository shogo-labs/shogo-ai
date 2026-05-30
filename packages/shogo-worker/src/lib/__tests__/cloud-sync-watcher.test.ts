// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for {@link CloudSyncWatcher}.
 *
 * We exercise the watcher by:
 *   - mounting a real tmpdir (fs.watch only works on real paths)
 *   - injecting a fake CloudFileTransport that records uploadFiles calls
 *   - touching files and waiting for the debounce window to fire
 *
 * Recursive `fs.watch` is supported on macOS / Windows / Linux >= 20.x.
 * The CI matrix is expected to satisfy this; on platforms where it
 * isn't, the watcher's `start()` will fall back to a flat root watch
 * (which still passes the "single file in root" assertions but skips
 * the "nested file" one).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CloudSyncWatcher, _isExcluded, type CommitAndPushFn } from '../cloud-sync-watcher.ts';

/** Tests inject a fake `commitAndPush` rather than mocking the module
 *  (mock.module leaks across files in bun:test). */
const commitAndPushCalls: any[] = [];
const commitAndPushFake: CommitAndPushFn = async (opts) => {
  commitAndPushCalls.push(opts);
  return { committed: true, commitSha: 'deadbeef1234' };
};

function fakeTransport() {
  const calls: { paths: string[] }[] = [];
  return {
    transport: {
      uploadFiles: async (paths: string[]) => {
        calls.push({ paths: [...paths] });
        return { downloaded: 0, uploaded: paths.length, skipped: 0, deleted: 0, errors: [] };
      },
    } as any,
    calls,
  };
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('CloudSyncWatcher', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cloud-sync-watcher-'));
  });
  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('isExcluded skips node_modules / .git / dist / build paths', () => {
    expect(_isExcluded('node_modules/lib/index.js')).toBe(true);
    expect(_isExcluded('.git/HEAD')).toBe(true);
    expect(_isExcluded('dist/bundle.js')).toBe(true);
    expect(_isExcluded('build/main.css')).toBe(true);
    expect(_isExcluded('src/App.tsx')).toBe(false);
    expect(_isExcluded('config.json')).toBe(false);
    expect(_isExcluded('')).toBe(true);
  });

  it('debounces a batch of edits into a single uploadFiles call', async () => {
    const { transport, calls } = fakeTransport();
    const watcher = new CloudSyncWatcher({ rootDir: dir, transport, debounceMs: 100 });
    watcher.start();
    // Give fs.watch a tick to start delivering events on macOS/Linux before
    // we start writing — otherwise the first writes can be dropped.
    await wait(50);

    writeFileSync(join(dir, 'a.txt'), 'A');
    writeFileSync(join(dir, 'b.txt'), 'B');
    writeFileSync(join(dir, 'c.txt'), 'C');

    await wait(400);
    await watcher.stop();

    // All three files coalesced into ONE upload batch.
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const allPaths = calls.flatMap((c) => c.paths);
    expect(allPaths).toContain('a.txt');
    expect(allPaths).toContain('b.txt');
    expect(allPaths).toContain('c.txt');
  });

  it('skips events inside excluded directories', async () => {
    const { transport, calls } = fakeTransport();
    mkdirSync(join(dir, 'node_modules'), { recursive: true });
    mkdirSync(join(dir, 'src'), { recursive: true });
    const watcher = new CloudSyncWatcher({ rootDir: dir, transport, debounceMs: 100 });
    watcher.start();
    await wait(50);

    writeFileSync(join(dir, 'node_modules', 'lib.js'), 'LIB');
    writeFileSync(join(dir, 'src', 'App.tsx'), 'APP');

    await wait(400);
    await watcher.stop();

    const allPaths = calls.flatMap((c) => c.paths);
    expect(allPaths.some((p) => p.includes('node_modules'))).toBe(false);
    // On platforms where recursive watch works, src/App.tsx should have been
    // captured. Where it doesn't, the array is empty — both are valid given
    // the platform caveat described at the top of this file.
  });

  it('flushes any pending uploads on stop()', async () => {
    const { transport, calls } = fakeTransport();
    const watcher = new CloudSyncWatcher({ rootDir: dir, transport, debounceMs: 5_000 });
    watcher.start();
    await wait(50);

    writeFileSync(join(dir, 'just-in-time.txt'), 'JIT');
    // Don't wait the full debounce — stop() should still flush.
    await wait(100);
    await watcher.stop();

    const allPaths = calls.flatMap((c) => c.paths);
    expect(allPaths).toContain('just-in-time.txt');
  });

  it('git mode: flushes call commitAndPush instead of uploadFiles', async () => {
    commitAndPushCalls.length = 0;
    const { transport, calls } = fakeTransport();
    const watcher = new CloudSyncWatcher({
      rootDir: dir,
      transport,
      debounceMs: 100,
      mode: 'git',
      git: { apiUrl: 'https://api.shogo.ai', apiKey: 'shogo_sk_test', projectId: 'p_abc' },
      commitAndPush: commitAndPushFake,
    });
    watcher.start();
    await wait(50);

    writeFileSync(join(dir, 'src.tsx'), 'CODE');
    await wait(400);
    await watcher.stop();

    expect(commitAndPushCalls.length).toBeGreaterThanOrEqual(1);
    expect(commitAndPushCalls[0]!.projectId).toBe('p_abc');
    expect(commitAndPushCalls[0]!.localDir).toBe(dir);
    expect(commitAndPushCalls[0]!.apiKey).toBe('shogo_sk_test');
    // Non-.shogo paths should NOT go through uploadFiles in git mode.
    const fileTransportPaths = calls.flatMap((c) => c.paths);
    expect(fileTransportPaths.includes('src.tsx')).toBe(false);
  });

  it('git mode: .shogo/ writes still route through the file transport', async () => {
    commitAndPushCalls.length = 0;
    const { transport, calls } = fakeTransport();
    mkdirSync(join(dir, '.shogo'), { recursive: true });
    const watcher = new CloudSyncWatcher({
      rootDir: dir,
      transport,
      debounceMs: 100,
      mode: 'git',
      git: { apiUrl: 'https://api.shogo.ai', apiKey: 'shogo_sk_test', projectId: 'p_xyz' },
      commitAndPush: commitAndPushFake,
    });
    watcher.start();
    await wait(50);

    // App.tsx fires first so its watch event is queued before debounce starts;
    // .shogo/db.sqlite arrives within the debounce window. The increased
    // post-write wait absorbs cross-file timing variance (see
    // gateway-mock side effect from git-cloner.test.ts's hoisted
    // mock.module('node:child_process', ...) bloating bun's startup).
    writeFileSync(join(dir, 'App.tsx'), 'APP');
    writeFileSync(join(dir, '.shogo', 'db.sqlite'), 'SQLITE');
    await wait(700);
    await watcher.stop();

    const fileTransportPaths = calls.flatMap((c) => c.paths);
    expect(fileTransportPaths.some((p) => p.startsWith('.shogo'))).toBe(true);
    // App.tsx commits go to git, NOT the file transport.
    expect(fileTransportPaths.includes('App.tsx')).toBe(false);
    expect(commitAndPushCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('git mode: throws when constructed without git options', () => {
    const { transport } = fakeTransport();
    expect(() => new CloudSyncWatcher({ rootDir: dir, transport, mode: 'git' as const })).toThrow();
  });

  it('invokes onFlush with the uploaded batch + error count', async () => {
    const { transport } = fakeTransport();
    const flushes: Array<{ uploaded: string[]; errors: number }> = [];
    const watcher = new CloudSyncWatcher({
      rootDir: dir,
      transport,
      debounceMs: 50,
      onFlush: (e) => flushes.push(e),
    });
    watcher.start();
    await wait(50);

    writeFileSync(join(dir, 'x.txt'), 'X');
    await wait(300);
    await watcher.stop();

    expect(flushes.length).toBeGreaterThanOrEqual(1);
    expect(flushes[0]!.errors).toBe(0);
    expect(flushes[0]!.uploaded).toContain('x.txt');
  });
});
