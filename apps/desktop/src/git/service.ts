// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Per-workspace git service. Owns the polling loop, the file-watcher
// debounce, and the event bus the IPC layer broadcasts from. One
// `GitWorkspace` instance per absolute path; the registry deduplicates
// subscriptions across renderer clients.

import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { join, resolve as resolvePath } from 'node:path'

import { type FileStatus, parsePorcelainV2, type PorcelainStatus, shortCode } from './porcelain'
import { probeGit, runGit } from './repository'

/** Public snapshot pushed to renderers. */
export interface GitSnapshot {
  workspaceRoot: string
  isRepo: boolean
  branch: string | null
  detached: boolean
  upstream: string | null
  ahead: number
  behind: number
  /** Map relative-posix-path → short status code. */
  fileStatus: Record<string, ReturnType<typeof shortCode>>
  /** Conflicted file paths (for SCM viewlet in G2). */
  conflictPaths: string[]
  /** Last refresh timestamp (ms since epoch). */
  refreshedAt: number
  /** Last error string, if the previous refresh failed. */
  error: string | null
}

const POLL_INTERVAL_MS = 5_000
const REFRESH_DEBOUNCE_MS = 300

/**
 * State for a single workspace path. Shared across all subscribers on that
 * path so we only run one `git status` poll regardless of how many
 * renderers/components want updates.
 */
class GitWorkspace {
  private timer: NodeJS.Timeout | null = null
  private debounceTimer: NodeJS.Timeout | null = null
  private subscribers = new Set<(snap: GitSnapshot) => void>()
  private snapshot: GitSnapshot
  private inflight: Promise<void> | null = null
  private destroyed = false

  constructor(public readonly root: string) {
    this.snapshot = {
      workspaceRoot: root,
      isRepo: false,
      branch: null,
      detached: false,
      upstream: null,
      ahead: 0,
      behind: 0,
      fileStatus: {},
      conflictPaths: [],
      refreshedAt: 0,
      error: null,
    }
  }

  subscribe(cb: (snap: GitSnapshot) => void): () => void {
    this.subscribers.add(cb)
    // Push the current snapshot immediately so the renderer renders
    // something on first paint instead of waiting up to 5 s.
    cb(this.snapshot)
    // Boot the poller on first subscribe.
    if (!this.timer && !this.destroyed) {
      this.refresh()
      this.timer = setInterval(() => this.refresh(), POLL_INTERVAL_MS)
    }
    return () => {
      this.subscribers.delete(cb)
      if (this.subscribers.size === 0) {
        this.pauseTimers()
      }
    }
  }

  /** Trigger a refresh now (debounced — multiple calls within 300 ms collapse). */
  requestRefresh(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      void this.refresh()
    }, REFRESH_DEBOUNCE_MS)
  }

  current(): GitSnapshot {
    return this.snapshot
  }

  destroy(): void {
    this.destroyed = true
    this.pauseTimers()
    this.subscribers.clear()
  }

  private pauseTimers(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
  }

  private async refresh(): Promise<void> {
    if (this.destroyed) return
    if (this.inflight) return this.inflight
    this.inflight = (async () => {
      try {
        // Fast path — is this even a repo? Cheap fs check first to avoid
        // an "fatal: not a git repository" round-trip on every poll for
        // non-repo workspaces.
        const isRepoQuick = existsSync(join(this.root, '.git'))
        if (!isRepoQuick) {
          // Could still be inside a parent repo — confirm with rev-parse.
          // But for G1 we treat the workspace as the repo root; G3 lifts this.
          const probe = await runGit(['rev-parse', '--show-toplevel'], { cwd: this.root, timeoutMs: 3_000 })
          if (!probe.ok || probe.stdout.trim() !== resolvePath(this.root)) {
            this.update({ isRepo: false, branch: null, detached: false, upstream: null, ahead: 0, behind: 0, fileStatus: {}, conflictPaths: [], error: null })
            return
          }
        }

        const v = await probeGit()
        if (!v.available) {
          this.update({ isRepo: false, branch: null, detached: false, upstream: null, ahead: 0, behind: 0, fileStatus: {}, conflictPaths: [], error: 'git not on PATH' })
          return
        }
        if (!v.supportsPorcelainV2) {
          this.update({ isRepo: false, branch: null, detached: false, upstream: null, ahead: 0, behind: 0, fileStatus: {}, conflictPaths: [], error: 'git too old (need >= 2.11)' })
          return
        }

        const res = await runGit(
          ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all'],
          { cwd: this.root, timeoutMs: 10_000 },
        )
        if (!res.ok) {
          this.update({ isRepo: false, error: res.stderr.trim() || `git status exit ${res.code}` })
          return
        }
        const parsed = parsePorcelainV2(res.stdout)
        const fileStatus: Record<string, ReturnType<typeof shortCode>> = {}
        const conflictPaths: string[] = []
        for (const f of parsed.files) {
          // Skip ignored files from the broadcast — they spam the decorator
          // map and the user has no need to see them.
          if (f.index === 'ignored') continue
          fileStatus[f.path] = shortCode(f)
          if (f.isConflict) conflictPaths.push(f.path)
        }
        this.update({
          isRepo: true,
          branch: parsed.branch,
          detached: parsed.detached,
          upstream: parsed.upstream,
          ahead: parsed.ahead,
          behind: parsed.behind,
          fileStatus,
          conflictPaths,
          error: null,
        })
      } catch (err) {
        this.update({ error: err instanceof Error ? err.message : String(err) })
      } finally {
        this.inflight = null
      }
    })()
    return this.inflight
  }

  private update(patch: Partial<GitSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch, refreshedAt: Date.now() }
    for (const cb of this.subscribers) {
      try {
        cb(this.snapshot)
      } catch (err) {
        console.warn('[shogo-git] subscriber threw', err)
      }
    }
  }
}

const REGISTRY = new Map<string, GitWorkspace>()

/** Get or create the GitWorkspace for an absolute path. */
export function getOrCreateGitWorkspace(root: string): GitWorkspace {
  const key = resolvePath(root)
  let ws = REGISTRY.get(key)
  if (!ws) {
    ws = new GitWorkspace(key)
    REGISTRY.set(key, ws)
  }
  return ws
}

/** Destroy all workspaces (used on app quit). */
export function disposeAllGitWorkspaces(): void {
  for (const ws of REGISTRY.values()) ws.destroy()
  REGISTRY.clear()
}

// Re-export for IPC layer convenience.
export type { FileStatus, PorcelainStatus }
