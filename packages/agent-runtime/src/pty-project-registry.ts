// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Maps project ID → PtySessionManager so a single API/runtime process can
 * host PTY sessions for many projects (the local-dev API mode does this;
 * a runtime pod has exactly one workspace and uses a single manager
 * directly without this registry).
 *
 * Managers are created lazily on first use. Their per-workspace caps and
 * sweepers run independently — one project can be reaped at idle without
 * affecting another.
 */

import { PtySessionManager } from './pty-session-manager'

export interface RegistryOptions {
  /**
   * Map a project id to its workspace directory. Required because a
   * single API process serves many workspaces (`workspaces/<id>`).
   */
  resolveWorkspaceDir: (projectId: string) => string
  /** Forwarded to each manager. */
  maxSessions?: number
  idleTimeoutMs?: number
  maxAgeMs?: number
  gracePeriodMs?: number
  sweepIntervalMs?: number
}

export class ProjectPtyRegistry {
  private managers = new Map<string, PtySessionManager>()
  constructor(private opts: RegistryOptions) {}

  /** Get-or-create the manager for `projectId`. */
  for(projectId: string): PtySessionManager {
    let mgr = this.managers.get(projectId)
    if (mgr) return mgr
    mgr = new PtySessionManager({
      workspaceDir: this.opts.resolveWorkspaceDir(projectId),
      maxSessions: this.opts.maxSessions,
      idleTimeoutMs: this.opts.idleTimeoutMs,
      maxAgeMs: this.opts.maxAgeMs,
      gracePeriodMs: this.opts.gracePeriodMs,
      sweepIntervalMs: this.opts.sweepIntervalMs,
    })
    this.managers.set(projectId, mgr)
    return mgr
  }

  /** Look up without creating. Returns null if no manager exists yet. */
  peek(projectId: string): PtySessionManager | null {
    return this.managers.get(projectId) ?? null
  }

  /** Tear everything down (call on process shutdown). */
  shutdown(): void {
    for (const mgr of this.managers.values()) mgr.shutdown()
    this.managers.clear()
  }
}
