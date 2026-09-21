// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Local-safe billing-session seam for project/workspace chat.
 *
 * Chat still calls the same lifecycle hooks, but desktop has no Redis-backed
 * cloud billing ledger. Cloud mode dynamically loads the full implementation.
 */
let cloud: any = null
if (process.env.SHOGO_LOCAL_MODE !== 'true') {
  cloud = await import(new URL('./proxy-billing-session.ts', import.meta.url).href)
}

export const openSession = (...args: any[]) =>
  cloud?.openSession?.(...args) ?? Promise.resolve()
export const closeSession = (...args: any[]) =>
  cloud?.closeSession?.(...args) ?? Promise.resolve({ billedUsd: 0 })
export const hasSession = (...args: any[]) =>
  cloud?.hasSession?.(...args) ?? Promise.resolve(false)
export const hasActiveSession = (...args: any[]) =>
  cloud?.hasActiveSession?.(...args) ?? Promise.resolve(false)
export const accumulateUsage = (...args: any[]) =>
  cloud?.accumulateUsage?.(...args) ?? Promise.resolve(false)
export const accumulateImageUsage = (...args: any[]) =>
  cloud?.accumulateImageUsage?.(...args) ?? Promise.resolve(false)
export const setQualitySignals = (...args: any[]) =>
  cloud?.setQualitySignals?.(...args) ?? Promise.resolve()
