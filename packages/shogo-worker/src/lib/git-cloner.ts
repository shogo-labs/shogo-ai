// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Git-based project cloner for the Shogo worker.
 *
 * Talks to the smart-HTTP backend mounted at
 *   `<cloudUrl>/api/projects/:projectId/git/*`
 * (see `apps/api/src/routes/git-http.ts`). We let the local `git`
 * binary do all the wire-protocol work and just provide auth via the
 * `http.extraHeader` config so the API key never lands in argv as a
 * URL secret.
 *
 * Why git instead of the file transport for clones:
 *   - Pack-based delta sync (much smaller than enumerated PUTs).
 *   - First-class history: every checkpoint is a real reachable commit.
 *   - Atomicity: `git fetch && git reset --hard` is transactional.
 *
 * Falls back to the file transport in `WorkerRuntimeManager` if `git`
 * isn't available — that's the only reason this module exposes the
 * `gitIsAvailable()` probe.
 */

import { spawn, execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Availability probe
// ---------------------------------------------------------------------------

let gitProbeCache: boolean | null = null;

/**
 * One-shot probe for whether `git` is on PATH. Cached after first call.
 *
 * Pass `force: true` to bust the cache (used in tests).
 */
export async function gitIsAvailable(force = false): Promise<boolean> {
  if (gitProbeCache !== null && !force) return gitProbeCache;
  try {
    await execFileAsync('git', ['--version'], { timeout: 3000 });
    gitProbeCache = true;
  } catch {
    gitProbeCache = false;
  }
  return gitProbeCache;
}

// ---------------------------------------------------------------------------
// URL builder
// ---------------------------------------------------------------------------

/**
 * Build the smart-HTTP URL the worker should `git clone` from.
 *
 * Example: `https://api.shogo.ai/api/projects/p_abc/git`
 *
 * `git` appends `/info/refs` etc. on its own. We strip any trailing
 * slash from the input cloud URL so we don't end up with `//api/...`.
 */
export function buildGitUrl(cloudApiUrl: string, projectId: string): string {
  const base = cloudApiUrl.replace(/\/+$/, '');
  return `${base}/api/projects/${projectId}/git`;
}

// ---------------------------------------------------------------------------
// Spawn helper
// ---------------------------------------------------------------------------

export interface RunGitOptions {
  /** Working directory for the command. */
  cwd?: string;
  /** Extra env vars (merged into process.env). */
  env?: NodeJS.ProcessEnv;
  /** Hard timeout in ms. Default 5 minutes. */
  timeoutMs?: number;
  /** Optional logger for stdout/stderr chunks (used by --watch UIs). */
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

export interface RunGitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Run `git <args>` and resolve with captured stdout/stderr/exitCode.
 *
 * We use `spawn` (not `execFile`) so we can apply the bearer-token
 * `http.extraHeader` via `-c` args without it ever appearing in a
 * shell-quoted command string, and so we never buffer arbitrarily
 * large pack data (clones can produce tens of MB on stderr alone for
 * progress lines).
 *
 * Rejects on non-zero exit with the stderr captured into the Error.
 */
export function runGit(args: string[], opts: RunGitOptions = {}): Promise<RunGitResult> {
  const { cwd, env, timeoutMs = 5 * 60 * 1000, logger } = opts;
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];

    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', (chunk: string) => {
      stdoutChunks.push(chunk);
      if (logger) logger.log(chunk.trimEnd());
    });
    child.stderr.on('data', (chunk: string) => {
      stderrChunks.push(chunk);
      // git emits progress on stderr — keep verbose to that channel.
      if (logger) logger.warn(chunk.trimEnd());
    });

    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      reject(new Error(`git ${args[0]} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      stdout = stdoutChunks.join('');
      stderr = stderrChunks.join('');
      const exitCode = code ?? -1;
      if (exitCode === 0) {
        resolve({ stdout, stderr, exitCode });
      } else {
        const err = new Error(`git ${args[0]} exited with code ${exitCode}: ${stderr.slice(0, 500)}`) as Error & {
          exitCode: number;
          stdout: string;
          stderr: string;
        };
        err.exitCode = exitCode;
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface CloneProjectOptions {
  /** Base cloud API URL, e.g. `https://api.shogo.ai`. */
  apiUrl: string;
  /** Bearer API key (`shogo_sk_*`). Never appears in the URL or argv. */
  apiKey: string;
  /** Project to clone. */
  projectId: string;
  /** Destination directory. Must not already contain a git repo. */
  localDir: string;
  /**
   * Whether to clone with `--depth=1`. Defaults to `true` — most
   * worker usage doesn't need full history, and shallow clones are
   * ~10x smaller.
   */
  shallow?: boolean;
  /** Optional logger for git stdout/stderr (progress lines). */
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
  /** Per-call timeout. Default 5 minutes. */
  timeoutMs?: number;
}

export interface CloneProjectResult {
  /** SHA of the new HEAD commit. */
  commitSha: string;
}

/**
 * Clone (or refuse-to-clone if already cloned) the given project into
 * `localDir`.
 *
 * If `localDir/.git` already exists, this throws — callers must
 * `gitFetchAndReset` instead. This guard prevents accidental overwrites
 * of in-progress worker state.
 */
export async function cloneProject(opts: CloneProjectOptions): Promise<CloneProjectResult> {
  const { apiUrl, apiKey, projectId, localDir, shallow = true, logger, timeoutMs } = opts;

  if (existsSync(join(localDir, '.git'))) {
    throw new Error(`cloneProject: ${localDir}/.git already exists; use gitFetchAndReset instead`);
  }

  const url = buildGitUrl(apiUrl, projectId);
  const args: string[] = [
    '-c', `http.extraHeader=Authorization: Bearer ${apiKey}`,
    'clone',
  ];
  if (shallow) args.push('--depth=1');
  args.push(url, localDir);

  await runGit(args, { logger, timeoutMs });

  // Read the resulting HEAD sha so callers can record it (auto-pull
  // path stamps this onto the project record for diagnostic UI).
  const head = await runGit(['rev-parse', 'HEAD'], { cwd: localDir, logger, timeoutMs: 10_000 });
  return { commitSha: head.stdout.trim() };
}

export interface GitFetchOptions {
  apiUrl: string;
  apiKey: string;
  projectId: string;
  localDir: string;
  /** Branch to fetch. Defaults to the default branch ("HEAD"). */
  branch?: string;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
  timeoutMs?: number;
}

/**
 * Fetch the latest refs from the cloud and hard-reset the working
 * tree to match the remote tip.
 *
 * Used by the auto-pull recheck loop and by `shogo project checkout`
 * for refs that fall outside the shallow window.
 */
export async function gitFetchAndReset(opts: GitFetchOptions): Promise<{ commitSha: string }> {
  const { apiUrl, apiKey, projectId, localDir, branch = 'HEAD', logger, timeoutMs } = opts;
  const url = buildGitUrl(apiUrl, projectId);

  // We re-supply the bearer header on every invocation — even though
  // we set it once at clone time, `git config --local` is persistent
  // and would leave the key on disk. The `-c` form keeps it ephemeral.
  const cfg = ['-c', `http.extraHeader=Authorization: Bearer ${apiKey}`];

  await runGit([...cfg, 'fetch', url, branch], { cwd: localDir, logger, timeoutMs });
  await runGit(['reset', '--hard', 'FETCH_HEAD'], { cwd: localDir, logger, timeoutMs });

  const head = await runGit(['rev-parse', 'HEAD'], { cwd: localDir, logger, timeoutMs: 10_000 });
  return { commitSha: head.stdout.trim() };
}

export interface GitUnshallowOptions {
  apiUrl: string;
  apiKey: string;
  projectId: string;
  localDir: string;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
  timeoutMs?: number;
}

/**
 * Convert a shallow clone into a full clone so callers can `git
 * checkout <old-sha>` against any historical checkpoint.
 *
 * Cheap to call repeatedly — git short-circuits if the repo is
 * already complete.
 */
export async function gitFetchUnshallow(opts: GitUnshallowOptions): Promise<void> {
  const { apiUrl, apiKey, projectId, localDir, logger, timeoutMs } = opts;
  const url = buildGitUrl(apiUrl, projectId);
  const cfg = ['-c', `http.extraHeader=Authorization: Bearer ${apiKey}`];
  // If the repo isn't shallow, git errors out — make it a no-op.
  if (existsSync(join(localDir, '.git', 'shallow'))) {
    await runGit([...cfg, 'fetch', '--unshallow', url], { cwd: localDir, logger, timeoutMs });
  }
}

export interface CommitAndPushOptions {
  apiUrl: string;
  apiKey: string;
  projectId: string;
  localDir: string;
  /** Commit message. */
  message: string;
  /** Branch to push to. Defaults to `HEAD` (current branch). */
  branch?: string;
  /** Author email used for commit metadata. Falls back to GIT_AUTHOR_EMAIL. */
  authorEmail?: string;
  /** Author name. Falls back to GIT_AUTHOR_NAME. */
  authorName?: string;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
  timeoutMs?: number;
}

export interface CommitAndPushResult {
  /** True when a commit was actually created (false if nothing was staged). */
  committed: boolean;
  /** SHA of the new commit, when one was made. */
  commitSha?: string;
}

/**
 * `git add -A && git commit && git push` for the watcher's commit-mode
 * flush. Returns `committed: false` when there were no changes, so the
 * watcher doesn't claim a push for an empty edit batch.
 */
export async function commitAndPush(opts: CommitAndPushOptions): Promise<CommitAndPushResult> {
  const { apiUrl, apiKey, projectId, localDir, message, branch = 'HEAD', authorEmail, authorName, logger, timeoutMs } = opts;

  const url = buildGitUrl(apiUrl, projectId);
  const env: NodeJS.ProcessEnv = {};
  if (authorEmail) {
    env.GIT_AUTHOR_EMAIL = authorEmail;
    env.GIT_COMMITTER_EMAIL = authorEmail;
  }
  if (authorName) {
    env.GIT_AUTHOR_NAME = authorName;
    env.GIT_COMMITTER_NAME = authorName;
  }

  await runGit(['add', '-A'], { cwd: localDir, env, logger, timeoutMs });

  // `git diff --cached --quiet` exits non-zero when there's something to commit.
  let hasChanges = false;
  try {
    await runGit(['diff', '--cached', '--quiet'], { cwd: localDir, env, logger, timeoutMs });
  } catch {
    hasChanges = true;
  }
  if (!hasChanges) return { committed: false };

  await runGit(
    ['commit', '-m', message, '--no-verify'],
    { cwd: localDir, env, logger, timeoutMs },
  );

  const head = await runGit(['rev-parse', 'HEAD'], { cwd: localDir, env, logger, timeoutMs: 10_000 });
  const commitSha = head.stdout.trim();

  const cfg = ['-c', `http.extraHeader=Authorization: Bearer ${apiKey}`];
  await runGit([...cfg, 'push', url, branch], { cwd: localDir, env, logger, timeoutMs });

  return { committed: true, commitSha };
}

/**
 * Check whether a directory looks like a git working tree we own.
 * Used by the auto-pull path to decide between clone vs. fetch.
 */
export function isGitRepo(localDir: string): boolean {
  return existsSync(join(localDir, '.git'));
}
