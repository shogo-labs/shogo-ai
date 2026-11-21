// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Keep the session cookie from a native Google/Apple sign-in on Android.
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
 * This listens for that deep link for the duration of the sign-in and stores
 * the cookie the same way the plugin would, so the provider's session read
 * that follows finds it.
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
 * Wrap `signIn.social` so every native social sign-in on Android listens for
 * the hand-back deep link while the sheet is open. The rest of the client is
 * passed through untouched.
 */
export function withOAuthRedirectCapture<T extends object>(
  client: T,
  makeWatcher: () => OAuthRedirectWatcher,
): T {
  const signIn = (client as any).signIn
  if (!signIn || typeof signIn.social !== "function") return client
  const social = async (...args: unknown[]) => {
    const watcher = makeWatcher()
    try {
      const result = await signIn.social(...args)
      if (!result?.error && !result?.data?.user) {
        await watcher.waitForCookie(OAUTH_REDIRECT_GRACE_MS)
      }
      return result
    } finally {
      watcher.stop()
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
