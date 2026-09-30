// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Local-mode view of the Shogo Cloud key's health: whether the cloud has
 * rejected it, and the last heartbeat result. Read by
 * `/api/local/cloud-login/status` to drive the "sign in again" banner.
 *
 * A 401 on a proxied request is ambiguous (older clouds relay upstream
 * provider 401s verbatim), so callers that only saw a 401 should use
 * `markCloudKeyRejectedIfConfirmed`, which asks `/api/api-keys/validate`
 * first. The heartbeat checks the key itself, so its 401 is authoritative.
 */
import { getShogoCloudUrl } from './cloud-urls'

export type CloudKeyStatus = 'valid' | 'rejected' | 'unknown'

const VERIFY_TIMEOUT_MS = 5_000

let pendingCheck: { key: string; promise: Promise<CloudKeyStatus> } | null = null

let cloudKeyRejected = false
let lastHeartbeatOk: boolean | null = null
let lastHeartbeatAt: number | null = null
let lastHeartbeatError: string | null = null
let credentialMismatchLogged = false

/**
 * Ask Shogo Cloud whether `key` is still valid. Network errors, timeouts,
 * and responses without a boolean `valid` come back as `'unknown'`.
 * Concurrent checks for the same key share one request.
 */
export function checkCloudKey(key: string): Promise<CloudKeyStatus> {
  if (pendingCheck?.key === key) return pendingCheck.promise
  const promise = fetchCloudKeyStatus(key).finally(() => {
    if (pendingCheck?.promise === promise) pendingCheck = null
  })
  pendingCheck = { key, promise }
  return promise
}

async function fetchCloudKeyStatus(key: string): Promise<CloudKeyStatus> {
  try {
    const resp = await fetch(`${getShogoCloudUrl()}/api/api-keys/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key }),
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    })
    const data = (await resp.json().catch(() => null)) as { valid?: unknown } | null
    if (data?.valid === true) return 'valid'
    if (data?.valid === false) return 'rejected'
    return 'unknown'
  } catch {
    return 'unknown'
  }
}

export function isCloudKeyRejected(): boolean {
  return cloudKeyRejected
}

export function markCloudKeyRejected(reason?: string): void {
  if (!cloudKeyRejected) {
    console.warn(
      `[CloudLogin] Cloud rejected API key${reason ? ` (${reason})` : ''} — key may be revoked or expired. User must re-sign-in.`,
    )
  }
  cloudKeyRejected = true
}

/**
 * Flag `key` as rejected only once `/api/api-keys/validate` confirms it, and
 * only if it is still the active key. Returns whether the flag was set.
 */
export async function markCloudKeyRejectedIfConfirmed(
  reason: string,
  key: string | null | undefined = process.env.SHOGO_API_KEY,
): Promise<boolean> {
  if (!key) return false
  const status = await checkCloudKey(key)
  if (status !== 'rejected') return false
  const activeKey = process.env.SHOGO_API_KEY
  if (activeKey && activeKey !== key) return false
  markCloudKeyRejected(reason)
  return true
}

export function recordHeartbeat(ok: boolean, error: string | null = null): void {
  if (ok) cloudKeyRejected = false
  lastHeartbeatOk = ok
  lastHeartbeatAt = Date.now()
  lastHeartbeatError = ok ? null : error
}

export function getHeartbeatStatus(): {
  lastHeartbeatOk: boolean | null
  lastHeartbeatAt: number | null
  lastHeartbeatError: string | null
} {
  return { lastHeartbeatOk, lastHeartbeatAt, lastHeartbeatError }
}

/** True the first time it's called after a reset; used to log a mismatch once. */
export function claimCredentialMismatchLog(): boolean {
  if (credentialMismatchLogged) return false
  credentialMismatchLogged = true
  return true
}

/**
 * Forget the previous key's rejected/heartbeat state. Call when a key is
 * saved or removed, so a stale flag doesn't keep asking the user to sign in
 * again with a freshly issued key.
 */
export function resetCloudKeyState(): void {
  cloudKeyRejected = false
  lastHeartbeatOk = null
  lastHeartbeatAt = null
  lastHeartbeatError = null
  credentialMismatchLogged = false
  pendingCheck = null
}
