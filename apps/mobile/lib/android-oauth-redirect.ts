// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Keep the session cookie from a native Google/Apple sign-in, and tell a
 * hand-back apart from a dismissed sheet.
 *
 * `@better-auth/expo` opens the OAuth sheet with `openAuthSessionAsync` and only
 * stores the session cookie when the result is `{ type: "success" }`. On
 * Android that call is a polyfill: it races "the app became active again"
 * (resolves `dismiss`) against "a `shogo://…?cookie=…` deep link arrived"
 * (resolves `success`). The redirect itself brings the app back to the
 * foreground, so the AppState event often wins and the cookie in the deep link
 * is thrown away — Google sign-in "completes without a session" (Sentry
 * SHOGO-ANDROID-1W / 1S, still present after SHO-430).
 *
 * This listens for that deep link on Android for the duration of the sign-in
 * and stores the cookie the same way the plugin would, so the provider's
 * session read that follows finds it.
 *
 * On every native platform it also reports whether a hand-back reached the app
 * at all (`nativeHandback` on the result): the session token in the plugin's
 * cookie jar is read before and after the call, and a jar that never changed
 * means the sheet was dismissed. That is the difference between a person (or
 * Play's pre-launch robot) backing out and a round trip that really broke, which
 * SHO-430 could only guess at from how long the sheet stayed open (SHO-527).
 */

export interface CookieStorage {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => unknown
}

export interface UrlEventSource {
  addEventListener: (type: "url", handler: (event: { url: string }) => void) => { remove: () => void }
}

/** The `cookie` query parameter of an OAuth hand-back deep link, if it is one. */
export function oauthRedirectCookie(url: string, scheme: string): string | null {
  if (!url.startsWith(`${scheme}:`)) return null
  const query = url.indexOf("?")
  if (query < 0) return null
  try {
    const cookie = new URLSearchParams(url.slice(query + 1).split("#")[0]).get("cookie")
    return cookie && cookie.trim() ? cookie : null
  } catch {
    return null
  }
}

/**
 * The names Better Auth writes the session token under inside the plugin's
 * cookie jar. `__Secure-` is what a production (https) API sets; the bare name
 * is the local/development one.
 */
export function sessionCookieNames(cookiePrefix: string): string[] {
  return [`__Secure-${cookiePrefix}.session_token`, `${cookiePrefix}.session_token`]
}

/**
 * The session token held by a plugin cookie jar — the `{ name: { value,
 * expires } }` JSON `@better-auth/expo` keeps in SecureStore.
 */
export function sessionTokenFromJar(
  jar: string | null | undefined,
  cookiePrefix: string,
): string | null {
  if (!jar) return null
  let parsed: Record<string, { value?: unknown } | undefined>
  try {
    parsed = JSON.parse(jar)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object") return null
  for (const name of sessionCookieNames(cookiePrefix)) {
    const value = parsed[name]?.value
    if (typeof value === "string" && value) return value
  }
  return null
}

/** The session token the client holds right now, read the way the plugin writes it. */
export function readStoredSessionToken(options: {
  storage: CookieStorage
  storagePrefix: string
  cookiePrefix: string
  /** The plugin's own `normalizeCookieName`, so the jar key matches. */
  normalizeCookieName: (name: string) => string
}): string | null {
  const key = options.normalizeCookieName(`${options.storagePrefix}_cookie`)
  return sessionTokenFromJar(options.storage.getItem(key), options.cookiePrefix)
}

export interface OAuthRedirectWatcher {
  /** Resolves true once a cookie was stored, or false after `timeoutMs`. */
  waitForCookie: (timeoutMs: number) => Promise<boolean>
  stop: () => void
}

export function watchOAuthRedirectCookie(options: {
  linking: UrlEventSource
  storage: CookieStorage
  storagePrefix: string
  scheme: string
  /** The plugin's own `getSetCookie` / `normalizeCookieName`, so the jar format matches. */
  getSetCookie: (header: string, prevCookie?: string) => string
  normalizeCookieName: (name: string) => string
}): OAuthRedirectWatcher {
  const cookieKey = options.normalizeCookieName(`${options.storagePrefix}_cookie`)
  let stored = false
  const waiters = new Set<(value: boolean) => void>()
  const subscription = options.linking.addEventListener("url", (event) => {
    const cookie = oauthRedirectCookie(String(event?.url ?? ""), options.scheme)
    if (!cookie) return
    try {
      const merged = options.getSetCookie(cookie, options.storage.getItem(cookieKey) ?? undefined)
      options.storage.setItem(cookieKey, merged)
      stored = true
    } catch (err) {
      console.warn("[auth] could not store the OAuth redirect cookie:", err)
      return
    }
    for (const resolve of waiters) resolve(true)
    waiters.clear()
  })
  return {
    waitForCookie: (timeoutMs) => {
      if (stored) return Promise.resolve(true)
      return new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          waiters.delete(done)
          resolve(stored)
        }, timeoutMs)
        const done = (value: boolean) => {
          clearTimeout(timer)
          resolve(value)
        }
        waiters.add(done)
      })
    },
    stop: () => {
      subscription.remove()
      for (const resolve of waiters) resolve(stored)
      waiters.clear()
    },
  }
}

/**
 * How long to keep listening after the sheet resolved without a stored cookie:
 * the deep link is delivered a beat after the AppState change that ended the
 * race. A person who backed out waits this long for the "closed" message.
 */
export const OAUTH_REDIRECT_GRACE_MS = 1500

/**
 * Whether a hand-back from the OAuth sheet actually reached the app, stamped on
 * the `signIn.social` result as `data.nativeHandback`:
 *
 * - `received` — a session token the call did not have is in the jar now.
 * - `none` — the jar is unchanged, so the sheet was dismissed (however long it
 *   was open) and there was never a round trip to find a session for.
 */
export type NativeHandback = "none" | "received"

export interface OAuthHandbackOptions {
  /**
   * Android only: listens for the `shogo://…?cookie=…` hand-back deep link while
   * the sheet is open, so a deep link the plugin's race dropped is still stored.
   * iOS needs none — there the plugin writes the cookie itself.
   */
  watch?: () => OAuthRedirectWatcher
  /** Reads the session token the client holds now; without it no verdict is stamped. */
  readSessionToken?: () => string | null
  /** The sheet closed without a hand-back. Meant for a breadcrumb, not an event. */
  onSheetClosed?: (info: { platform: string; sheetMs: number }) => void
  /** For the breadcrumb; defaults to `native`. */
  platform?: string
}

/** Stamps the verdict onto the call's result without replacing anything the client rolled. */
function stampHandback(result: unknown, handback: NativeHandback): void {
  if (!result || typeof result !== "object") return
  const target = result as { data?: Record<string, unknown> | null }
  if (!target.data || typeof target.data !== "object") target.data = {}
  target.data.nativeHandback = handback
}

/**
 * Wrap `signIn.social` on every native platform so the sign-in knows whether
 * the sheet handed back to the app. The rest of the client is passed through
 * untouched.
 */
export function withOAuthRedirectCapture<T extends object>(
  client: T,
  options: OAuthHandbackOptions = {},
): T {
  const signIn = (client as any).signIn
  if (!signIn || typeof signIn.social !== "function") return client
  const social = async (...args: unknown[]) => {
    const startedAt = Date.now()
    const tokenBefore = options.readSessionToken?.() ?? null
    const watcher = options.watch?.()
    try {
      const result = await signIn.social(...args)
      // The sheet is closed by the time the call resolves; the grace wait below
      // is ours, so it must not count as sheet time in the breadcrumb.
      const sheetMs = Date.now() - startedAt
      if (!result?.error && !result?.data?.user) {
        if (watcher) await watcher.waitForCookie(OAUTH_REDIRECT_GRACE_MS)
        if (options.readSessionToken) {
          const tokenAfter = options.readSessionToken()
          const handback: NativeHandback =
            tokenAfter && tokenAfter !== tokenBefore ? "received" : "none"
          stampHandback(result, handback)
          if (handback === "none") {
            options.onSheetClosed?.({ platform: options.platform ?? "native", sheetMs })
          }
        }
      }
      return result
    } finally {
      watcher?.stop()
    }
  }
  const wrappedSignIn = new Proxy(signIn, {
    get(target, prop) {
      if (prop === "social") return social
      return Reflect.get(target, prop)
    },
  })
  return new Proxy(client, {
    get(target, prop) {
      if (prop === "signIn") return wrappedSignIn
      return Reflect.get(target, prop)
    },
  })
}
