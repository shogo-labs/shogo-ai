// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The session this device already knows about (SHO-580).
 *
 * `@better-auth/expo` keeps the session *cookie* in SecureStore but never the
 * user, so every launch had to ask `GET /api/auth/get-session` who was signed in
 * before it could draw anything — seconds of full-screen spinner on 3G for a
 * session that was already on the device (`AuthProvider`'s `isLoading` gate).
 *
 * This is the missing half: the user object the provider last rendered, and the
 * one onboarding answer `/api/me` gives, kept per environment. `AuthProvider`
 * reads it on its first frame (`cachedUser`) and writes it back (`onUserChanged`),
 * and only a definite sign-out clears it.
 *
 * It is a plain AsyncStorage mirror, plus an in-memory copy so a remount inside
 * the same JS session paints on the first frame instead of waiting for a read.
 * Everything is keyed by the active environment: a dev-override build talks to a
 * different API with different accounts, so it must never read prod's copy.
 */
import type { AuthUser } from '@shogo/shared-app/auth'
import { authStoragePrefixFor, getActiveEnvKey } from './env-override'
import { getStorageItem, removeStorageItem, setStorageJson } from './storage'

/** How much of a cached user is kept. Enough to render the shell, nothing secret. */
export interface CachedAuthUser {
  id: string
  name: string
  email: string
  image?: string | null
  createdAt?: string | Date
}

interface StoredSession {
  user: CachedAuthUser
  /** `/api/me`'s `onboardingCompleted` for this user, if it has been seen. */
  onboardingCompleted?: boolean
  savedAt: number
}

const userKey = () => `${authStoragePrefixFor(getActiveEnvKey())}:auth-session:v1:user`

let mirror: StoredSession | null = null
let hydrated = false
let hydrating: Promise<void> | null = null

function toCachedUser(user: AuthUser): CachedAuthUser {
  const cached: CachedAuthUser = { id: user.id, name: user.name, email: user.email }
  if (user.image) cached.image = user.image
  if (typeof user.createdAt === 'string' || user.createdAt instanceof Date) cached.createdAt = user.createdAt
  return cached
}

/**
 * Load the device's copy into memory. Started at module load and awaited by the
 * root layout's first-render gate, so `readCachedAuthUser()` is populated by the
 * time the auth provider mounts.
 */
export function hydrateAuthSessionCache(): Promise<void> {
  if (hydrated) return Promise.resolve()
  if (hydrating) return hydrating
  hydrating = (async () => {
    try {
      const raw = await getStorageItem(userKey())
      const parsed = raw ? (JSON.parse(raw) as StoredSession) : null
      mirror = parsed && parsed.user?.id ? parsed : null
    } catch {
      mirror = null
    } finally {
      hydrated = true
      hydrating = null
    }
  })()
  return hydrating
}

/** The cached user for the synchronous first frame, or null. */
export function readCachedAuthUser(): AuthUser | null {
  return mirror?.user ?? null
}

/** The cached onboarding answer for a user, or null when it has not been seen. */
export function readCachedOnboardingCompleted(userId: string): boolean | null {
  if (!mirror || mirror.user.id !== userId) return null
  return typeof mirror.onboardingCompleted === 'boolean' ? mirror.onboardingCompleted : null
}

/** Keep the device copy in step with the provider. */
export function rememberAuthUser(user: AuthUser | null): void {
  if (!user) {
    // A sign-out is explicit (`clearAuthSessionCache`); a transient `null` —
    // the provider's first frame before a cache exists — must not erase it.
    return
  }
  const next: StoredSession = {
    user: toCachedUser(user),
    ...(mirror?.user.id === user.id && typeof mirror.onboardingCompleted === 'boolean'
      ? { onboardingCompleted: mirror.onboardingCompleted }
      : {}),
    savedAt: Date.now(),
  }
  mirror = next
  hydrated = true
  setStorageJson(userKey(), next).catch(() => {})
}

export function rememberOnboardingCompleted(userId: string, completed: boolean): void {
  if (!mirror || mirror.user.id !== userId) return
  if (mirror.onboardingCompleted === completed) return
  mirror = { ...mirror, onboardingCompleted: completed, savedAt: Date.now() }
  setStorageJson(userKey(), mirror).catch(() => {})
}

export async function clearAuthSessionCache(): Promise<void> {
  mirror = null
  hydrated = true
  await removeStorageItem(userKey()).catch(() => {})
}

/** Test seam: forget the in-memory copy without touching storage. */
export function resetAuthSessionCacheForTests(): void {
  mirror = null
  hydrated = false
  hydrating = null
}
