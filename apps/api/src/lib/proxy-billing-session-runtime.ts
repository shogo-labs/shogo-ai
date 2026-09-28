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
 */
import type * as CloudBillingSessionModule from './proxy-billing-session'

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

export const localBillingSession: BillingSessionSeam = {
  openSession: async () => {},
  closeSession: async () => ({ billedUsd: 0, rawUsd: 0, totalTokens: 0 }),
  hasSession: async () => false,
  hasActiveSession: async () => false,
  accumulateUsage: async () => false,
  accumulateImageUsage: async () => false,
  setQualitySignals: async () => false,
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
