// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The native OAuth hand-back.
 *
 * SHO-483: the expo plugin drops the cookie whenever `openAuthSessionAsync`
 * resolves `dismiss`, which on Android happens when the app's own AppState
 * change wins the race against the `shogo://…?cookie=…` deep link. The watcher
 * must keep that cookie so the session read that follows finds it.
 *
 * SHO-527: a sheet that was merely dismissed must be told apart from one that
 * handed back a session that then went missing. `withOAuthRedirectCapture`
 * stamps `data.nativeHandback` from the plugin's cookie jar on every native
 * platform, so the provider no longer has to guess from how long the sheet was
 * open.
 *
 * Run: cd apps/mobile && bun test lib/__tests__/android-oauth-redirect.test.ts
 */

import { describe, expect, test } from "bun:test"
import {
  OAUTH_REDIRECT_GRACE_MS,
  oauthRedirectCookie,
  readStoredSessionToken,
  sessionTokenFromJar,
  watchOAuthRedirectCookie,
  withOAuthRedirectCapture,
  type UrlEventSource,
} from "../android-oauth-redirect"

function fakeLinking() {
  let handler: ((event: { url: string }) => void) | null = null
  const linking: UrlEventSource = {
    addEventListener: (_type, h) => {
      handler = h
      return { remove: () => { handler = null } }
    },
  }
  return {
    linking,
    emit: (url: string) => handler?.({ url }),
    get listening() {
      return handler !== null
    },
  }
}

function fakeStorage(initial?: Record<string, string>) {
  const map = new Map<string, string>(Object.entries(initial ?? {}))
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value)
    },
  }
}

const jar = {
  normalizeCookieName: (name: string) => name.replace(/:/g, "_"),
  getSetCookie: (header: string, prev?: string) => {
    const [pair] = header.split(";")
    const [name, value] = pair.split("=")
    const next: Record<string, unknown> = prev ? JSON.parse(prev) : {}
    next[name.trim()] = { value, expires: null }
    return JSON.stringify(next)
  },
}

const COOKIE = "shogo.session_token=abc.def; Path=/; HttpOnly"
const REDIRECT = `shogo:///?cookie=${encodeURIComponent(COOKIE)}`

/** The provider redirect a native `signIn.social` resolves with — never a user. */
const SHEET_RESULT = { data: { url: "https://accounts.google.com/…", redirect: true }, error: null }

/** `signIn.social` as the wrapper calls it: takes options, resolves the plugin's result. */
const social = (impl: () => unknown) => async (_options?: unknown) => impl()

function readSessionToken(storage: ReturnType<typeof fakeStorage>) {
  return () =>
    readStoredSessionToken({
      storage,
      storagePrefix: "shogo",
      cookiePrefix: "shogo",
      normalizeCookieName: jar.normalizeCookieName,
    })
}

describe("oauthRedirectCookie", () => {
  test("reads the cookie from the app's hand-back deep link", () => {
    expect(oauthRedirectCookie(REDIRECT, "shogo")).toBe(COOKIE)
  })

  test("ignores other links and links without a cookie", () => {
    expect(oauthRedirectCookie(`https://studio.shogo.ai/?cookie=x`, "shogo")).toBeNull()
    expect(oauthRedirectCookie("shogo:///projects/1", "shogo")).toBeNull()
    expect(oauthRedirectCookie("shogo:///?cookie=", "shogo")).toBeNull()
  })
})

describe("sessionTokenFromJar", () => {
  test("reads the production (`__Secure-`) and the local token name", () => {
    const secure = JSON.stringify({
      "__Secure-shogo.session_token": { value: "secure-token", expires: null },
    })
    expect(sessionTokenFromJar(secure, "shogo")).toBe("secure-token")
    expect(sessionTokenFromJar(JSON.stringify({ "shogo.session_token": { value: "t" } }), "shogo")).toBe("t")
  })

  test("is null for an empty, malformed or unrelated jar", () => {
    expect(sessionTokenFromJar(null, "shogo")).toBeNull()
    expect(sessionTokenFromJar("not json", "shogo")).toBeNull()
    expect(
      sessionTokenFromJar(JSON.stringify({ "shogo.oauth_state": { value: "s" } }), "shogo"),
    ).toBeNull()
  })
})

describe("withOAuthRedirectCapture", () => {
  test("keeps the session cookie when the sheet resolves dismiss before the deep link", async () => {
    const { linking, emit } = fakeLinking()
    const storage = fakeStorage()
    const client = {
      getSession: () => "untouched",
      signIn: {
        email: () => "email",
        // The plugin's view of an Android race lost to AppState: the sheet is
        // gone, nothing was stored, and the call resolves with only the URL.
        social: social(() => {
          setTimeout(() => emit(REDIRECT), 50)
          return SHEET_RESULT
        }),
      },
    }

    const wrapped = withOAuthRedirectCapture(client, {
      watch: () => watchOAuthRedirectCookie({ linking, storage, storagePrefix: "shogo", scheme: "shogo", ...jar }),
      readSessionToken: readSessionToken(storage),
    })
    const result: any = await wrapped.signIn.social({ provider: "google" })

    const stored = JSON.parse(storage.getItem("shogo_cookie") ?? "{}")
    expect(stored["shogo.session_token"]?.value).toBe("abc.def")
    // The deep link that arrived after the grace would be a hand-back; here it
    // landed inside it, so the provider is told the session is on its way.
    expect(result.data.nativeHandback).toBe("received")
    // Everything else on the client passes straight through.
    expect(wrapped.getSession()).toBe("untouched")
    expect(wrapped.signIn.email()).toBe("email")
  })

  test("stops listening once the sign-in settles", async () => {
    const fake = fakeLinking()
    const storage = fakeStorage()
    const client = {
      signIn: { social: social(() => ({ data: { user: { id: "u1" } } })) },
    }
    const wrapped = withOAuthRedirectCapture(client, {
      watch: () => watchOAuthRedirectCookie({ linking: fake.linking, storage, storagePrefix: "shogo", scheme: "shogo", ...jar }),
      readSessionToken: readSessionToken(storage),
    })
    await wrapped.signIn.social({ provider: "google" })
    expect(fake.listening).toBe(false)
  })

  test("merges into an existing cookie jar instead of replacing it", () => {
    const { linking, emit } = fakeLinking()
    const storage = fakeStorage()
    storage.setItem("shogo_cookie", JSON.stringify({ "shogo.state": { value: "s", expires: null } }))
    const watcher = watchOAuthRedirectCookie({ linking, storage, storagePrefix: "shogo", scheme: "shogo", ...jar })
    emit(REDIRECT)
    watcher.stop()
    const stored = JSON.parse(storage.getItem("shogo_cookie") ?? "{}")
    expect(Object.keys(stored).sort()).toEqual(["shogo.session_token", "shogo.state"])
  })

  test("an unchanged jar is a dismissal: nativeHandback 'none', however long the sheet was open", async () => {
    const { linking } = fakeLinking()
    const storage = fakeStorage()
    const closed: Array<{ platform: string; sheetMs: number }> = []
    const client = {
      // The sheet was open for a while and then closed with nothing stored.
      signIn: { social: social(() => SHEET_RESULT) },
    }

    const wrapped = withOAuthRedirectCapture(client, {
      watch: () => watchOAuthRedirectCookie({ linking, storage, storagePrefix: "shogo", scheme: "shogo", ...jar }),
      readSessionToken: readSessionToken(storage),
      onSheetClosed: (info) => closed.push(info),
      platform: "android",
    })
    const result: any = await wrapped.signIn.social({ provider: "google" })

    expect(result.data.nativeHandback).toBe("none")
    expect(closed).toHaveLength(1)
    expect(closed[0].platform).toBe("android")
    // Sheet time, not our own 1.5 s grace wait: the breadcrumb must say how long
    // the person had the sheet up.
    expect(closed[0].sheetMs).toBeLessThan(OAUTH_REDIRECT_GRACE_MS)
  })

  test("a stale token that is still the same afterwards is a dismissal too", async () => {
    const { linking } = fakeLinking()
    const storage = fakeStorage({
      shogo_cookie: JSON.stringify({ "shogo.session_token": { value: "stale", expires: null } }),
    })
    const client = { signIn: { social: social(() => SHEET_RESULT) } }

    const wrapped = withOAuthRedirectCapture(client, {
      watch: () => watchOAuthRedirectCookie({ linking, storage, storagePrefix: "shogo", scheme: "shogo", ...jar }),
      readSessionToken: readSessionToken(storage),
    })
    const result: any = await wrapped.signIn.social({ provider: "google" })

    expect(result.data.nativeHandback).toBe("none")
  })

  test("iOS: the plugin wrote a new token during the call, so the hand-back arrived", async () => {
    const storage = fakeStorage({
      shogo_cookie: JSON.stringify({ "shogo.session_token": { value: "stale", expires: null } }),
    })
    const client = {
      signIn: {
        // No watcher on iOS: `@better-auth/expo` stores the cookie itself.
        social: social(() => {
          storage.setItem(
            "shogo_cookie",
            JSON.stringify({ "shogo.session_token": { value: "fresh", expires: null } }),
          )
          return SHEET_RESULT
        }),
      },
    }

    const wrapped = withOAuthRedirectCapture(client, {
      readSessionToken: readSessionToken(storage),
      platform: "ios",
    })
    const result: any = await wrapped.signIn.social({ provider: "google" })

    expect(result.data.nativeHandback).toBe("received")
  })

  test("a call that leaves a user or an error alone is not stamped", async () => {
    const storage = fakeStorage()
    const withUser = {
      signIn: { social: social(() => ({ data: { user: { id: "u1" } } })) },
    }
    const userResult: any = await withOAuthRedirectCapture(withUser, {
      readSessionToken: readSessionToken(storage),
    }).signIn.social({ provider: "google" })
    expect(userResult.data.nativeHandback).toBeUndefined()
  })
})
