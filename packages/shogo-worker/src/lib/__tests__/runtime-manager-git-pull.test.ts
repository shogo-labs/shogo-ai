// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for the GIT-mode branch of `WorkerRuntimeManager.maybeAutoPull`.
 *
 * Strategy:
 *   - Mock `../git-cloner` so `cloneProject()` doesn't actually spawn git.
 *   - Mock `globalThis.fetch` for the `.shogo/` SQLite top-up pass and
 *     the manifest endpoint.
 *   - Assert that:
 *       * a fresh project triggers `cloneProject()`
 *       * the `.shogo/` top-up issues a manifest+download for only those entries
 *       * a populated `.git/` dir skips re-clone
 *       * cloneProject failure flips the mode to 'files' and runs the
 *         file-transport fallback
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ─── git-cloner fakes injected via `autoPull.gitOps` ────────────────
type CloneCall = { apiUrl: string; apiKey: string; projectId: string; localDir: string; shallow?: boolean };
const cloneCalls: CloneCall[] = [];
let cloneShouldThrow = false;
const gitOps = {
  cloneProject: async (opts: CloneCall) => {
    cloneCalls.push(opts);
    if (cloneShouldThrow) throw new Error('simulated clone failure');
    mkdirSync(join(opts.localDir, '.git'), { recursive: true });
    writeFileSync(join(opts.localDir, 'AGENTS.md'), 'AGENT');
    return { commitSha: 'deadbeef' };
  },
  gitIsAvailable: async () => true,
  isGitRepo: (dir: string) => existsSync(join(dir, '.git')),
};

// ─── fetch shim ────────────────────────────────────────────────────
let scriptedFetch: typeof fetch | null = null;
const originalFetch = globalThis.fetch;
beforeEach(() => {
  cloneCalls.length = 0;
  cloneShouldThrow = false;
  globalThis.fetch = ((input: any, init?: RequestInit) => {
    if (!scriptedFetch) throw new Error('no scripted fetch set');
    return scriptedFetch(input, init);
  }) as any;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  scriptedFetch = null;
});

function scriptShogoTopup(files: Array<{ path: string; content: string }>) {
  return (async (input: any, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/workspace/manifest')) {
      return new Response(
        JSON.stringify({
          ok: true,
          projectId: 'p',
          source: 's3',
          generatedAt: '',
          files: files.map((f) => ({ path: f.path, size: f.content.length, lastModified: null, etag: null })),
        }),
        { status: 200 },
      );
    }
    if (url.includes('/s3/presign')) {
      const body = JSON.parse((init?.body as string) || '{}') as { files: Array<{ path: string; action: string }> };
      return new Response(
        JSON.stringify({
          ok: true,
          urls: body.files.map((f) => ({ path: f.path, action: f.action, url: `https://dl.test/${encodeURIComponent(f.path)}` })),
        }),
        { status: 200 },
      );
    }
    if (url.startsWith('https://dl.test/')) {
      const path = decodeURIComponent(url.slice('https://dl.test/'.length));
      const file = files.find((f) => f.path === path);
      return file
        ? new Response(file.content, { status: 200 })
        : new Response('not found', { status: 404 });
    }
    return new Response('unhandled', { status: 500 });
  }) as unknown as typeof fetch;
}

describe('WorkerRuntimeManager auto-pull (git mode)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wrm-git-pull-'));
  });
  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('clones via git when git is available and the dir is empty', async () => {
    const { WorkerRuntimeManager } = await import('../runtime-manager.ts');
    scriptedFetch = scriptShogoTopup([]); // no .shogo entries
    const mgr = new WorkerRuntimeManager({
      autoPull: { enabled: true, projectsDir: dir, watch: false, useGit: true, gitOps },
    });
    const result = await mgr.ensurePulled('proj-g1', {
      cloudUrl: 'https://api.test',
      apiKey: 'shogo_sk_x',
    });

    expect(result.projectDir).toBe(join(dir, 'proj-g1'));
    expect(cloneCalls.length).toBe(1);
    expect(cloneCalls[0]!.projectId).toBe('proj-g1');
    expect(cloneCalls[0]!.localDir).toBe(join(dir, 'proj-g1'));
    expect(cloneCalls[0]!.shallow).toBe(true);
    // The stub created AGENTS.md.
    expect(existsSync(join(dir, 'proj-g1', 'AGENTS.md'))).toBe(true);
  });

  it('downloads .shogo/* via the file transport after a successful git clone', async () => {
    const { WorkerRuntimeManager } = await import('../runtime-manager.ts');
    scriptedFetch = scriptShogoTopup([
      { path: '.shogo/db.sqlite', content: 'SQLITE-DB' },
      { path: '.shogo/snapshots/2024.sqlite', content: 'SNAP' },
      // non-.shogo entries in the manifest must be ignored by the top-up.
      { path: 'src/App.tsx', content: 'APP' },
    ]);
    const mgr = new WorkerRuntimeManager({
      autoPull: { enabled: true, projectsDir: dir, watch: false, useGit: true, gitOps },
    });
    await mgr.ensurePulled('proj-g2', {
      cloudUrl: 'https://api.test',
      apiKey: 'shogo_sk_x',
    });

    expect(cloneCalls.length).toBe(1);
    const target = join(dir, 'proj-g2');
    // .shogo/* was downloaded via the file transport.
    expect(existsSync(join(target, '.shogo', 'db.sqlite'))).toBe(true);
    expect(existsSync(join(target, '.shogo', 'snapshots', '2024.sqlite'))).toBe(true);
    // src/App.tsx was NOT downloaded — git handles that.
    expect(existsSync(join(target, 'src', 'App.tsx'))).toBe(false);
  });

  it('skips re-cloning when the local dir already has a .git/', async () => {
    const { WorkerRuntimeManager } = await import('../runtime-manager.ts');
    const target = join(dir, 'proj-g3');
    mkdirSync(join(target, '.git'), { recursive: true });
    writeFileSync(join(target, 'AGENTS.md'), 'existing');

    scriptedFetch = scriptShogoTopup([]); // top-up still fires but is a no-op
    const mgr = new WorkerRuntimeManager({
      autoPull: { enabled: true, projectsDir: dir, watch: false, useGit: true, gitOps },
    });
    await mgr.ensurePulled('proj-g3', {
      cloudUrl: 'https://api.test',
      apiKey: 'shogo_sk_x',
    });

    expect(cloneCalls.length).toBe(0);
    // Existing content is preserved.
    expect(existsSync(join(target, 'AGENTS.md'))).toBe(true);
  });

  it('falls back to file transport when cloneProject throws', async () => {
    const { WorkerRuntimeManager } = await import('../runtime-manager.ts');
    cloneShouldThrow = true;
    // Manifest serves a real file so the fallback downloadAll can produce something.
    scriptedFetch = scriptShogoTopup([
      { path: 'fallback.txt', content: 'FROM-FILES' },
    ]);
    const warnings: string[] = [];
    const logger = {
      log: () => {},
      warn: (...args: any[]) => warnings.push(args.join(' ')),
      error: () => {},
    };

    const mgr = new WorkerRuntimeManager({
      autoPull: { enabled: true, projectsDir: dir, watch: false, useGit: true, logger, gitOps },
    });
    await mgr.ensurePulled('proj-g4', {
      cloudUrl: 'https://api.test',
      apiKey: 'shogo_sk_x',
    });

    expect(cloneCalls.length).toBe(1);
    expect(warnings.some((w) => w.includes('git clone failed'))).toBe(true);
    expect(existsSync(join(dir, 'proj-g4', 'fallback.txt'))).toBe(true);
  });

  it('uses file transport (not git) when useGit=false', async () => {
    const { WorkerRuntimeManager } = await import('../runtime-manager.ts');
    scriptedFetch = scriptShogoTopup([
      { path: 'plain.txt', content: 'P' },
    ]);
    const mgr = new WorkerRuntimeManager({
      autoPull: { enabled: true, projectsDir: dir, watch: false, useGit: false, gitOps },
    });
    await mgr.ensurePulled('proj-g5', {
      cloudUrl: 'https://api.test',
      apiKey: 'shogo_sk_x',
    });
    expect(cloneCalls.length).toBe(0);
    expect(existsSync(join(dir, 'proj-g5', 'plain.txt'))).toBe(true);
  });
});
