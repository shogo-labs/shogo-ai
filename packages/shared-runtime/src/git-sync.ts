// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Cloud-side git workspace sync for agent-runtime pods.
 *
 * Pairs with the smart-HTTP backend at
 *   `<cloudApiUrl>/api/projects/:projectId/git/*`
 * (see `apps/api/src/routes/git-http.ts`). Mirrors `S3Sync`'s public
 * `triggerSync` / `flushAndShutdown` surface so the agent-runtime
 * call-sites in `packages/agent-runtime/src/server.ts` only need a
 * sibling call, not a behavioral change.
 *
 * Wire protocol:
 *   `git add -A`
 *   `git commit -m "auto: <ISO ts>"`  (skipped if nothing staged)
 *   `git -c http.extraHeader=Authorization: Bearer <RUNTIME_AUTH_SECRET> push <url> HEAD`
 *
 * The bearer is supplied via `-c http.extraHeader` so it never lands
 * in argv as a URL secret (same approach as the worker-side
 * `git-cloner.ts`). The post-receive hook on the API side writes the
 * `ProjectCheckpoint` row and is the single source of truth for
 * checkpoint history in `git_only` mode.
 *
 * Failure isolation
 * -----------------
 * Pushes can fail for many transient reasons: a deploying API replica,
 * a partial network blip, an expired runtime token mid-rotation, or a
 * brief contention on the bare repo. We do NOT want a chat turn to
 * "lose" file state when this happens, so the class tracks consecutive
 * push failures and after `degradeAfterFailures` (default 3) in a row
 * fires `onDegrade(reason)`. The agent-runtime wires that hook to
 * `S3Sync.setSuppressProjectArchive(false)` so Layer 2 (project.tar.gz)
 * uploads re-engage and the project is dual-written to S3 for the rest
 * of the pod's life. On the next successful push `onRecovered` fires
 * and the runtime re-suppresses Layer 2.
 *
 * Background retry strategy: failed pushes are scheduled on an
 * exponential backoff (1s, 2s, 4s, ... capped at 30s) so we keep
 * trying without spinning. `triggerSync` does NOT wait for the
 * backoff — it just marks "we want another push" and the next attempt
 * absorbs the latest staged tree. Degraded mode means "S3 is also
 * writing", not "git stops trying".
 *
 * License boundary: lives in `shared-runtime` (AGPL) — same package
 * as S3Sync. The worker's MIT `commitAndPush` helper is duplicated
 * here, not imported, to keep the licensing surface clean.
 */

import { spawn } from 'child_process'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Debounce delay for `triggerSync(false)` (ms). */
const SYNC_DEBOUNCE_MS = 1500

/** Default consecutive-failure threshold before degrading to dual-write. */
const DEFAULT_DEGRADE_AFTER = 3

/** Backoff schedule for retrying after a failed push. */
const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000]

/** Hard timeout for any single `git` invocation (ms). */
let GIT_TIMEOUT_MS = 60_000

/** Testing-only: override the per-git-command timeout (resets to 60s on null). */
export function __setGitTimeoutMsForTesting(ms: number | null): void {
  GIT_TIMEOUT_MS = ms ?? 60_000
}

/** Optional sink type for `console.warn`-shaped logging. */
type Logger = Pick<Console, 'log' | 'warn' | 'error'>

export interface GitWorkspaceSyncConfig {
  /** Absolute path to the workspace (must be a git working tree). */
  workspaceDir: string
  /** Base cloud API URL, e.g. `http://api.shogo-system.svc.cluster.local`. */
  cloudApiUrl: string
  /** Bearer token used as `Authorization: Bearer <secret>` on push. */
  runtimeAuthSecret: string
  /** Project to push to (used to construct the smart-HTTP URL). */
  projectId: string
  /** Debounce delay for `triggerSync(false)`. Default 1500ms. */
  debounceMs?: number
  /**
   * Consecutive push failures before `onDegrade` fires. Default 3.
   * Set to 0 to disable degradation (failures are still logged + retried).
   */
  degradeAfterFailures?: number
  /**
   * Called once when transitioning into degraded state. The agent-runtime
   * uses this to flip `S3Sync.setSuppressProjectArchive(false)` so Layer 2
   * uploads take over until git recovers.
   */
  onDegrade?: (reason: string) => void
  /** Called on the first successful push after a degrade. */
  onRecovered?: () => void
  /** Optional logger (defaults to `console`). */
  logger?: Logger
  /**
   * Test seam — overrides the in-process spawner. Real callers should
   * not pass this. Useful for unit tests so we don't actually fork git.
   */
  spawnGit?: SpawnGitFn
  /** Branch to push to. Defaults to `HEAD`. */
  branch?: string
  /** Author email for the auto-commit. Falls back to a generic robot identity. */
  authorEmail?: string
  /** Author name for the auto-commit. */
  authorName?: string
}

export interface SpawnGitFn {
  /**
   * Run `git <args>` in `cwd` and return stdout/stderr/exitCode.
   * Must apply a hard timeout — the real implementation uses
   * `GIT_TIMEOUT_MS`.
   */
  (args: string[], cwd: string, env?: NodeJS.ProcessEnv): Promise<{
    exitCode: number
    stdout: string
    stderr: string
  }>
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Default `git` spawner — real callers get this. Pure wrapper around
 * `child_process.spawn` with timeout + utf-8 capture.
 */
const defaultSpawnGit: SpawnGitFn = (args, cwd, env) => {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      env: { ...process.env, ...(env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdoutChunks: string[] = []
    const stderrChunks: string[] = []
    child.stdout.setEncoding('utf-8')
    child.stderr.setEncoding('utf-8')
    child.stdout.on('data', (c: string) => stdoutChunks.push(c))
    child.stderr.on('data', (c: string) => stderrChunks.push(c))

    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* ignore */ }
      reject(new Error(`git ${args[0]} timed out after ${GIT_TIMEOUT_MS}ms`))
    }, GIT_TIMEOUT_MS)

    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({
        exitCode: code ?? -1,
        stdout: stdoutChunks.join(''),
        stderr: stderrChunks.join(''),
      })
    })
  })
}

/** Build the smart-HTTP URL we push to. */
function buildGitUrl(cloudApiUrl: string, projectId: string): string {
  const base = cloudApiUrl.replace(/\/+$/, '')
  return `${base}/api/projects/${projectId}/git`
}

// ---------------------------------------------------------------------------
// GitWorkspaceSync
// ---------------------------------------------------------------------------

export class GitWorkspaceSync {
  private readonly cfg: Required<Omit<GitWorkspaceSyncConfig,
    'onDegrade' | 'onRecovered' | 'logger' | 'spawnGit' | 'authorEmail' | 'authorName'>> & {
    onDegrade: (reason: string) => void
    onRecovered: () => void
    logger: Logger
    spawnGit: SpawnGitFn
    authorEmail: string
    authorName: string
  }

  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private backoffTimer: ReturnType<typeof setTimeout> | null = null
  private isPushing = false
  private pushQueuedDuringPush = false
  private shuttingDown = false

  /** Total consecutive failed-push attempts since the last success. */
  private _consecutiveFailures = 0
  /** Whether we've fired `onDegrade` for the current degraded window. */
  private _degraded = false

  constructor(config: GitWorkspaceSyncConfig) {
    this.cfg = {
      workspaceDir: config.workspaceDir,
      cloudApiUrl: config.cloudApiUrl,
      runtimeAuthSecret: config.runtimeAuthSecret,
      projectId: config.projectId,
      debounceMs: config.debounceMs ?? SYNC_DEBOUNCE_MS,
      degradeAfterFailures: config.degradeAfterFailures ?? DEFAULT_DEGRADE_AFTER,
      branch: config.branch ?? 'HEAD',
      onDegrade: config.onDegrade ?? (() => { }),
      onRecovered: config.onRecovered ?? (() => { }),
      logger: config.logger ?? console,
      spawnGit: config.spawnGit ?? defaultSpawnGit,
      authorEmail: config.authorEmail ?? 'agent-runtime@shogo.ai',
      authorName: config.authorName ?? 'Shogo Agent',
    }
  }

  /** Whether the sync is currently in degraded (push-failing) state. */
  get isDegraded(): boolean { return this._degraded }

  /** Consecutive failed push attempts since the last success. */
  get consecutiveFailures(): number { return this._consecutiveFailures }

  /**
   * Request a sync. Coalesces with any pending debounce.
   *
   * `immediate=true` cancels the debounce and runs on the next tick —
   * use for explicit user actions or shutdown.
   */
  triggerSync(immediate: boolean = false): void {
    if (this.shuttingDown) return

    if (immediate) {
      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer)
        this.debounceTimer = null
      }
      // Don't await: callers (file watchers, gateway) treat triggerSync
      // as fire-and-forget. Errors are surfaced via the degrade callback.
      void this.runPushCycle()
      return
    }

    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      void this.runPushCycle()
    }, this.cfg.debounceMs)
  }

  /**
   * Drain pending work, attempt one last push, then stop.
   *
   * If the push fails (e.g. cloud unreachable during shutdown), this
   * still returns within `timeoutMs` — the caller's fallback (S3
   * `flushAndShutdown({ forceProjectArchive: true })`) is what ensures
   * durability for the cold-start tarball.
   */
  async flushAndShutdown(timeoutMs: number = 5_000): Promise<void> {
    this.shuttingDown = true
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
    if (this.backoffTimer) {
      clearTimeout(this.backoffTimer)
      this.backoffTimer = null
    }

    const work = this.runPushCycle().catch(() => { /* swallowed below */ })
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))
    await Promise.race([work, timeout])
  }

  // ===========================================================================
  // Internals
  // ===========================================================================

  /**
   * One push attempt. If another push is in flight, mark "redo after"
   * and return immediately — the in-flight push will pick up the new
   * changes when it loops.
   */
  private async runPushCycle(): Promise<void> {
    if (this.isPushing) {
      this.pushQueuedDuringPush = true
      return
    }
    this.isPushing = true
    try {
      do {
        this.pushQueuedDuringPush = false
        await this.attemptPush()
      } while (this.pushQueuedDuringPush && !this.shuttingDown)
    } finally {
      this.isPushing = false
    }
  }

  private async attemptPush(): Promise<void> {
    const { logger, spawnGit, workspaceDir, branch } = this.cfg
    const url = buildGitUrl(this.cfg.cloudApiUrl, this.cfg.projectId)

    const commitEnv: NodeJS.ProcessEnv = {
      GIT_AUTHOR_NAME: this.cfg.authorName,
      GIT_AUTHOR_EMAIL: this.cfg.authorEmail,
      GIT_COMMITTER_NAME: this.cfg.authorName,
      GIT_COMMITTER_EMAIL: this.cfg.authorEmail,
    }

    try {
      // Stage everything (respects `.gitignore`).
      await this.runGit(spawnGit, ['add', '-A'], workspaceDir, commitEnv)

      // `git diff --cached --quiet` exits non-zero when there's something to commit.
      const diff = await spawnGit(['diff', '--cached', '--quiet'], workspaceDir, commitEnv)
      const hasChanges = diff.exitCode !== 0
      if (!hasChanges) {
        // Nothing to do — clear failure state if we were retrying a
        // previous failure that turned out to be empty.
        return
      }

      const message = `auto: ${new Date().toISOString()}`
      await this.runGit(
        spawnGit,
        ['commit', '-m', message, '--no-verify'],
        workspaceDir,
        commitEnv,
      )

      // Push with the bearer header via `-c` so it never lands in argv-as-URL.
      const header = `http.extraHeader=Authorization: Bearer ${this.cfg.runtimeAuthSecret}`
      await this.runGit(
        spawnGit,
        ['-c', header, 'push', url, branch],
        workspaceDir,
        commitEnv,
      )

      // SUCCESS — clear backoff + recover from degraded state if applicable.
      if (this.backoffTimer) {
        clearTimeout(this.backoffTimer)
        this.backoffTimer = null
      }
      const wasDegraded = this._degraded
      this._consecutiveFailures = 0
      this._degraded = false
      if (wasDegraded) {
        logger.log(`[GitWorkspaceSync] recovered after push success — re-suppressing S3 Layer 2`)
        try { this.cfg.onRecovered() } catch (err: any) {
          logger.error(`[GitWorkspaceSync] onRecovered threw:`, err?.message ?? err)
        }
      }
    } catch (err: any) {
      this._consecutiveFailures += 1
      const reason = `${err?.message ?? err}`
      logger.warn(
        `[GitWorkspaceSync] push failed (attempt ${this._consecutiveFailures}): ${reason}`,
      )

      // Degrade once after threshold reached.
      if (
        !this._degraded &&
        this.cfg.degradeAfterFailures > 0 &&
        this._consecutiveFailures >= this.cfg.degradeAfterFailures
      ) {
        this._degraded = true
        logger.warn(
          `[GitWorkspaceSync] cloud-sync degraded after ${this._consecutiveFailures} consecutive failures — re-enabling S3 Layer 2`,
        )
        try { this.cfg.onDegrade(reason) } catch (cbErr: any) {
          logger.error(`[GitWorkspaceSync] onDegrade threw:`, cbErr?.message ?? cbErr)
        }
      }

      // Schedule a retry on exponential backoff (best-effort — if we're
      // shutting down or already have a pending backoff, skip).
      if (!this.shuttingDown && !this.backoffTimer) {
        const idx = Math.min(this._consecutiveFailures - 1, BACKOFF_MS.length - 1)
        const wait = BACKOFF_MS[idx]
        this.backoffTimer = setTimeout(() => {
          this.backoffTimer = null
          void this.runPushCycle()
        }, wait)
      }
    }
  }

  /**
   * Run `git <args>` and throw on non-zero exit. Centralized so the
   * stderr is captured into the error message for the degrade reason.
   */
  private async runGit(
    spawnGit: SpawnGitFn,
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
  ): Promise<void> {
    const r = await spawnGit(args, cwd, env)
    if (r.exitCode !== 0) {
      const err = new Error(
        `git ${args[0]} exited ${r.exitCode}: ${(r.stderr || '').slice(0, 500)}`,
      )
        ; (err as any).exitCode = r.exitCode
      throw err
    }
  }
}

// ---------------------------------------------------------------------------
// Factory (env-var convenience, mirrors createS3SyncFromEnv)
// ---------------------------------------------------------------------------

/**
 * Per-project cloud sync strategy. Set by the warm-pool controller via
 * `SHOGO_CLOUD_SYNC_MODE` at assignment time (see
 * `apps/api/src/lib/runtime/build-project-env.ts`). Read by the
 * agent-runtime to decide whether to instantiate `GitWorkspaceSync`
 * and/or suppress `S3Sync`'s Layer 2.
 *
 * Kept here (not in server.ts) so tests in `shared-runtime` can exercise
 * the env-var contract without booting the whole runtime.
 */
export type CloudSyncMode = 's3' | 'dual_shadow' | 'git_only'

/**
 * Read `SHOGO_CLOUD_SYNC_MODE` from the environment, normalize case,
 * and clamp anything unrecognized to `s3` (the safe default — today's
 * behavior). Exported for unit testing.
 */
export function resolveCloudSyncMode(env: NodeJS.ProcessEnv = process.env): CloudSyncMode {
  const raw = (env.SHOGO_CLOUD_SYNC_MODE ?? 's3').toLowerCase()
  if (raw === 'dual_shadow' || raw === 'git_only') return raw
  return 's3'
}

/**
 * Build a `GitWorkspaceSync` from the same env vars the agent-runtime
 * already reads in `server.ts`. Returns `null` if the required env is
 * missing — caller treats that as "skip git mode for this pod".
 *
 * Required env:
 *   - `SHOGO_API_URL`            (the cloud API root)
 *   - `RUNTIME_AUTH_SECRET`      (bearer for the smart-HTTP backend)
 *   - `PROJECT_ID`               (which project's git repo to push to)
 */
export function createGitSyncFromEnv(
  workspaceDir: string,
  opts: Pick<GitWorkspaceSyncConfig, 'onDegrade' | 'onRecovered' | 'debounceMs' | 'degradeAfterFailures' | 'logger'> = {},
): GitWorkspaceSync | null {
  const cloudApiUrl = process.env.SHOGO_API_URL
  const runtimeAuthSecret = process.env.RUNTIME_AUTH_SECRET
  const projectId = process.env.PROJECT_ID
  if (!cloudApiUrl || !runtimeAuthSecret || !projectId) {
    return null
  }
  return new GitWorkspaceSync({
    workspaceDir,
    cloudApiUrl,
    runtimeAuthSecret,
    projectId,
    ...opts,
  })
}
