/**
 * Native auth cookie storage backed by AsyncStorage.
 *
 * Replaces @better-auth/expo's cookie handling. Stores cookies as a JSON
 * map of { [name]: { value, expires } } and provides helpers to:
 *   - parse `set-cookie` headers from Better Auth responses
 *   - serialize stored cookies into a `Cookie` header string
 *
 * Uses an in-memory cache with async persistence so that synchronous reads
 * (needed by the HttpClient's getAuthCookie) are instant.
 *
 * Call `initAuthStorage()` at app startup before creating the auth client.
 */

import AsyncStorage from '@react-native-async-storage/async-storage'

const COOKIE_STORAGE_KEY = '__betterauth_cookies'

interface StoredCookie {
  value: string
  expires: string | null
}

type CookieJar = Record<string, StoredCookie>

let cookieJar: CookieJar = {}
let hydrated = false

export async function initAuthStorage(): Promise<void> {
  if (hydrated) return
  try {
    const raw = await AsyncStorage.getItem(COOKIE_STORAGE_KEY)
    if (raw) {
      cookieJar = JSON.parse(raw)
    }
  } catch (e) {
    console.warn('[auth-storage] Failed to hydrate cookies:', e)
  }
  hydrated = true
}

function persistCookieJar() {
  AsyncStorage.setItem(COOKIE_STORAGE_KEY, JSON.stringify(cookieJar)).catch((e) =>
    console.warn('[auth-storage] Failed to persist cookies:', e),
  )
}

/**
 * Parse a raw `set-cookie` header (may contain multiple cookies separated
 * by commas that don't fall inside an `Expires` date) and merge into the jar.
 */
export function saveSetCookieHeader(header: string): void {
  if (!header) return
  console.log('[auth-storage] Saving set-cookie header, length:', header.length)

  const parts = header.split(/,(?=\s*[A-Za-z0-9_.\-]+=)/g)

  for (const part of parts) {
    const trimmed = part.trim()
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx === -1) continue

    const name = trimmed.slice(0, eqIdx).trim()
    // Strip __Secure- prefix for storage key consistency
    const storageKey = name.replace(/^__Secure-/, '')

    const afterName = trimmed.slice(eqIdx + 1)
    const semiIdx = afterName.indexOf(';')
    const value = (semiIdx === -1 ? afterName : afterName.slice(0, semiIdx)).trim()

    let expires: string | null = null
    const maxAgeMatch = trimmed.match(/;\s*Max-Age=(\d+)/i)
    const expiresMatch = trimmed.match(/;\s*Expires=([^;]+)/i)

    if (maxAgeMatch) {
      expires = new Date(Date.now() + Number(maxAgeMatch[1]) * 1000).toISOString()
    } else if (expiresMatch) {
      const d = new Date(expiresMatch[1].trim())
      if (!isNaN(d.getTime())) expires = d.toISOString()
    }

    // Max-Age=0 or past Expires → delete cookie
    if (maxAgeMatch && Number(maxAgeMatch[1]) === 0) {
      delete cookieJar[storageKey]
      continue
    }
    if (expires && new Date(expires) < new Date()) {
      delete cookieJar[storageKey]
      continue
    }

    cookieJar[storageKey] = { value, expires }
  }

  persistCookieJar()
}

/**
 * Build a `Cookie` header string from stored non-expired cookies.
 */
export function getAuthCookieHeader(): string | null {
  const now = new Date()
  const parts: string[] = []

  for (const [name, cookie] of Object.entries(cookieJar)) {
    if (cookie.expires && new Date(cookie.expires) < now) continue
    parts.push(`${name}=${cookie.value}`)
  }

  const result = parts.length > 0 ? parts.join('; ') : null
  console.log('[auth-storage] getAuthCookieHeader:', result ? `${parts.length} cookie(s): ${parts.map(p => p.split('=')[0]).join(', ')}` : 'null')
  if (Object.keys(cookieJar).length > 0) {
    console.log('[auth-storage] Cookie jar keys:', Object.keys(cookieJar).join(', '))
    for (const [name, cookie] of Object.entries(cookieJar)) {
      const valPreview = cookie.value?.substring(0, 20) + '...'
      console.log(`[auth-storage]   ${name} = ${valPreview} (expires: ${cookie.expires ?? 'none'})`)
    }
  }
  return result
}

/**
 * Clear all stored auth cookies (used on sign-out).
 */
export function clearAuthCookies(): void {
  cookieJar = {}
  persistCookieJar()
}
