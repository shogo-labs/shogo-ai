// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Cloud Key Self-Heal — wipes the local SHOGO_API_KEY when cloud rejects it,
 * so the desktop UI flips to signed-out instead of looping 401s.
 */

import { prisma } from './prisma'
import { checkCloudKey } from './cloud-key-state'

const DEDUP_WINDOW_MS = 5_000

let lastWipeAt = 0
let inFlight: Promise<void> | null = null

export interface WipeResult {
  /** True when this call performed the wipe; false if no-op or coalesced. */
  wiped: boolean
}

/** Wipe the locally-stored Shogo Cloud API key. Idempotent + debounced. */
export async function wipeCloudKey(reason: string): Promise<WipeResult> {
  if (!process.env.SHOGO_API_KEY) return { wiped: false }
  // Coalesce concurrent callers and dedup follow-ups within the window.
  if (inFlight) { await inFlight; return { wiped: false } }
  if (Date.now() - lastWipeAt < DEDUP_WINDOW_MS) return { wiped: false }

  console.warn(
    `[CloudKeyWipe] Clearing SHOGO_API_KEY — ${reason}. ` +
      `Desktop heartbeat will surface the signed-out state on its next tick.`,
  )

  const localDb = prisma as any
  inFlight = (async () => {
    try {
      await Promise.all([
        localDb.localConfig
          .deleteMany({ where: { key: 'SHOGO_API_KEY' } })
          .catch((err: unknown) => {
            console.error('[CloudKeyWipe] localConfig SHOGO_API_KEY delete failed:', err)
          }),
        localDb.localConfig
          .deleteMany({ where: { key: 'SHOGO_KEY_INFO' } })
          .catch((err: unknown) => {
            console.error('[CloudKeyWipe] localConfig SHOGO_KEY_INFO delete failed:', err)
          }),
      ])
      delete process.env.SHOGO_API_KEY

      // Dynamic import avoids a static instance-tunnel ↔ cloud-key-wipe cycle.
      try {
        const mod = await import('./instance-tunnel')
        mod.stopInstanceTunnel()
      } catch (err) {
        console.error('[CloudKeyWipe] Failed to stop instance tunnel:', err)
      }
    } finally {
      lastWipeAt = Date.now()
      inFlight = null
    }
  })()

  await inFlight
  return { wiped: true }
}

/**
 * Wipe only after Shogo Cloud confirms the key itself is dead.
 *
 * A 401 relayed from a proxied request is ambiguous: older clouds pass
 * upstream provider 401s straight through, which look identical to a revoked
 * Shogo key. Wipe only when `/api/api-keys/validate` says `valid: false`;
 * keep the key when it says valid or can't be reached.
 */
export async function wipeCloudKeyIfRejected(reason: string): Promise<WipeResult> {
  const key = process.env.SHOGO_API_KEY
  if (!key) return { wiped: false }
  if (inFlight) { await inFlight; return { wiped: false } }
  if (Date.now() - lastWipeAt < DEDUP_WINDOW_MS) return { wiped: false }

  const status = await checkCloudKey(key)
  if (status === 'valid') {
    console.warn(`[CloudKeyWipe] Ignoring ${reason} — Shogo Cloud reports the key as valid.`)
    return { wiped: false }
  }
  if (status === 'unknown') {
    console.warn(`[CloudKeyWipe] Could not verify key after ${reason}; keeping it.`)
    return { wiped: false }
  }
  // The user may have re-signed-in with a different key while we were verifying.
  if (process.env.SHOGO_API_KEY !== key) return { wiped: false }
  return wipeCloudKey(`${reason} (confirmed by /api/api-keys/validate)`)
}

/** Test-only reset of the dedup state. */
export const _testing = {
  reset() {
    lastWipeAt = 0
    inFlight = null
  },
}
