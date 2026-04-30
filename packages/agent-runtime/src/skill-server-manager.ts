// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SkillServerManager — compatibility shim
 *
 * The legacy "skill server" (`.shogo/server/`) has been retired in favour
 * of the project's own backend at root `server.tsx` + `prisma/schema.prisma`,
 * managed by {@link PreviewManager}. This file used to spawn and watch a
 * separate Bun process on port 4100; it now exists only as a thin
 * delegation surface so the gateway and tools can keep their existing
 * call sites unchanged while we finish the refactor.
 *
 * Eventually this file should be deleted entirely and the gateway should
 * talk to `PreviewManager` directly. For now the indirection costs a
 * single extra method dispatch per call — negligible compared to the
 * file-system / fetch operations they wrap.
 *
 * One-shot migration of `.shogo/server/` into root paths is handled by
 * {@link migrateSkillServerToRoot} (see `migrations/skill-server-to-root.ts`),
 * called from server.ts startup before PreviewManager.start().
 */

import type { PreviewManager, ApiServerPhase } from './preview-manager'

export type SkillServerPhase = ApiServerPhase

export interface SkillServerManagerConfig {
  workspaceDir: string
}

const LOG_PREFIX = 'api-server-shim'
const DEFAULT_PORT = 3001

/**
 * Resolve the same port the unified `PreviewManager` will pick when it
 * eventually attaches. Mirrors `resolveApiServerPort` over there but kept
 * local to avoid an import cycle with the `PreviewManager` module's
 * heavyweight side-effects (it pulls in `child_process`, `fs.watch`, ...).
 *
 * Precedence: `API_SERVER_PORT` → legacy `SKILL_SERVER_PORT` → 3001. Both
 * env vars are still emitted by the local-worker / docker-worker / VM
 * harness for the per-instance dynamic-port contract; honoring them here
 * means callers reading `.port` before `attach()` (gateway prompt
 * builders during cold-start, eg.) see the same value as the eventually
 * attached `PreviewManager`.
 */
function resolveFallbackPort(): number {
  const candidates = [process.env.API_SERVER_PORT, process.env.SKILL_SERVER_PORT]
  for (const raw of candidates) {
    if (!raw) continue
    const n = parseInt(raw, 10)
    if (Number.isFinite(n) && n > 0) return n
  }
  return DEFAULT_PORT
}

export class SkillServerManager {
  private workspaceDir: string
  private pm: PreviewManager | null = null
  private fallbackPort: number

  constructor(config: SkillServerManagerConfig) {
    this.workspaceDir = config.workspaceDir
    // We're a shim — the real port comes from PreviewManager once attached.
    // Resolve the same dynamic port contract the manager will use so
    // callers that read `.port` before `attach()` don't see a stale 3001.
    this.fallbackPort = resolveFallbackPort()
  }

  /**
   * Attach the shim to the runtime's `PreviewManager` once both have
   * been constructed. Called from server.ts during boot.
   */
  attach(pm: PreviewManager): void {
    this.pm = pm
  }

  get port(): number {
    return this.pm?.apiServerPort ?? this.fallbackPort
  }

  get phase(): SkillServerPhase {
    return this.pm?.apiServerPhase ?? 'idle'
  }

  get isRunning(): boolean {
    return this.pm?.apiServerPhase === 'healthy'
  }

  get url(): string {
    return this.pm?.apiServerUrl ?? `http://localhost:${this.fallbackPort}`
  }

  get lastGenerateError(): string | null {
    return this.pm?.apiLastGenerateError ?? null
  }

  /**
   * Always true once the runtime template is seeded — `server.tsx` is
   * always editable for custom routes. Kept for source-compatibility
   * with the gateway prompt builder.
   */
  get hasCustomRoutes(): boolean {
    return true
  }

  getActiveRoutes(): string[] {
    return this.pm?.getActiveRoutes() ?? []
  }

  getSchemaModels(): string[] {
    return this.pm?.getSchemaModels() ?? []
  }

  /**
   * Force regenerate + restart. The previous implementation would also
   * call `bun install` and re-spawn a separate server process; both are
   * now PreviewManager's responsibility.
   */
  async sync(): Promise<{ ok: boolean; phase: SkillServerPhase; error?: string }> {
    if (!this.pm) {
      return { ok: false, phase: this.phase, error: 'PreviewManager not attached' }
    }
    return this.pm.sync()
  }

  /** Same as sync() — no separate restart path is needed at root. */
  async restart(): Promise<void> {
    if (!this.pm) return
    await this.pm.sync()
  }

  /**
   * Fast restart for `custom-routes.ts` edits — kills + respawns
   * `server.tsx` without running `shogo generate` or `prisma db push`.
   * Use this from `edit_file`/`write_file` post-hooks when the agent
   * touches the custom-routes file; for any schema change use
   * {@link sync} instead.
   *
   * No-ops gracefully when the shim hasn't been attached yet (boot
   * phase, eg). Errors during restart bubble up so the caller can
   * surface them to the agent.
   */
  async restartApiServerOnly(): Promise<void> {
    if (!this.pm) return
    await this.pm.restartApiServerOnly()
  }

  /** No-op: the `PreviewManager` owns the API server lifecycle. */
  async start(): Promise<{ started: boolean; port: number | null }> {
    if (!this.pm) return { started: false, port: null }
    const port = this.pm.apiServerPort
    return { started: port !== null, port }
  }

  /** No-op: the `PreviewManager` owns the API server lifecycle. */
  async stop(): Promise<void> {
    // Nothing to stop — the legacy skill-server process is gone.
    void this.workspaceDir
    void LOG_PREFIX
  }

  /**
   * No-op for warm-pool prewarm. The runtime template's node_modules are
   * pre-installed via `ensureWorkspaceDeps`; the legacy skill-server
   * `cpSync` no longer applies.
   */
  static prewarmDeps(_workspaceDir: string): boolean {
    return false
  }
}
