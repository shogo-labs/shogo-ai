// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Claude Code V2 SDK session lifecycle management.
 * Shared between runtime and agent-runtime.
 *
 * Each runtime provides its own `buildSessionOptions` (tools, cwd, mcpServers differ),
 * but session caching, interruption, and pre-warming logic is identical.
 *
 * Remaining workarounds (SDK v0.2.76):
 *   - includePartialMessages / allowDangerouslySkipPermissions: patched via postinstall
 *   - interrupt(): session.close() workaround (no upstream interrupt() API yet)
 */

import {
  unstable_v2_createSession,
  type SDKSession,
  type SDKSessionOptions,
} from '@anthropic-ai/claude-agent-sdk'

export type ModelTier = 'haiku' | 'sonnet' | 'opus'

/**
 * Extended session options — includes fields the V2 constructor reads
 * but the published types don't fully expose yet.
 */
export interface V2SessionOptions extends SDKSessionOptions {
  cwd?: string
  settingSources?: ('user' | 'project' | 'local')[]
  includePartialMessages?: boolean
  mcpServers?: Record<string, any>
  allowDangerouslySkipPermissions?: boolean
  [key: string]: any
}

export interface SessionManagerOptions {
  buildSessionOptions: (model: ModelTier) => V2SessionOptions
  defaultModel?: ModelTier
  logPrefix?: string
}

export interface SessionManager {
  getOrCreate(model: ModelTier): SDKSession
  /** Ensure MCP servers are configured on the session (call before first send). */
  ensureMcpServers(model: ModelTier): Promise<void>
  interrupt(model: string): Promise<void>
  prewarm(): Promise<void>
  isActive(model: string): boolean
  markActive(model: string): void
  markInactive(model: string): void
  setActiveQuery(model: string, query: AsyncGenerator<any, void>): void
  deleteActiveQuery(model: string): void
}

export function createSessionManager(options: SessionManagerOptions): SessionManager {
  const {
    buildSessionOptions,
    defaultModel = 'sonnet',
    logPrefix = 'runtime',
  } = options

  const sessionCache = new Map<string, SDKSession>()
  const activeSessions = new Set<string>()
  const activeQueries = new Map<string, AsyncGenerator<any, void>>()
  const sessionLocks = new Map<string, Promise<void>>()
  const mcpConfigured = new Set<string>()
  let prewarmAborted = false

  function withLock(model: string, fn: () => Promise<void>): Promise<void> {
    const prev = sessionLocks.get(model) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    sessionLocks.set(model, next)
    return next
  }

  function getOrCreate(modelName: ModelTier): SDKSession {
    const existing = sessionCache.get(modelName)
    if (existing && !(existing as any).closed) {
      return existing
    }
    if (existing) {
      console.log(`[${logPrefix}] Session for ${modelName} was closed, creating new one`)
      sessionCache.delete(modelName)
      activeSessions.delete(modelName)
      mcpConfigured.delete(modelName)
    }

    const opts = buildSessionOptions(modelName)
    const session = unstable_v2_createSession(opts)
    sessionCache.set(modelName, session)
    console.log(`[${logPrefix}] Created V2 session for model: ${modelName}`)
    return session
  }

  /**
   * Configure MCP servers on the session's internal query object.
   *
   * The V2 SDK has a bug where unstable_v2_createSession() does NOT forward
   * the mcpServers option to the CLI subprocess. The workaround is to access
   * the internal query object and call setMcpServers() on it directly.
   */
  async function ensureMcpServers(modelName: ModelTier): Promise<void> {
    if (mcpConfigured.has(modelName)) return
    const opts = buildSessionOptions(modelName)
    const mcpServers = opts.mcpServers
    if (!mcpServers || Object.keys(mcpServers).length === 0) return

    const session = getOrCreate(modelName)
    const query = (session as any).query
    if (!query || typeof query.setMcpServers !== 'function') {
      console.warn(`[${logPrefix}] Cannot configure MCP servers — query.setMcpServers not available`)
      return
    }
    try {
      console.log(`[${logPrefix}] Configuring MCP servers for ${modelName}: ${Object.keys(mcpServers).join(', ')}`)
      const result = await query.setMcpServers(mcpServers)
      mcpConfigured.add(modelName)
      console.log(`[${logPrefix}] MCP servers configured for ${modelName}:`, JSON.stringify(result))
    } catch (err: any) {
      console.error(`[${logPrefix}] Failed to configure MCP servers for ${modelName}:`, err.message)
    }
  }

  /**
   * Interrupt an active session.
   *
   * The V2 SDK's stream() AsyncGenerator doesn't propagate cancellation to the
   * CLI process. Workaround: close the entire session (kills the CLI) and
   * remove from cache. Next getOrCreate() starts fresh.
   */
  async function interrupt(modelName: string): Promise<void> {
    return withLock(modelName, async () => {
      console.log(`[${logPrefix}] Interrupting active session for ${modelName}`)

      const activeQuery = activeQueries.get(modelName)
      if (activeQuery) {
        try { await activeQuery.return(undefined as any) } catch {}
        activeQueries.delete(modelName)
      }

      const session = sessionCache.get(modelName)
      if (session) {
        try {
          ;(session as any).close?.()
          console.log(`[${logPrefix}] Closed session for ${modelName}`)
        } catch (err) {
          console.warn(`[${logPrefix}] Error closing session for ${modelName}:`, err)
        }
        sessionCache.delete(modelName)
      }

      activeSessions.delete(modelName)
      mcpConfigured.delete(modelName)
      console.log(`[${logPrefix}] Session cleanup complete for ${modelName}`)
    })
  }

  /**
   * Pre-warm: create a session and send a ping so the CLI subprocess is ready
   * when the first real chat message arrives.
   */
  async function prewarm(): Promise<void> {
    const startTime = performance.now()
    prewarmAborted = false

    if (activeSessions.has(defaultModel)) {
      console.log(`[${logPrefix}] Pre-warm skipped — session ${defaultModel} is already active`)
      return
    }

    console.log(`[${logPrefix}] Pre-warming V2 session (${defaultModel})...`)
    try {
      const session = getOrCreate(defaultModel)

      if (activeSessions.has(defaultModel) || prewarmAborted) {
        console.log(`[${logPrefix}] Pre-warm aborted — session ${defaultModel} became active`)
        return
      }

      activeSessions.add(defaultModel)
      await session.send('ping')

      for await (const msg of session.stream()) {
        if (msg.type === 'result') break
        if (prewarmAborted) {
          console.log(`[${logPrefix}] Pre-warm interrupted by incoming request`)
          break
        }
      }
      activeSessions.delete(defaultModel)

      const elapsed = performance.now() - startTime
      console.log(`[${logPrefix}] Pre-warm complete in ${(elapsed / 1000).toFixed(2)}s`)
    } catch (error: any) {
      activeSessions.delete(defaultModel)
      const elapsed = performance.now() - startTime
      console.error(`[${logPrefix}] Pre-warm failed after ${(elapsed / 1000).toFixed(2)}s:`, error.message)
    }
  }

  return {
    getOrCreate,
    ensureMcpServers,
    interrupt,
    prewarm,
    isActive: (model: string) => activeSessions.has(model),
    markActive: (model: string) => {
      prewarmAborted = true
      activeSessions.add(model)
    },
    markInactive: (model: string) => activeSessions.delete(model),
    setActiveQuery: (model: string, query: AsyncGenerator<any, void>) => activeQueries.set(model, query),
    deleteActiveQuery: (model: string) => activeQueries.delete(model),
  }
}
