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
 */
import type * as CloudBillingSessionModule from './proxy-billing-session'
import type { BillingSessionQualitySignals } from './proxy-billing-session'
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
}
const localTurns = new Map<string, LocalTurn>()
const turnKey = (projectId: string, chatSessionId?: string | null) => `${projectId}:${chatSessionId ?? ''}`

export const localBillingSession: BillingSessionSeam = {
  openSession: async (projectId, workspaceId, userId, chatSessionId) => {
    localTurns.set(turnKey(projectId, chatSessionId), { workspaceId, userId, openedAt: Date.now(), quality: {} })
  },
  closeSession: async (projectId, options = {}) => {
    const key = turnKey(projectId, options.chatSessionId)
    const turn = localTurns.get(key)
    localTurns.delete(key)
    if (!turn || !options.fallbackUsage || options.discardPartial || options.bookkeeping) return EMPTY_RESULT
    if (!isShogoCloudForwarding()) return EMPTY_RESULT
    return recordLocalTurnUsage({ ...turn, projectId, chatSessionId: options.chatSessionId, usage: options.fallbackUsage })
  },
  hasSession: async () => false,
  hasActiveSession: async () => false,
  accumulateUsage: async () => false,
  accumulateImageUsage: async () => false,
  setQualitySignals: async (projectId, quality, chatSessionId) => {
    const turn = localTurns.get(turnKey(projectId, chatSessionId))
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
