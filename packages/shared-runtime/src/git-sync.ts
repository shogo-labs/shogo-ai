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
 * Parking (SHO-180 / #1686)
 * -------------------------
 * A failure retried forever with no limit is not a retry, it is a silent
 * outage: one untracked file named `nul` made `git add` exit 128 on every
 * cycle for three days (3,493 attempts) while nothing reached the user. So
 * after {@link PARK_AFTER_FAILURES} consecutive failures *for the same reason*
 * the sync parks itself: the backoff timer stops, and a `triggerSync` (one fires
 * at the end of every agent turn) buys at most one attempt per
 * {@link PARKED_RETRY_MS}. Any success, or a different failure reason, leaves
 * the parked state. Entering it fires `onPark` once per episode so the runtime
 * can tell the user. A lifetime counter in `.git/shogo-sync-state.json` makes
 * the log line say how long it has been failing.
 *
 * License boundary: lives in `shared-runtime` (AGPL) — same package
 * as S3Sync. The worker's MIT `commitAndPush` helper is duplicated
 * here, not imported, to keep the licensing surface clean.
 */

import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  getShogoAgentEmail,
  getShogoAgentName,
  withShogoCommitTrailer,
} from './agent-attribution'

import { spawn } from './child-process'
import { excludePathspecs } from './git-pathspec'
import { findReservedPaths } from './git-reserved-names'
import { isRepairInProgress, prepareCheckpointRepo } from './shogo-state-paths'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Debounce delay for `triggerSync(false)` (ms). */
const SYNC_DEBOUNCE_MS = 1500

/** Default consecutive-failure threshold before degrading to dual-write. */
const DEFAULT_DEGRADE_AFTER = 3

/** Backoff schedule for retrying after a failed push. */
const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000]

/** Consecutive failures with the same reason before the sync parks itself. */
const PARK_AFTER_FAILURES = 20

/** While parked, the most often a `triggerSync` may try again (ms). */
const PARKED_RETRY_MS = 10 * 60_000

/** Lifetime failure counter, inside `.git` so it survives a pod restart. */
const SYNC_STATE_FILE = 'shogo-sync-state.json'

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
  /**
   * Called once when the sync parks itself after {@link PARK_AFTER_FAILURES}
   * consecutive failures for the same reason. The runtime wires this to a user
   * notification — a backup that has been dead for days must not be silent.
   */
  onPark?: (info: SyncParkInfo) => void
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
  /**
   * Pod-owned `git_only` mode. When true, the sync commits locally and
   * invokes {@link afterCommit} instead of pushing to a cloud remote. The
   * pod owns durability (persist `.git` to object storage) and checkpoint
   * recording; there is no API-side origin to push to. The failure-isolation
   * machinery is reused: if `afterCommit` throws `degradeAfterFailures`
   * times in a row, `onDegrade` fires so S3 Layer 2 re-engages.
   */
  localOnly?: boolean
  /**
   * Called after a successful local commit (localOnly mode) with the new
   * HEAD sha. Used to persist `.git` to object storage and record the
   * `ProjectCheckpoint` row via the API. Throwing routes through the same
   * retry/degrade path as a failed push.
   */
  afterCommit?: (sha: string) => Promise<void> | void
  /**
   * Optional hook run at the start of every push cycle, BEFORE `git add -A`.
   * In Git LFS mode the agent-runtime wires this to `autoTrackLargeFiles` so
   * newly-introduced large files are `git lfs track`-ed before staging and
   * the clean filter writes pointers instead of raw bytes. Best-effort: a
   * throw is logged and ignored so it can never block the commit/push.
   */
  beforeStage?: () => Promise<void> | void
  /**
   * Workspace-relative paths never staged, whatever the project's
   * `.gitignore` says. The runtime keeps pod-local state (including the
   * host's repo-hydrate staging dir, which contains a `.git`) under these.
   */
  stageExcludes?: string[]
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

/** What `onPark` is told when the sync gives up retrying for a while. */
export interface SyncParkInfo {
  /** First line of the failure that parked it. */
  reason: string
  /** Failures in a row with that same reason. */
  consecutiveFailures: number
  /** Failed durability steps since the last success, across restarts. */
  lifetimeFailures: number
  /** When that streak started (ISO), or null when nothing was persisted. */
  firstFailureAt: string | null
  /** Path of the persisted counter, or null when the workspace has no `.git`. */
  stateFile: string | null
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
    child.stdout?.setEncoding('utf-8')
    child.stderr?.setEncoding('utf-8')
    child.stdout?.on('data', (c: string) => stdoutChunks.push(c))
    child.stderr?.on('data', (c: string) => stderrChunks.push(c))

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

/**
 * The path git refused to index, from `git add`'s stderr
 * (`error: unable to index file 'nul'`). Null when the failure is something
 * else — a dubious-ownership error must not be "fixed" by dropping a file.
 */
export function unindexablePath(stderr: string): string | null {
  const m = /unable to index file '([^']+)'/.exec(stderr)
  return m ? m[1] : null
}

/** First line of a failure, trimmed — the identity used to compare reasons. */
function firstLineOf(reason: string): string {
  const line = reason.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? reason
  return line.slice(0, 300)
}

/** The error a failed `git` call throws, with its exit code attached. */
function gitExitError(subcommand: string, r: { exitCode: number; stderr?: string }): Error {
  const err = new Error(
    `git ${subcommand} exited ${r.exitCode}: ${(r.stderr || '').slice(0, 500)}`,
  )
  ;(err as any).exitCode = r.exitCode
  return err
}

/** Reserved paths already warned about in this process, as `<workspaceDir>\0<path>`. */
const warnedReservedPaths = new Set<string>()

/** Testing-only: forget which reserved paths were already warned about. */
export function __resetReservedPathWarningsForTesting(): void {
  warnedReservedPaths.clear()
}

// ---------------------------------------------------------------------------
// GitWorkspaceSync
// ---------------------------------------------------------------------------

export class GitWorkspaceSync {
  private readonly cfg: Required<Omit<GitWorkspaceSyncConfig,
    'onDegrade' | 'onRecovered' | 'onPark' | 'logger' | 'spawnGit' | 'authorEmail' | 'authorName' | 'afterCommit' | 'beforeStage'>> & {
    onDegrade: (reason: string) => void
    onRecovered: () => void
    onPark: (info: SyncParkInfo) => void
    logger: Logger
    spawnGit: SpawnGitFn
    authorEmail: string
    authorName: string
    afterCommit: ((sha: string) => Promise<void> | void) | null
    beforeStage: (() => Promise<void> | void) | null
  }

  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private backoffTimer: ReturnType<typeof setTimeout> | null = null
  /** Timer for the next (rate-limited) attempt while parked. */
  private parkedTimer: ReturnType<typeof setTimeout> | null = null
  private isPushing = false
  private pushQueuedDuringPush = false
  private shuttingDown = false
  private paused = false
  private pendingWhilePaused = false

  /** Total consecutive failed-push attempts since the last success. */
  private _consecutiveFailures = 0
  /** Whether we've fired `onDegrade` for the current degraded window. */
  private _degraded = false
  /** HEAD sha of the last successful durability step (push / afterCommit). */
  private _lastDurableSha: string | null = null

  /** Parked: the last {@link PARK_AFTER_FAILURES} failures all had one reason. */
  private _parked = false
  /** Consecutive failures that share `_lastFailureReason`. */
  private _sameReasonStreak = 0
  /** First line of the previous failure, for the same-reason comparison. */
  private _lastFailureReason: string | null = null
  /** When the last attempt started — the parked rate limit keys off it. */
  private _lastAttemptAt = 0
  /** Failed durability steps since the last success, persisted across restarts. */
  private _lifetimeFailures = 0
  /** Start of the current failure streak (ISO), persisted alongside the count. */
  private _firstFailureAt: string | null = null
  /** Where the counter is persisted, or null when the workspace has no `.git`. */
  private _stateFile: string | null = null
  private _stateLoaded = false

  constructor(config: GitWorkspaceSyncConfig) {
    this.cfg = {
      workspaceDir: config.workspaceDir,
      cloudApiUrl: config.cloudApiUrl,
      runtimeAuthSecret: config.runtimeAuthSecret,
      projectId: config.projectId,
      debounceMs: config.debounceMs ?? SYNC_DEBOUNCE_MS,
      degradeAfterFailures: config.degradeAfterFailures ?? DEFAULT_DEGRADE_AFTER,
      branch: config.branch ?? 'HEAD',
      localOnly: config.localOnly ?? false,
      onDegrade: config.onDegrade ?? (() => { }),
      onRecovered: config.onRecovered ?? (() => { }),
      onPark: config.onPark ?? (() => { }),
      logger: config.logger ?? console,
      spawnGit: config.spawnGit ?? defaultSpawnGit,
      authorEmail: config.authorEmail ?? getShogoAgentEmail(),
      authorName: config.authorName ?? getShogoAgentName(),
      afterCommit: config.afterCommit ?? null,
      beforeStage: config.beforeStage ?? null,
      stageExcludes: config.stageExcludes ?? [],
    }
  }

  /** Whether the sync is currently in degraded (push-failing) state. */
  get isDegraded(): boolean { return this._degraded }

  /** Consecutive failed push attempts since the last success. */
  get consecutiveFailures(): number { return this._consecutiveFailures }

  /**
   * Parked: the same failure has repeated past the threshold, so retries are
   * rate-limited to one per {@link PARKED_RETRY_MS} until something changes.
   */
  get isParked(): boolean { return this._parked }

  /** Failed durability steps since the last success, including earlier runs. */
  get lifetimeFailures(): number { return this._lifetimeFailures }

  /**
   * Request a sync. Coalesces with any pending debounce.
   *
   * `immediate=true` cancels the debounce and runs on the next tick —
   * use for explicit user actions or shutdown.
   */
  triggerSync(immediate: boolean = false): void {
    if (this.shuttingDown) return

    // Parked: the same failure has run 20+ times and will not fix itself. One
    // attempt per PARKED_RETRY_MS is enough to notice a fix, and a sync at the
    // end of every turn no longer turns into an unbounded retry loop.
    if (this._parked) {
      const since = Date.now() - this._lastAttemptAt
      if (since < PARKED_RETRY_MS) {
        this.cfg.logger.log(
          `[GitWorkspaceSync] parked — skipping this sync, next attempt in ` +
            `${Math.ceil((PARKED_RETRY_MS - since) / 1000)}s (state: ${this._stateFile ?? 'in memory'})`,
        )
        return
      }
    }

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
   * Synchronously flush the current working tree to the cloud and AWAIT
   * the push, WITHOUT shutting the sync down. Used by the publish flow
   * (`POST /agent/git-flush`) to guarantee the published source is in the
   * durable repo before the API tags HEAD.
   *
   * Cancels any pending debounce, waits for an in-flight push to finish,
   * then runs a fresh push cycle so the very latest tree lands.
   */
  async flush(): Promise<void> {
    if (this.shuttingDown) return
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
    // Wait out any in-flight push so we capture the latest staged tree.
    while (this.isPushing) {
      await new Promise((r) => setTimeout(r, 50))
    }
    await this.runPushCycle()
  }

  /**
   * Stop starting new cycles and wait for an in-flight one to finish. Used
   * while `.git` is swapped out from under the sync (host repo hydrate);
   * triggers that arrive meanwhile run once on {@link resume}.
   */
  async pause(): Promise<void> {
    this.paused = true
    while (this.isPushing) {
      await new Promise((r) => setTimeout(r, 50))
    }
  }

  resume(): void {
    if (!this.paused) return
    this.paused = false
    if (this.pendingWhilePaused) {
      this.pendingWhilePaused = false
      this.triggerSync(false)
    }
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
    if (this.parkedTimer) {
      clearTimeout(this.parkedTimer)
      this.parkedTimer = null
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
    if (this.paused) {
      this.pendingWhilePaused = true
      return
    }
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
    this._lastAttemptAt = Date.now()

    const commitEnv: NodeJS.ProcessEnv = {
      GIT_AUTHOR_NAME: this.cfg.authorName,
      GIT_AUTHOR_EMAIL: this.cfg.authorEmail,
      GIT_COMMITTER_NAME: this.cfg.authorName,
      GIT_COMMITTER_EMAIL: this.cfg.authorEmail,
    }

    try {
      // A history rewrite is running in this repo: staging now would race the
      // rewrite's ref move. Skip the turn; the next one commits everything.
      if (isRepairInProgress(workspaceDir)) {
        logger.log('[GitWorkspaceSync] checkpoint repo is being repaired — skipping this turn')
        return
      }

      // Shogo's own runtime state (`.shogo/sessions.db`, `-wal`, logs, `.tmp/`,
      // `.shogo-cwd-*`) is never source. Ignore rules do not apply to a path that
      // is already tracked, so this pass is what stops a repo seeded before
      // SHO-105 from re-staging its live databases forever — and it clears a
      // stale `.git/index.lock` that would otherwise fail every subsequent stage.
      const untrackedState = await prepareCheckpointRepo(workspaceDir, { logger })
      if (untrackedState > 0) {
        logger.log(`[GitWorkspaceSync] untracked ${untrackedState} Shogo runtime-state path(s)`)
      }

      // LFS hook: track newly-introduced large files before staging so the
      // clean filter writes pointers, not raw bytes. Best-effort — never let
      // it block the commit/push.
      if (this.cfg.beforeStage) {
        try {
          await this.cfg.beforeStage()
        } catch (hookErr: any) {
          logger.warn(`[GitWorkspaceSync] beforeStage hook threw: ${hookErr?.message ?? hookErr}`)
        }
      }

      // A path whose segment is a reserved Windows device name (`nul`,
      // `aux.txt`, `sub/CON`) can never be indexed on Windows, where `git add`
      // exits 128 and the whole backup stops (SHO-180). It cannot be checked
      // out there either, so skip it on every platform — desktop and cloud stay
      // on one code path — and name it once so the user can delete it.
      const reserved = await this.reservedUntrackedPaths(spawnGit, workspaceDir, commitEnv)
      for (const p of reserved) this.warnReservedPath(p)

      // Stage everything (respects `.gitignore`, skips the reserved names).
      const excludes = [
        ...(await excludePathspecs(
          this.cfg.stageExcludes,
          async (p) => (await spawnGit(['check-ignore', '-q', '--', p], workspaceDir, commitEnv)).exitCode === 0,
        )),
        ...reserved.map((p) => `:(exclude,literal)${p}`),
      ]
      await this.stageAll(spawnGit, excludes, workspaceDir, commitEnv)

      // `git diff --cached --quiet` exits 0 when nothing is staged, 1 when
      // there is; anything else (e.g. dubious ownership) is an error.
      const diff = await spawnGit(['diff', '--cached', '--quiet'], workspaceDir, commitEnv)
      if (diff.exitCode !== 0 && diff.exitCode !== 1) {
        throw new Error(`git diff exited ${diff.exitCode}: ${(diff.stderr || '').slice(0, 500)}`)
      }
      const hasChanges = diff.exitCode === 1

      if (hasChanges) {
        const message = `auto: ${new Date().toISOString()}`
        await this.runGit(
          spawnGit,
          withShogoCommitTrailer(['commit', '-m', message, '--no-verify'], commitEnv),
          workspaceDir,
          commitEnv,
        )
      }

      // A clean tree can still hold commits that never reached durable
      // storage: the agent (or user) can `git commit` from the shell, which
      // leaves nothing staged for us. Compare HEAD to the last sha we made
      // durable and run the durability step whenever it moved.
      const head = await spawnGit(['rev-parse', 'HEAD'], workspaceDir, commitEnv)
      const sha = head.exitCode === 0 ? head.stdout.trim() : ''
      if (!hasChanges && (!sha || sha === this._lastDurableSha)) {
        // Nothing new (or an unborn HEAD) — nothing to persist.
        return
      }

      if (this.cfg.localOnly) {
        // Pod-owned durability: no cloud origin to push to. Hand HEAD to
        // afterCommit (persist `.git` to object storage + record the
        // ProjectCheckpoint row). Throwing here is treated like a push
        // failure → retry/backoff/degrade.
        if (this.cfg.afterCommit) {
          await this.cfg.afterCommit(sha)
        }
      } else {
        // Push with the bearer header via `-c` so it never lands in argv-as-URL.
        const header = `http.extraHeader=Authorization: Bearer ${this.cfg.runtimeAuthSecret}`
        await this.runGit(
          spawnGit,
          ['-c', header, 'push', url, branch],
          workspaceDir,
          commitEnv,
        )
      }

      // SUCCESS — clear backoff + recover from degraded state if applicable.
      if (sha) this._lastDurableSha = sha
      if (this.backoffTimer) {
        clearTimeout(this.backoffTimer)
        this.backoffTimer = null
      }
      if (this.parkedTimer) {
        clearTimeout(this.parkedTimer)
        this.parkedTimer = null
      }
      const wasDegraded = this._degraded
      const wasParked = this._parked
      this._consecutiveFailures = 0
      this._degraded = false
      this._parked = false
      this._sameReasonStreak = 0
      this._lastFailureReason = null
      this.resetLifetimeFailures()
      if (wasDegraded) {
        logger.log(
          this.cfg.localOnly
            ? `[GitWorkspaceSync] checkpoint commits are landing again`
            : `[GitWorkspaceSync] recovered after push success — re-suppressing S3 Layer 2`,
        )
        try { this.cfg.onRecovered() } catch (err: any) {
          logger.error(`[GitWorkspaceSync] onRecovered threw:`, err?.message ?? err)
        }
      }
      if (wasParked) {
        logger.log('[GitWorkspaceSync] left parked state — durability is working again')
      }
    } catch (err: any) {
      const localOnly = this.cfg.localOnly
      this._consecutiveFailures += 1
      const reason = `${err?.message ?? err}`
      this.recordLifetimeFailure(reason)
      logger.warn(
        `[GitWorkspaceSync] ${localOnly ? 'checkpoint commit' : 'push'} failed ` +
          `(attempt ${this._consecutiveFailures}, ${this._lifetimeFailures} since ` +
          `${this._firstFailureAt ?? 'the first failure'}): ${reason}`,
      )

      // Degrade once after threshold reached.
      if (
        !this._degraded &&
        this.cfg.degradeAfterFailures > 0 &&
        this._consecutiveFailures >= this.cfg.degradeAfterFailures
      ) {
        this._degraded = true
        logger.warn(
          localOnly
            ? `[GitWorkspaceSync] checkpoint durability degraded after ${this._consecutiveFailures} consecutive failures`
            : `[GitWorkspaceSync] cloud-sync degraded after ${this._consecutiveFailures} consecutive failures — re-enabling S3 Layer 2`,
        )
        try { this.cfg.onDegrade(reason) } catch (cbErr: any) {
          logger.error(`[GitWorkspaceSync] onDegrade threw:`, cbErr?.message ?? cbErr)
        }
      }

      // Same failure, over and over: stop treating it as transient.
      const key = firstLineOf(reason)
      if (key === this._lastFailureReason) {
        this._sameReasonStreak += 1
      } else {
        this._sameReasonStreak = 1
        if (this._parked) {
          logger.log('[GitWorkspaceSync] failure reason changed — leaving parked state')
          this._parked = false
          if (this.parkedTimer) {
            clearTimeout(this.parkedTimer)
            this.parkedTimer = null
          }
        }
      }
      this._lastFailureReason = key

      if (!this._parked && this._sameReasonStreak >= PARK_AFTER_FAILURES) {
        this.enterParked(reason)
        return
      }
      if (this._parked) {
        this.scheduleParkedRetry()
        return
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
   * Stop the retry loop and tell the runtime once. The next attempt is
   * {@link PARKED_RETRY_MS} away, driven either by that timer or by a
   * `triggerSync` that has waited long enough.
   */
  private enterParked(reason: string): void {
    const { logger } = this.cfg
    this._parked = true
    if (this.backoffTimer) {
      clearTimeout(this.backoffTimer)
      this.backoffTimer = null
    }
    const what = this.cfg.localOnly ? 'checkpoint commits' : 'pushes'
    logger.warn(
      `[GitWorkspaceSync] parked: ${this._sameReasonStreak} failed ${what} for the same reason ` +
        `(${this._lifetimeFailures} since ${this._firstFailureAt ?? 'the first failure'}) — ` +
        `no more backoff retries; one attempt every ${Math.round(PARKED_RETRY_MS / 60_000)} min ` +
        `until the reason changes. Cause: ${firstLineOf(reason)}`,
    )
    try {
      this.cfg.onPark({
        reason: firstLineOf(reason),
        consecutiveFailures: this._sameReasonStreak,
        lifetimeFailures: this._lifetimeFailures,
        firstFailureAt: this._firstFailureAt,
        stateFile: this._stateFile,
      })
    } catch (cbErr: any) {
      logger.error(`[GitWorkspaceSync] onPark threw:`, cbErr?.message ?? cbErr)
    }
    this.scheduleParkedRetry()
  }

  private scheduleParkedRetry(): void {
    if (this.shuttingDown || this.parkedTimer) return
    this.parkedTimer = setTimeout(() => {
      this.parkedTimer = null
      void this.runPushCycle()
    }, PARKED_RETRY_MS)
  }

  /** Where the lifetime failure counter lives, or null when there is no `.git`. */
  private syncStateFile(): string | null {
    const gitDir = join(this.cfg.workspaceDir, '.git')
    try {
      // A linked worktree's `.git` is a file pointing elsewhere; there is no
      // per-worktree directory of our own to write into then.
      return statSync(gitDir).isDirectory() ? join(gitDir, SYNC_STATE_FILE) : null
    } catch {
      return null
    }
  }

  /**
   * Read the persisted counter once, so a restart continues the same streak
   * ("attempt 3, 3493 since Tuesday") instead of restarting at zero.
   */
  private loadSyncState(): void {
    this._stateLoaded = true
    this._stateFile = this.syncStateFile()
    if (!this._stateFile) return
    try {
      const raw = JSON.parse(readFileSync(this._stateFile, 'utf8')) as {
        lifetimeFailures?: unknown
        firstFailureAt?: unknown
      }
      if (typeof raw.lifetimeFailures === 'number' && Number.isFinite(raw.lifetimeFailures) && raw.lifetimeFailures > 0) {
        this._lifetimeFailures = Math.floor(raw.lifetimeFailures)
      }
      if (typeof raw.firstFailureAt === 'string' && raw.firstFailureAt) {
        this._firstFailureAt = raw.firstFailureAt
      }
    } catch {
      // Missing or unreadable: start a fresh count rather than fail the sync.
    }
  }

  private recordLifetimeFailure(reason: string): void {
    if (!this._stateLoaded) this.loadSyncState()
    if (!this._firstFailureAt) this._firstFailureAt = new Date().toISOString()
    this._lifetimeFailures += 1
    this.writeSyncState(firstLineOf(reason))
  }

  /** A successful durability step ends the streak, so the counter starts at zero again. */
  private resetLifetimeFailures(): void {
    if (this._lifetimeFailures === 0 && !this._firstFailureAt) return
    this._lifetimeFailures = 0
    this._firstFailureAt = null
    if (!this._stateFile) this._stateFile = this.syncStateFile()
    this.writeSyncState(null)
  }

  private writeSyncState(lastReason: string | null): void {
    if (!this._stateFile) return
    try {
      writeFileSync(
        this._stateFile,
        JSON.stringify(
          {
            lifetimeFailures: this._lifetimeFailures,
            firstFailureAt: this._firstFailureAt,
            lastFailureAt: lastReason ? new Date().toISOString() : null,
            lastReason,
          },
          null,
          2,
        ),
      )
    } catch (err: any) {
      // Losing the counter must never fail the sync itself.
      this.cfg.logger.warn(
        `[GitWorkspaceSync] could not persist sync state to ${this._stateFile}: ${err?.message ?? err}`,
      )
    }
  }

  /** Untracked paths git could list; the reserved ones are dropped from staging. */
  private async reservedUntrackedPaths(
    spawnGit: SpawnGitFn,
    cwd: string,
    env: NodeJS.ProcessEnv,
  ): Promise<string[]> {
    const ls = await spawnGit(['ls-files', '-o', '--exclude-standard', '-z'], cwd, env)
    // Best-effort: a failure here must never block the commit itself.
    if (ls.exitCode !== 0) return []
    return findReservedPaths(ls.stdout.split('\0').filter((p) => p.length > 0))
  }

  /** One warning per reserved path per process, naming it and how to get rid of it. */
  private warnReservedPath(path: string): void {
    const key = `${this.cfg.workspaceDir}\u0000${path}`
    if (warnedReservedPaths.has(key)) return
    warnedReservedPaths.add(key)
    this.cfg.logger.warn(
      `[GitWorkspaceSync] not staging ${JSON.stringify(path)}: a reserved Windows device name ` +
        `can never be committed or checked out on Windows. Remove it with ` +
        `rm -f -- ${JSON.stringify(path)} and the warning stops.`,
    )
  }

  /**
   * `git add -A` with the pathspec excludes. If git still refuses one path
   * ("unable to index file '<p>'"), retry once without it: a single bad file
   * costs that file, not the whole backup.
   */
  private async stageAll(
    spawnGit: SpawnGitFn,
    excludes: string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
  ): Promise<void> {
    const base = ['add', '-A', ...(excludes.length ? ['--', '.', ...excludes] : [])]
    const first = await spawnGit(base, cwd, env)
    if (first.exitCode === 0) return

    const bad = unindexablePath(first.stderr || '')
    if (!bad) throw gitExitError('add', first)
    this.cfg.logger.warn(
      `[GitWorkspaceSync] git add could not index ${JSON.stringify(bad)} — ` +
        `retrying without it so the rest of the workspace still commits`,
    )
    const retry = await spawnGit(
      ['add', '-A', '--', '.', ...excludes, `:(exclude,literal)${bad}`],
      cwd,
      env,
    )
    if (retry.exitCode !== 0) throw gitExitError('add', retry)
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
    if (r.exitCode !== 0) throw gitExitError(args[0], r)
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
 * and clamp anything unrecognized to `git_only` (the new default — the
 * durable object-store-backed git repo is the source of truth for
 * checkpoints + history). Explicit `s3` / `dual_shadow` still honored.
 * Exported for unit testing.
 */
export function resolveCloudSyncMode(env: NodeJS.ProcessEnv = process.env): CloudSyncMode {
  const raw = (env.SHOGO_CLOUD_SYNC_MODE ?? 'git_only').toLowerCase()
  if (raw === 's3' || raw === 'dual_shadow') return raw
  return 'git_only'
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
  opts: Pick<GitWorkspaceSyncConfig, 'onDegrade' | 'onRecovered' | 'onPark' | 'debounceMs' | 'degradeAfterFailures' | 'logger' | 'localOnly' | 'afterCommit' | 'beforeStage' | 'stageExcludes'> = {},
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
