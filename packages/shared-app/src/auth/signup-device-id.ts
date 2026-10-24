// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * First-party device id sent with sign-up so the server's signup risk scorer
 * can count accounts created from the same browser (see
 * `apps/api/src/services/signup-risk.service.ts`, header `x-shogo-device-id`).
 *
 * Random UUID persisted in localStorage. Returns `undefined` where storage is
 * unavailable (native), in which case no header is sent and the device signal
 * is simply absent.
 */

const STORAGE_KEY = 'shogo.deviceId'

export const SIGNUP_DEVICE_HEADER = 'x-shogo-device-id'

function makeId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (c?.randomUUID) return c.randomUUID()
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
}

export function getSignupDeviceId(): string | undefined {
  try {
    const storage = (globalThis as { localStorage?: Storage }).localStorage
    if (!storage) return undefined
    let id = storage.getItem(STORAGE_KEY)
    if (!id) {
      id = makeId()
      storage.setItem(STORAGE_KEY, id)
    }
    return id
  } catch {
    return undefined
  }
}

/** Fetch options carrying the device header, or `undefined` when there is none. */
export function signupFetchOptions(): { headers: Record<string, string> } | undefined {
  const id = getSignupDeviceId()
  return id ? { headers: { [SIGNUP_DEVICE_HEADER]: id } } : undefined
}
