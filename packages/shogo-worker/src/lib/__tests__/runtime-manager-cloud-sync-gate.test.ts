// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for `WorkerRuntimeManager.shouldDeferToCloudSync` — the gate that
 * decides whether a spawned runtime gets `SHOGO_CLOUD_SYNC=1` (skip its own
 * S3Sync + checkpoint inserts because the worker's CloudSyncWatcher owns the
 * push back to cloud).
 *
 * The gate must be true ONLY for projects that were actually auto-pulled, not
 * for every project when `autoPull.enabled` is set globally — otherwise a
 * project served from a pre-seeded / template `projectDir` (which has no
 * watcher) would wrongly suppress its own checkpoints.
 *
 *   bun test packages/shogo-worker/src/lib/__tests__/runtime-manager-cloud-sync-gate.test.ts
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let scriptedFetch: typeof fetch | null = null;
const originalFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = ((input: any, init?: RequestInit) => {
    if (!scriptedFetch) throw new Error('no scripted fetch set');
    return scriptedFetch(input, init);
  }) as any;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  scriptedFetch = null;
});

/** Manifest + presign + download responses for a files-mode pull. */
function scriptManifest(files: Array<{ path: string; size: number; content: string }>) {
  return (async (input: any, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/workspace/manifest')) {
      return new Response(
        JSON.stringify({
          ok: true,
          projectId: 'p',
          source: 's3',
          generatedAt: '',
          files: files.map((f) => ({ path: f.path, size: f.size, lastModified: null, etag: null })),
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (url.includes('/s3/presign')) {
      const body = JSON.parse((init?.body as string) || '{}') as { files: Array<{ path: string; action: string }> };
      return new Response(
        JSON.stringify({ ok: true, urls: body.files.map((f) => ({ path: f.path, action: f.action, url: `https://dl.test/${f.path}` })) }),
        { status: 200 },
      );
    }
    if (url.startsWith('https://dl.test/')) {
      const path = url.slice('https://dl.test/'.length);
      const file = files.find((f) => f.path === path);
      return file ? new Response(file.content, { status: 200 }) : new Response('nf', { status: 404 });
    }
    return new Response('unhandled', { status: 500 });
  }) as unknown as typeof fetch;
}

describe('WorkerRuntimeManager.shouldDeferToCloudSync', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wrm-cloud-sync-gate-'));
  });
  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('is true only for a project that was actually auto-pulled', async () => {
    const { WorkerRuntimeManager } = await import('../runtime-manager.ts');
    scriptedFetch = scriptManifest([{ path: 'a.ts', size: 1, content: 'A' }]);

    const mgr = new WorkerRuntimeManager({
      autoPull: { enabled: true, projectsDir: dir, watch: false, useGit: false },
    });

    // Before any pull: not active.
    expect(mgr.shouldDeferToCloudSync('proj-pulled')).toBe(false);

    await mgr.ensurePulled('proj-pulled', { cloudUrl: 'https://api.test', apiKey: 'shogo_sk_x' });

    // Pulled → defer to cloud sync.
    expect(mgr.shouldDeferToCloudSync('proj-pulled')).toBe(true);
    // A different, never-pulled project → keep its own sync/checkpoints.
    expect(mgr.shouldDeferToCloudSync('proj-untouched')).toBe(false);
  });

  it('is false for a pre-seeded projectDir even when autoPull is enabled (no watcher)', async () => {
    const { WorkerRuntimeManager } = await import('../runtime-manager.ts');
    // No fetch should fire — the caller-provided projectDir short-circuits pull.
    scriptedFetch = (async () => { throw new Error('no fetch expected'); }) as unknown as typeof fetch;

    const target = join(dir, 'pre-seeded');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'package.json'), '{}');

    const mgr = new WorkerRuntimeManager({
      autoPull: { enabled: true, projectsDir: dir, watch: false, useGit: false },
    });
    await mgr.ensurePulled('pre-seeded', { cloudUrl: 'https://api.test', apiKey: 'shogo_sk_x', projectDir: target });

    // maybeAutoPull returned early (projectDir existed) so the project was
    // never added to pulledProjects → it keeps its own checkpoint behavior.
    expect(mgr.shouldDeferToCloudSync('pre-seeded')).toBe(false);
  });

  it('is false when autoPull is disabled entirely', async () => {
    const { WorkerRuntimeManager } = await import('../runtime-manager.ts');
    const mgr = new WorkerRuntimeManager({ autoPull: { enabled: false, projectsDir: dir } });
    expect(mgr.shouldDeferToCloudSync('anything')).toBe(false);
  });
});
