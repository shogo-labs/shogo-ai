// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-483: Android Google sign-in "completed without a session".
 *
 * The expo plugin drops the cookie whenever `openAuthSessionAsync` resolves
 * `dismiss`, which on Android happens when the app's own AppState change wins
 * the race against the `shogo://…?cookie=…` deep link. The watcher must keep
 * that cookie so the session read that follows finds it.
 *
 * Run: cd apps/mobile && bun test lib/__tests__/android-oauth-redirect.test.ts
 */

import { describe, expect, test } from "bun:test"
import {
  oauthRedirectCookie,
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

function fakeStorage() {
  const map = new Map<string, string>()
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
        social: async () => {
          setTimeout(() => emit(REDIRECT), 50)
          return { data: { url: "https://accounts.google.com/…", redirect: true } }
        },
      },
    }

    const wrapped = withOAuthRedirectCapture(client, () =>
      watchOAuthRedirectCookie({ linking, storage, storagePrefix: "shogo", scheme: "shogo", ...jar }),
    )
    await wrapped.signIn.social({ provider: "google" })

    const stored = JSON.parse(storage.getItem("shogo_cookie") ?? "{}")
    expect(stored["shogo.session_token"]?.value).toBe("abc.def")
    // Everything else on the client passes straight through.
    expect(wrapped.getSession()).toBe("untouched")
    expect(wrapped.signIn.email()).toBe("email")
  })

  test("stops listening once the sign-in settles", async () => {
    const fake = fakeLinking()
    const storage = fakeStorage()
    const client = {
      signIn: { social: async () => ({ data: { user: { id: "u1" } } }) },
    }
    const wrapped = withOAuthRedirectCapture(client, () =>
      watchOAuthRedirectCookie({ linking: fake.linking, storage, storagePrefix: "shogo", scheme: "shogo", ...jar }),
    )
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
})
