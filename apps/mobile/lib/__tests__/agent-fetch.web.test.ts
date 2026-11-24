// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-564 — what an authenticated request looks like on **web**.
 *
 * The browser owns the cookie jar: `credentials: 'include'` and no `Cookie`
 * header (setting one by hand would be ignored, and a caller that sets it in a
 * worker would leak the session into a header the browser then duplicates).
 *
 *   bun test apps/mobile/lib/__tests__/agent-fetch.web.test.ts
 */

import { describe, expect, mock, test } from "bun:test"
import { resolve } from "node:path"
import { createReactNativeMock } from "../../test/react-native-mock"

mock.module("react-native", () =>
  createReactNativeMock({ Platform: { OS: "web" } } as any),
)

mock.module(resolve(import.meta.dir, "../auth-client"), () => ({
  authClient: { getCookie: () => "better-auth.session_token=web-cookie" },
}))

const { authedCredentials, authedFetchInit, nativeAuthHeaders } =
  await import("../authed-fetch-init")

describe("authedCredentials", () => {
  test("web asks the browser to send its cookies", () => {
    expect(authedCredentials()).toBe("include")
  })
})

describe("authedFetchInit", () => {
  test("include, and no Cookie header of our own", () => {
    const init = authedFetchInit()
    expect(init.credentials).toBe("include")
    expect(init.headers).toEqual({})
  })

  test("keeps the caller's headers", () => {
    const init = authedFetchInit({
      method: "POST",
      headers: { "Content-Type": "application/json" },
    })
    expect(init.credentials).toBe("include")
    expect(init.headers).toEqual({ "Content-Type": "application/json" })
  })
})

describe("nativeAuthHeaders", () => {
  test("adds nothing on web", () => {
    expect(nativeAuthHeaders()).toEqual({})
  })
})
