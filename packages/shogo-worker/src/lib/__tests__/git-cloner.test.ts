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
type SpawnResult = { stdout?: string; stderr?: string; exitCode?: number; runError?: Error; hang?: boolean };
type SpawnHandler = (inv: SpawnInvocation) => SpawnResult;
let spawnHandler: SpawnHandler = () => ({ exitCode: 0 });

let execFileHandler: (cmd: string, args: string[]) => { error?: Error; stdout?: string } =
  () => ({ stdout: 'git version 2.40.0' });

function makeFakeChild(result: SpawnResult) {
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
    if (result.hang) return; // never emit close — used for timeout tests
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
    const callback = typeof opts === 'function' ? opts : cb;
    const r = execFileHandler(cmd, args);
    setTimeout(() => {
      if (r.error) callback?.(r.error, '', '');
      else callback?.(null, r.stdout ?? '', '');
    }, 1);
  },
}));

const { buildGitUrl, cloneProject, commitAndPush, gitIsAvailable, isGitRepo, gitFetchAndReset } =
  await import('../git-cloner.ts');

beforeEach(() => {
  spawnInvocations.length = 0;
  spawnHandler = () => ({ exitCode: 0 });
  execFileHandler = () => ({ stdout: 'git version 2.40.0' });
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

// ─── Additional coverage tests ──────────────────────────────────────────────

describe('gitIsAvailable (failure path)', () => {
  it('returns false when git --version fails (L46)', async () => {
    execFileHandler = () => ({ error: new Error('git not found in PATH') });
    const ok = await gitIsAvailable(true); // force=true bypasses cache
    expect(ok).toBe(false);
    // Restore the cache to true for subsequent tests (idempotent re-probe)
    execFileHandler = () => ({ stdout: 'git version 2.40.0' });
    await gitIsAvailable(true);
  });
});

describe('runGit (timeout + error paths)', () => {
  it('rejects when the timer fires before the child closes (L127-128)', async () => {
    const { runGit } = await import('../git-cloner.ts');
    spawnHandler = () => ({ hang: true });
    await expect(
      runGit(['fetch'], { timeoutMs: 30 }),
    ).rejects.toThrow(/timed out after 30ms/);
  });

  it('rejects when the child emits an error event (L132-133)', async () => {
    const { runGit } = await import('../git-cloner.ts');
    spawnHandler = () => ({ runError: new Error('spawn ENOENT') });
    await expect(
      runGit(['status'], { timeoutMs: 5000 }),
    ).rejects.toThrow(/spawn ENOENT/);
  });
});

describe('gitFetchUnshallow', () => {
  it('runs git fetch --unshallow when .git/shallow exists (L270-276)', async () => {
    const { gitFetchUnshallow } = await import('../git-cloner.ts');
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'unshallow-'));
    try {
      mkdirSync(join(dir, '.git'));
      writeFileSync(join(dir, '.git', 'shallow'), 'deadbeef\n');
      await gitFetchUnshallow({
        apiUrl: 'https://api.shogo.ai',
        apiKey: 'shogo_sk_test',
        projectId: 'p_demo',
        localDir: dir,
      });
      const fetchInv = spawnInvocations.find((i) => i.args.includes('--unshallow'));
      expect(fetchInv).toBeDefined();
      expect(fetchInv!.args.some((a) => a.startsWith('http.extraHeader='))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('no-ops when .git/shallow is missing (repo already complete)', async () => {
    const { gitFetchUnshallow } = await import('../git-cloner.ts');
    const { mkdtempSync, mkdirSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'unshallow-'));
    try {
      mkdirSync(join(dir, '.git'));
      await gitFetchUnshallow({
        apiUrl: 'https://api.shogo.ai',
        apiKey: 'shogo_sk_test',
        projectId: 'p_demo',
        localDir: dir,
      });
      expect(spawnInvocations.length).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('commitAndPush (author identity)', () => {
  it('always authors and commits as the canonical agent, whatever the caller asks for', async () => {
    spawnHandler = (inv) => {
      if (inv.args[0] === 'diff') return { exitCode: 1 };
      if (inv.args[0] === 'rev-parse') return { stdout: 'shaaaaaa\n' };
      return { exitCode: 0 };
    };
    await commitAndPush({
      apiUrl: 'https://api.shogo.ai',
      apiKey: 'k',
      projectId: 'p',
      localDir: '/tmp/never',
      message: 'feat: x',
      // @ts-expect-error — the fields are gone; a caller that still passes them must not win.
      authorEmail: 'dev2@shogo.local',
      authorName: 'Shogo Dev 2',
    });
    for (const invocation of spawnInvocations) {
      expect(invocation.env?.GIT_AUTHOR_NAME).toBe('Shogo Agent');
      expect(invocation.env?.GIT_AUTHOR_EMAIL).toBe('agent@shogo.ai');
      expect(invocation.env?.GIT_COMMITTER_NAME).toBe('Shogo Agent');
      expect(invocation.env?.GIT_COMMITTER_EMAIL).toBe('agent@shogo.ai');
    }
  });

  it('overrides a GIT_AUTHOR_* in the worker environment', async () => {
    const previous = { name: process.env.GIT_AUTHOR_NAME, email: process.env.GIT_AUTHOR_EMAIL };
    process.env.GIT_AUTHOR_NAME = 'Shogo Dev 3';
    process.env.GIT_AUTHOR_EMAIL = 'dev3@shogo.local';
    spawnInvocations.length = 0;
    spawnHandler = (inv) => {
      if (inv.args[0] === 'diff') return { exitCode: 1 };
      if (inv.args[0] === 'rev-parse') return { stdout: 'shaaaaaa\n' };
      return { exitCode: 0 };
    };
    try {
      await commitAndPush({
        apiUrl: 'https://api.shogo.ai',
        apiKey: 'k',
        projectId: 'p',
        localDir: '/tmp/never',
        message: 'feat: x',
      });
      const commitInv = spawnInvocations.find((i) => i.args[0] === 'commit')!;
      expect(commitInv.env?.GIT_AUTHOR_EMAIL).toBe('agent@shogo.ai');
      expect(commitInv.env?.GIT_COMMITTER_EMAIL).toBe('agent@shogo.ai');
      expect(commitInv.env?.GIT_AUTHOR_NAME).toBe('Shogo Agent');
    } finally {
      if (previous.name === undefined) delete process.env.GIT_AUTHOR_NAME;
      else process.env.GIT_AUTHOR_NAME = previous.name;
      if (previous.email === undefined) delete process.env.GIT_AUTHOR_EMAIL;
      else process.env.GIT_AUTHOR_EMAIL = previous.email;
    }
  });
});

describe('commitAndPush (co-author trailer)', () => {
  it('writes the one canonical co-author', async () => {
    spawnHandler = (inv) => {
      if (inv.args[0] === 'diff') return { exitCode: 1 };
      if (inv.args[0] === 'rev-parse') return { stdout: 'shaaaaaa\n' };
      return { exitCode: 0 };
    };
    await commitAndPush({
      apiUrl: 'https://api.shogo.ai',
      apiKey: 'k',
      projectId: 'p',
      localDir: '/tmp/never',
      message: 'chore: x',
    });
    const commitInv = spawnInvocations.find((i) => i.args[0] === 'commit')!;
    const trailer = commitInv.args[commitInv.args.indexOf('--trailer') + 1];
    expect(trailer).toBe('Co-authored-by: Shogo Agent <agent@shogo.ai>');
  });

  it('never takes the co-author from SHOGO_AGENT_GIT_* env overrides', async () => {
    const previous = { name: process.env.SHOGO_AGENT_GIT_NAME, email: process.env.SHOGO_AGENT_GIT_EMAIL };
    process.env.SHOGO_AGENT_GIT_NAME = 'Shogo Dev 3';
    process.env.SHOGO_AGENT_GIT_EMAIL = 'dev3@shogo.local';
    spawnInvocations.length = 0;
    spawnHandler = (inv) => {
      if (inv.args[0] === 'diff') return { exitCode: 1 };
      if (inv.args[0] === 'rev-parse') return { stdout: 'shaaaaaa\n' };
      return { exitCode: 0 };
    };
    try {
      await commitAndPush({
        apiUrl: 'https://api.shogo.ai',
        apiKey: 'k',
        projectId: 'p',
        localDir: '/tmp/never',
        message: 'chore: x',
      });
      const commitInv = spawnInvocations.find((i) => i.args[0] === 'commit')!;
      expect(commitInv.args[commitInv.args.indexOf('--trailer') + 1]).toBe(
        'Co-authored-by: Shogo Agent <agent@shogo.ai>',
      );
    } finally {
      if (previous.name === undefined) delete process.env.SHOGO_AGENT_GIT_NAME;
      else process.env.SHOGO_AGENT_GIT_NAME = previous.name;
      if (previous.email === undefined) delete process.env.SHOGO_AGENT_GIT_EMAIL;
      else process.env.SHOGO_AGENT_GIT_EMAIL = previous.email;
    }
  });
});

