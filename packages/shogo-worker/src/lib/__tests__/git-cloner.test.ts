// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for {@link cloneProject}, {@link commitAndPush}, and the
 * support helpers in `lib/git-cloner.ts`.
 *
 * Strategy:
 *   - Mock `node:child_process` so we never actually shell out.
 *   - Capture the argv each call would have run with and assert the
 *     bearer header lives in `-c http.extraHeader=…` rather than the
 *     URL or environment.
 */

import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { EventEmitter } from 'node:events';

interface SpawnInvocation {
  cmd: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

const spawnInvocations: SpawnInvocation[] = [];
type SpawnHandler = (
  inv: SpawnInvocation,
) => { stdout?: string; stderr?: string; exitCode?: number; runError?: Error };
let spawnHandler: SpawnHandler = () => ({ exitCode: 0 });

function makeFakeChild(result: { stdout?: string; stderr?: string; exitCode?: number; runError?: Error }) {
  const child = new EventEmitter() as any;
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr = new EventEmitter();
  child.stderr.setEncoding = () => {};
  child.kill = () => {};
  child.exitCode = null;
  child.signalCode = null;
  // Emit chunks + close asynchronously so callers' on() handlers register first.
  setTimeout(() => {
    if (result.runError) {
      child.emit('error', result.runError);
      return;
    }
    if (result.stdout) child.stdout.emit('data', result.stdout);
    if (result.stderr) child.stderr.emit('data', result.stderr);
    child.exitCode = result.exitCode ?? 0;
    child.emit('close', result.exitCode ?? 0);
  }, 5);
  return child;
}

mock.module('node:child_process', () => ({
  spawn: (cmd: string, args: string[], opts?: any) => {
    const inv: SpawnInvocation = { cmd, args, cwd: opts?.cwd, env: opts?.env };
    spawnInvocations.push(inv);
    const result = spawnHandler(inv);
    return makeFakeChild(result);
  },
  execFile: (cmd: string, args: string[], opts: any, cb: any) => {
    const inv: SpawnInvocation = { cmd, args };
    spawnInvocations.push(inv);
    // probe for `git --version`
    const callback = typeof opts === 'function' ? opts : cb;
    setTimeout(() => callback?.(null, 'git version 2.40.0', ''), 1);
  },
}));

const { buildGitUrl, cloneProject, commitAndPush, gitIsAvailable, isGitRepo, gitFetchAndReset } =
  await import('../git-cloner.ts');

beforeEach(() => {
  spawnInvocations.length = 0;
  spawnHandler = () => ({ exitCode: 0 });
});

describe('buildGitUrl', () => {
  it('joins cloud url and project id with a trailing /git', () => {
    expect(buildGitUrl('https://api.shogo.ai', 'p_abc')).toBe('https://api.shogo.ai/api/projects/p_abc/git');
  });
  it('strips trailing slashes from the cloud url', () => {
    expect(buildGitUrl('https://api.shogo.ai///', 'p_abc')).toBe('https://api.shogo.ai/api/projects/p_abc/git');
  });
});

describe('gitIsAvailable', () => {
  it('returns true when git --version succeeds', async () => {
    const ok = await gitIsAvailable(true);
    expect(ok).toBe(true);
  });
});

describe('cloneProject', () => {
  it('uses http.extraHeader for the bearer token (never in argv URL)', async () => {
    spawnHandler = (inv) => {
      if (inv.args[0] === 'rev-parse') return { stdout: 'abc123\n' };
      return { exitCode: 0 };
    };
    const res = await cloneProject({
      apiUrl: 'https://api.shogo.ai',
      apiKey: 'shogo_sk_secret',
      projectId: 'p_demo',
      localDir: '/tmp/test-clone',
    });
    expect(res.commitSha).toBe('abc123');

    const cloneInv = spawnInvocations.find((i) => i.args.includes('clone'));
    expect(cloneInv).toBeDefined();
    expect(cloneInv!.args).toContain('-c');
    expect(cloneInv!.args.some((a) => a.startsWith('http.extraHeader=Authorization: Bearer'))).toBe(true);
    // URL should NOT carry the secret.
    const urlArg = cloneInv!.args.find((a) => a.startsWith('https://'))!;
    expect(urlArg.includes('shogo_sk_secret')).toBe(false);
    expect(urlArg).toBe('https://api.shogo.ai/api/projects/p_demo/git');
    // Shallow by default.
    expect(cloneInv!.args.includes('--depth=1')).toBe(true);
  });

  it('throws when the target dir already has a .git', async () => {
    // existsSync uses real fs; create a tmp dir with a .git.
    const { mkdtempSync, mkdirSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'git-cloner-'));
    try {
      mkdirSync(join(dir, '.git'));
      await expect(
        cloneProject({
          apiUrl: 'https://api.shogo.ai',
          apiKey: 'shogo_sk_secret',
          projectId: 'p_demo',
          localDir: dir,
        }),
      ).rejects.toThrow(/\.git already exists/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('shallow=false omits --depth=1', async () => {
    spawnHandler = (inv) => {
      if (inv.args[0] === 'rev-parse') return { stdout: 'abc123\n' };
      return { exitCode: 0 };
    };
    await cloneProject({
      apiUrl: 'https://api.shogo.ai',
      apiKey: 'k',
      projectId: 'p',
      localDir: '/tmp/never',
      shallow: false,
    });
    const cloneInv = spawnInvocations.find((i) => i.args.includes('clone'))!;
    expect(cloneInv.args.includes('--depth=1')).toBe(false);
  });

  it('rejects when git exits non-zero', async () => {
    spawnHandler = () => ({ exitCode: 128, stderr: 'fatal: repository not found' });
    await expect(
      cloneProject({
        apiUrl: 'https://api.shogo.ai',
        apiKey: 'k',
        projectId: 'p',
        localDir: '/tmp/never',
      }),
    ).rejects.toThrow(/exited with code 128/);
  });
});

describe('commitAndPush', () => {
  it('reports committed=false when there is nothing to commit', async () => {
    spawnHandler = (inv) => {
      // `git diff --cached --quiet` exits 0 when nothing is staged.
      if (inv.args[0] === 'diff') return { exitCode: 0 };
      return { exitCode: 0 };
    };
    const res = await commitAndPush({
      apiUrl: 'https://api.shogo.ai',
      apiKey: 'shogo_sk_test',
      projectId: 'p_clean',
      localDir: '/tmp/never',
      message: 'no-op',
    });
    expect(res.committed).toBe(false);
    expect(res.commitSha).toBeUndefined();
    // We should not have pushed.
    expect(spawnInvocations.some((i) => i.args[0] === 'push')).toBe(false);
  });

  it('commits + pushes when there are staged changes', async () => {
    spawnHandler = (inv) => {
      if (inv.args[0] === 'diff') {
        // Non-zero exit = "diff present" = something to commit.
        return { exitCode: 1 };
      }
      if (inv.args[0] === 'rev-parse') return { stdout: 'feedface\n' };
      return { exitCode: 0 };
    };
    const res = await commitAndPush({
      apiUrl: 'https://api.shogo.ai',
      apiKey: 'shogo_sk_test',
      projectId: 'p_dirty',
      localDir: '/tmp/never',
      message: 'auto: 2026-01-01T00:00:00Z',
    });
    expect(res.committed).toBe(true);
    expect(res.commitSha).toBe('feedface');
    const pushInv = spawnInvocations.find((i) => i.args.includes('push'))!;
    expect(pushInv).toBeDefined();
    expect(pushInv.args.some((a) => a.startsWith('http.extraHeader='))).toBe(true);
  });
});

describe('gitFetchAndReset', () => {
  it('passes bearer via -c http.extraHeader on both fetch and reset', async () => {
    spawnHandler = (inv) => {
      if (inv.args[0] === 'rev-parse') return { stdout: 'cafebabe\n' };
      return { exitCode: 0 };
    };
    const res = await gitFetchAndReset({
      apiUrl: 'https://api.shogo.ai',
      apiKey: 'shogo_sk_test',
      projectId: 'p_demo',
      localDir: '/tmp/never',
    });
    expect(res.commitSha).toBe('cafebabe');
    const fetchInv = spawnInvocations.find((i) => i.args.includes('fetch'))!;
    expect(fetchInv.args.some((a) => a.startsWith('http.extraHeader='))).toBe(true);
    // reset does NOT need the bearer.
    const resetInv = spawnInvocations.find((i) => i.args.includes('reset'))!;
    expect(resetInv.args.some((a) => a.startsWith('http.extraHeader='))).toBe(false);
  });
});

describe('isGitRepo', () => {
  it('returns true when .git exists in the dir', async () => {
    const { mkdtempSync, mkdirSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'is-git-'));
    try {
      mkdirSync(join(dir, '.git'));
      expect(isGitRepo(dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('returns false when .git is missing', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'is-git-'));
    try {
      expect(isGitRepo(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
