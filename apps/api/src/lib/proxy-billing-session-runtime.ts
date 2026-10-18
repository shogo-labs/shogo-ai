// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Local-safe billing-session seam for project/workspace chat.
 *
 * Chat still calls the same lifecycle hooks, but desktop has no Redis-backed
 * cloud billing ledger. Cloud mode dynamically loads the full implementation.
 *
 * The local implementation is typed against the real module (type-only
 * import, erased at build time) so its return shapes cannot drift from what
 * callers read. Without a session, the AI proxy records usage per call
 * instead of per turn — local usage is never billed either way.
 *
 * Except with Shogo Cloud forwarding: then the local AI proxy relays every
 * call to cloud and records nothing, so the turn's stream-reported usage
 * (`fallbackUsage` / `recordTurnUsage`) is the only local record of it.
 *
 * Without forwarding, the local AI proxy accumulates each call into the open
 * turn and the close records one `chat_message` usage event plus one
 * `main-chat` cost-analytics row, mirroring the cloud session close.
 */
import type * as CloudBillingSessionModule from './proxy-billing-session'
import type { BillingSessionFallbackUsage, BillingSessionQualitySignals } from './proxy-billing-session'
import { isShogoCloudForwarding } from './cloud-forwarding'
import type { LocalTurnUsage } from './local-turn-usage'

const recordLocalTurnUsage = async (turn: LocalTurnUsage) =>
  (await import('./local-turn-usage')).recordLocalTurnUsage(turn)

type CloudBillingSession = typeof CloudBillingSessionModule
type BillingSessionSeam = Pick<
  CloudBillingSession,
  | 'openSession'
  | 'closeSession'
  | 'hasSession'
  | 'hasActiveSession'
  | 'accumulateUsage'
  | 'accumulateImageUsage'
  | 'accumulateVideoUsage'
  | 'accumulate3dUsage'
  | 'setQualitySignals'
>

let cloud: CloudBillingSession | null = null
if (process.env.SHOGO_LOCAL_MODE !== 'true') {
  cloud = await import('./proxy-billing-session')
}

const EMPTY_RESULT = { billedUsd: 0, rawUsd: 0, totalTokens: 0 }

/** Who a local turn belongs to, kept only so its close can attribute stream-reported usage. */
interface LocalTurn {
  workspaceId: string
  userId: string
  openedAt: number
  quality: BillingSessionQualitySignals
  usage: Required<BillingSessionFallbackUsage>
  requestCount: number
}
const localTurns = new Map<string, LocalTurn>()
const turnKey = (projectId: string, chatSessionId?: string | null) => `${projectId}:${chatSessionId ?? ''}`

/** Composite key first, then the projectId-only key, like the cloud session lookup. */
function lookupLocalTurn(projectId: string, chatSessionId?: string | null): LocalTurn | undefined {
  return (chatSessionId ? localTurns.get(turnKey(projectId, chatSessionId)) : undefined)
    ?? localTurns.get(turnKey(projectId))
}

export const localBillingSession: BillingSessionSeam = {
  openSession: async (projectId, workspaceId, userId, chatSessionId) => {
    localTurns.set(turnKey(projectId, chatSessionId), {
      workspaceId,
      userId,
      openedAt: Date.now(),
      quality: {},
      usage: { model: 'sonnet', inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0 },
      requestCount: 0,
    })
  },
  closeSession: async (projectId, options = {}) => {
    const key = turnKey(projectId, options.chatSessionId)
    const turn = localTurns.get(key)
    localTurns.delete(key)
    if (!turn) return EMPTY_RESULT
    const { usage, requestCount, ...owner } = turn
    const base = { ...owner, projectId, chatSessionId: options.chatSessionId }
    if (!isShogoCloudForwarding()) {
      // Local usage is never billed, so a discarded partial still records the
      // provider spend it already incurred.
      if (requestCount === 0) return EMPTY_RESULT
      return recordLocalTurnUsage({ ...base, usage, requestCount, usageSource: 'local-proxy' })
    }
    if (!options.fallbackUsage || options.discardPartial || options.bookkeeping) return EMPTY_RESULT
    return recordLocalTurnUsage({ ...base, usage: options.fallbackUsage })
  },
  hasSession: async () => false,
  hasActiveSession: async () => false,
  accumulateUsage: async (projectId, model, inputTokens, outputTokens, cachedInputTokens = 0, cacheWriteTokens = 0, chatSessionId) => {
    if (isShogoCloudForwarding()) return false
    const turn = lookupLocalTurn(projectId, chatSessionId)
    if (!turn) return false
    turn.usage.model = model
    turn.usage.inputTokens += inputTokens
    turn.usage.outputTokens += outputTokens
    turn.usage.cachedInputTokens += cachedInputTokens
    turn.usage.cacheWriteTokens += cacheWriteTokens
    turn.requestCount += 1
    return true
  },
  accumulateImageUsage: async () => false,
  accumulateVideoUsage: async () => false,
  accumulate3dUsage: async () => false,
  setQualitySignals: async (projectId, quality, chatSessionId) => {
    const turn = lookupLocalTurn(projectId, chatSessionId)
    if (!turn) return false
    turn.quality = { ...turn.quality, ...quality }
    return true
  },
}

// Looked up per call so tests that `mock.module()` the cloud module still reach the mock.
const session = (): BillingSessionSeam => cloud ?? localBillingSession

export const openSession: BillingSessionSeam['openSession'] = (...args) => session().openSession(...args)
export const closeSession: BillingSessionSeam['closeSession'] = (...args) => session().closeSession(...args)
export const hasSession: BillingSessionSeam['hasSession'] = (...args) => session().hasSession(...args)
export const hasActiveSession: BillingSessionSeam['hasActiveSession'] = (...args) =>
  session().hasActiveSession(...args)
export const accumulateUsage: BillingSessionSeam['accumulateUsage'] = (...args) =>
  session().accumulateUsage(...args)
export const accumulateImageUsage: BillingSessionSeam['accumulateImageUsage'] = (...args) =>
  session().accumulateImageUsage(...args)
// Partial `mock.module()` stubs of the cloud module may predate video billing.
export const accumulateVideoUsage: BillingSessionSeam['accumulateVideoUsage'] = (...args) =>
  (session().accumulateVideoUsage ?? localBillingSession.accumulateVideoUsage)(...args)
// Same for 3D: a stub written before SHO-13 need not carry it.
export const accumulate3dUsage: BillingSessionSeam['accumulate3dUsage'] = (...args) =>
  (session().accumulate3dUsage ?? localBillingSession.accumulate3dUsage)(...args)
export const setQualitySignals: BillingSessionSeam['setQualitySignals'] = (...args) =>
  session().setQualitySignals(...args)

/**
 * Records a turn that had no anchor project (so no billing session) from its
 * stream-reported usage. A no-op in cloud, where the AI proxy already records
 * each call of an unanchored turn, and on desktop unless cloud forwarding is
 * on, where the local AI proxy does the same.
 */
export async function recordTurnUsage(turn: Omit<LocalTurnUsage, 'projectId'>): Promise<typeof EMPTY_RESULT> {
  if (cloud || !isShogoCloudForwarding()) return EMPTY_RESULT
  return recordLocalTurnUsage({ ...turn, projectId: null })
}
