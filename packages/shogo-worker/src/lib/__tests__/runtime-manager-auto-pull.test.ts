// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for the `WorkerRuntimeManager` auto-pull hook (Chunk E of the
 * project-pull feature).
 *
 * We exercise the path via the public `ensurePulled(projectId, config)`
 * entry point so we don't have to spawn an actual agent-runtime binary.
 * The internal CloudFileTransport is exercised end-to-end against a fake
 * `fetch` that scripts the manifest + presign + download responses.
 *
 * Coverage:
 *   - autoPull disabled → no clone, projectDir not injected
 *   - autoPull enabled + empty target dir → clone runs, projectDir set
 *   - autoPull enabled + populated target dir → no clone (skip)
 *   - autoPull enabled + cloud failure → soft-fail, projectDir still set
 *   - second call for same projectId is short-circuited (idempotent)
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// We need to inject a fake fetch into the global so the SDK's
// CloudFileTransport picks it up.
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
        JSON.stringify({
          ok: true,
          urls: body.files.map((f) => ({ path: f.path, action: f.action, url: `https://dl.test/${f.path}` })),
        }),
        { status: 200 },
      );
    }
    if (url.startsWith('https://dl.test/')) {
      const path = url.slice('https://dl.test/'.length);
      const file = files.find((f) => f.path === path);
      if (!file) return new Response('not found', { status: 404 });
      return new Response(file.content, { status: 200 });
    }
    return new Response('unhandled', { status: 500 });
  }) as unknown as typeof fetch;
}

describe('WorkerRuntimeManager auto-pull', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wrm-auto-pull-'));
  });
  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('throws a loud, multi-line error when auto-pull is disabled and no workspace was pre-pulled', async () => {
    const { WorkerRuntimeManager } = await import('../runtime-manager.ts');
    scriptedFetch = scriptManifest([{ path: 'a.ts', size: 1, content: 'A' }]);

    const mgr = new WorkerRuntimeManager({
      autoPull: { enabled: false, projectsDir: dir },
    });

    let caught: Error | null = null;
    try {
      await mgr.ensurePulled('proj-1', {
        cloudUrl: 'https://api.test',
        apiKey: 'shogo_sk_x',
      });
    } catch (err: any) {
      caught = err;
    }

    expect(caught).not.toBeNull();
    const msg = caught!.message;
    // Multi-line so a future debugger reading the worker's stderr can
    // see the full menu of fixes without log archaeology.
    expect(msg.split('\n').length).toBeGreaterThan(5);
    expect(msg).toContain('auto-pull was disabled');
    expect(msg).toContain('--no-auto-pull');
    expect(msg).toContain('shogo project pull');
    expect(msg).toContain('--projects-dir');
    expect(msg).toContain('SHOGO_PROJECTS_DIR');
    expect(msg).toContain(join(dir, 'proj-1'));
    expect(msg).toContain('https://shogo.ai/docs/self-hosted-worker');

    // The ask was loud-failure, not silent-mkdir: the dir must NOT have
    // been touched (so a follow-up `shogo project pull` lands cleanly).
    expect(existsSync(join(dir, 'proj-1'))).toBe(false);
  });

  it('honours a pre-pulled workspace when auto-pull is disabled', async () => {
    const { WorkerRuntimeManager } = await import('../runtime-manager.ts');
    // No scripted fetch — the manager must NOT try to clone.
    scriptedFetch = (async () => {
      throw new Error('auto-pull is disabled, no fetch should fire');
    }) as unknown as typeof fetch;

    const target = join(dir, 'proj-prepulled');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'AGENTS.md'), 'pre-pulled by `shogo project pull`');

    const mgr = new WorkerRuntimeManager({
      autoPull: { enabled: false, projectsDir: dir },
    });
    const result = await mgr.ensurePulled('proj-prepulled', {
      cloudUrl: 'https://api.test',
      apiKey: 'shogo_sk_x',
    });

    expect(result.projectDir).toBe(target);
    expect(readFileSync(join(target, 'AGENTS.md'), 'utf-8')).toBe(
      'pre-pulled by `shogo project pull`',
    );
  });

  it('throws when no autoPull config and no caller-provided projectDir', async () => {
    const { WorkerRuntimeManager } = await import('../runtime-manager.ts');

    const mgr = new WorkerRuntimeManager({});

    let caught: Error | null = null;
    try {
      await mgr.ensurePulled('proj-x', {
        cloudUrl: 'https://api.test',
        apiKey: 'shogo_sk_x',
      });
    } catch (err: any) {
      caught = err;
    }

    expect(caught).not.toBeNull();
    expect(caught!.message).toContain('without an `autoPull` config');
  });

  it('honours an existing caller-provided projectDir without touching autoPull', async () => {
    const { WorkerRuntimeManager } = await import('../runtime-manager.ts');
    scriptedFetch = (async () => {
      throw new Error('caller-provided projectDir — no fetch should fire');
    }) as unknown as typeof fetch;

    const target = join(dir, 'desktop-managed');
    mkdirSync(target, { recursive: true });

    const mgr = new WorkerRuntimeManager({
      // autoPull intentionally omitted — desktop adapter case.
    });
    const result = await mgr.ensurePulled('proj-desktop', {
      cloudUrl: 'https://api.test',
      apiKey: 'shogo_sk_x',
      projectDir: target,
    });

    expect(result.projectDir).toBe(target);
  });

  it('clones into <projectsDir>/<projectId> when the dir is empty', async () => {
    const { WorkerRuntimeManager } = await import('../runtime-manager.ts');
    scriptedFetch = scriptManifest([
      { path: 'config.json', size: 2, content: '{}' },
      { path: 'AGENTS.md', size: 5, content: 'AGENT' },
    ]);

    const mgr = new WorkerRuntimeManager({
      autoPull: { enabled: true, projectsDir: dir, watch: false, useGit: false },
    });
    const result = await mgr.ensurePulled('proj-2', {
      cloudUrl: 'https://api.test',
      apiKey: 'shogo_sk_x',
    });

    expect(result.projectDir).toBe(join(dir, 'proj-2'));
    expect(existsSync(join(dir, 'proj-2', 'config.json'))).toBe(true);
    expect(readFileSync(join(dir, 'proj-2', 'config.json'), 'utf-8')).toBe('{}');
    expect(readFileSync(join(dir, 'proj-2', 'AGENTS.md'), 'utf-8')).toBe('AGENT');
  });

  it('skips clone when the target directory already has files', async () => {
    const { WorkerRuntimeManager } = await import('../runtime-manager.ts');
    const target = join(dir, 'proj-3');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'config.json'), '{"existing": true}');

    // Set the manifest to return a different file — if clone runs, it would
    // overwrite. Use atomic-replace semantics from downloadAll() so we'd
    // see the existing file blown away. We assert it's preserved.
    scriptedFetch = scriptManifest([{ path: 'fresh.md', size: 5, content: 'NEW' }]);

    const mgr = new WorkerRuntimeManager({
      autoPull: { enabled: true, projectsDir: dir, watch: false, useGit: false },
    });
    const result = await mgr.ensurePulled('proj-3', {
      cloudUrl: 'https://api.test',
      apiKey: 'shogo_sk_x',
    });

    expect(result.projectDir).toBe(target);
    expect(existsSync(join(target, 'fresh.md'))).toBe(false);
    expect(readFileSync(join(target, 'config.json'), 'utf-8')).toBe('{"existing": true}');
  });

  it('soft-fails when the cloud is unreachable, still sets projectDir', async () => {
    const { WorkerRuntimeManager } = await import('../runtime-manager.ts');
    // Manifest returns 500 — autoPull should swallow and continue.
    scriptedFetch = (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch;

    const warnings: string[] = [];
    const logger = {
      log: () => {},
      warn: (...args: any[]) => warnings.push(args.join(' ')),
      error: () => {},
    };
    const mgr = new WorkerRuntimeManager({
      autoPull: { enabled: true, projectsDir: dir, watch: false, logger, useGit: false },
    });
    const result = await mgr.ensurePulled('proj-4', {
      cloudUrl: 'https://api.test',
      apiKey: 'shogo_sk_x',
    });

    expect(result.projectDir).toBe(join(dir, 'proj-4'));
    expect(warnings.some((w) => w.includes('auto-pull: failed for proj-4'))).toBe(true);
  });

  it('is idempotent — second call short-circuits the manifest fetch', async () => {
    const { WorkerRuntimeManager } = await import('../runtime-manager.ts');
    let manifestRequests = 0;
    scriptedFetch = (async (input: any, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('/workspace/manifest')) {
        manifestRequests++;
        return new Response(JSON.stringify({ ok: true, files: [], source: 's3', generatedAt: '' }), { status: 200 });
      }
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;

    const mgr = new WorkerRuntimeManager({
      autoPull: { enabled: true, projectsDir: dir, watch: false, useGit: false },
    });
    const config = { cloudUrl: 'https://api.test', apiKey: 'shogo_sk_x' };
    await mgr.ensurePulled('proj-5', config);
    await mgr.ensurePulled('proj-5', config);
    await mgr.ensurePulled('proj-5', config);

    expect(manifestRequests).toBe(1);
  });
});
