// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-564 — what an authenticated request looks like on **native**.
 *
 * `expo/fetch` reads an *undefined* `credentials` as `'include'`, and on iOS
 * `'include'` makes NSURLSession copy the shared `HTTPCookieStorage` jar into
 * the request and then append our own `Cookie` on top. Whenever the jar holds
 * anything for the API host the request carries a stale or duplicated cookie
 * and better-auth answers 401 — that is why the rejoin probe, the task list,
 * quick-actions, Stop and `/api/machines` all failed while a send (which
 * already used this shape) worked.
 *
 * So on native: `credentials: 'omit'` **and** the session cookie from
 * `authClient.getCookie()` as a `Cookie` header. Both, every time.
 *
 *   bun test apps/mobile/lib/__tests__/agent-fetch.native.test.ts
 */

import { describe, expect, mock, test } from "bun:test"
import { resolve } from "node:path"
import { createReactNativeMock } from "../../test/react-native-mock"

mock.module("react-native", () =>
  createReactNativeMock({ Platform: { OS: "ios" } } as any),
)

const COOKIE = "better-auth.session_token=native-cookie"
mock.module(resolve(import.meta.dir, "../auth-client"), () => ({
  authClient: { getCookie: () => COOKIE },
}))

// The preload replaces `agent-fetch` wholesale so a test can install a handler
// for every API call; the init builders live in their own module so this test
// sees the real ones.
const { authedCredentials, authedFetchInit, nativeAuthHeaders } =
  await import("../authed-fetch-init")

describe("authedCredentials", () => {
  test("native never asks the platform for its cookie jar", () => {
    expect(authedCredentials()).toBe("omit")
  })
})

describe("authedFetchInit", () => {
  test("carries the session cookie as a header and omits the jar", () => {
    const init = authedFetchInit()
    expect(init.credentials).toBe("omit")
    expect(init.headers).toEqual({ Cookie: COOKIE })
  })

  test("keeps the caller's own headers and method", () => {
    const init = authedFetchInit({
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Chat-Session-Id": "s1" },
      body: "{}",
    })
    expect(init.method).toBe("POST")
    expect(init.body).toBe("{}")
    expect(init.credentials).toBe("omit")
    expect(init.headers).toEqual({
      Cookie: COOKIE,
      "Content-Type": "application/json",
      "X-Chat-Session-Id": "s1",
    })
  })

  test("a caller-provided Cookie wins over the stored one", () => {
    const init = authedFetchInit({ headers: { Cookie: "explicit=1" } })
    expect((init.headers as any).Cookie).toBe("explicit=1")
  })

  test("leaves the signal, body and other init fields alone", () => {
    const signal = new AbortController().signal
    const init = authedFetchInit({ signal, cache: "no-store" })
    expect(init.signal).toBe(signal)
    expect(init.cache).toBe("no-store")
  })
})

describe("nativeAuthHeaders", () => {
  test("is the same cookie the init carries", () => {
    expect(nativeAuthHeaders()).toEqual({ Cookie: COOKIE })
  })
})
