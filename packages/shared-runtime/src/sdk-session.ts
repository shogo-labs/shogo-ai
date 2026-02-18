/**
 * Claude Code V2 SDK session lifecycle management.
 * Shared between project-runtime and agent-runtime.
 *
 * Each runtime provides its own `buildSessionOptions` (tools, cwd, mcpServers differ),
 * but session caching, interruption, and pre-warming logic is identical.
 */

import {
  unstable_v2_createSession,
  type SDKSession,
  type SDKSessionOptions,
} from '@anthropic-ai/claude-agent-sdk'

export type ModelTier = 'haiku' | 'sonnet' | 'opus'

/**
 * Extended session options — includes fields the V2 constructor reads
 * but doesn't expose in the published SDKSessionOptions types.
 * These are forwarded to the underlying CLI process despite not being typed.
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

  function getOrCreate(modelName: ModelTier): SDKSession {
    const existing = sessionCache.get(modelName)
    if (existing && !(existing as any).closed) {
      return existing
    }
    if (existing) {
      console.log(`[${logPrefix}] Session for ${modelName} was closed, creating new one`)
      sessionCache.delete(modelName)
      activeSessions.delete(modelName)
    }

    const opts = buildSessionOptions(modelName)
    const session = unstable_v2_createSession(opts)
    sessionCache.set(modelName, session)
    console.log(`[${logPrefix}] Created V2 session for model: ${modelName}`)
    return session
  }

  /**
   * Interrupt an active session for a given model.
   *
   * The V2 SDK session's stream() returns an AsyncGenerator. Calling
   * generator.return() only stops JS iteration but does NOT stop the CLI
   * from generating. The fix: close the entire session (kills the CLI process)
   * and remove it from cache. The next getOrCreate() creates a fresh session.
   */
  async function interrupt(modelName: string): Promise<void> {
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
    console.log(`[${logPrefix}] Session cleanup complete for ${modelName}`)
  }

  /**
   * Pre-warm: create a session and send a ping to initialize the CLI subprocess
   * and load MCP servers, so the first real chat message doesn't pay cold-start cost.
   */
  async function prewarm(): Promise<void> {
    const startTime = performance.now()

    if (activeSessions.has(defaultModel)) {
      console.log(`[${logPrefix}] Pre-warm skipped — session ${defaultModel} is already active`)
      return
    }

    console.log(`[${logPrefix}] Pre-warming V2 session (${defaultModel})...`)
    try {
      const session = getOrCreate(defaultModel)

      if (activeSessions.has(defaultModel)) {
        console.log(`[${logPrefix}] Pre-warm aborted — session ${defaultModel} became active`)
        return
      }

      activeSessions.add(defaultModel)
      await session.send('ping')

      for await (const msg of session.stream()) {
        if (msg.type === 'result') break
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
    interrupt,
    prewarm,
    isActive: (model: string) => activeSessions.has(model),
    markActive: (model: string) => activeSessions.add(model),
    markInactive: (model: string) => activeSessions.delete(model),
    setActiveQuery: (model: string, query: AsyncGenerator<any, void>) => activeQueries.set(model, query),
    deleteActiveQuery: (model: string) => activeQueries.delete(model),
  }
}
