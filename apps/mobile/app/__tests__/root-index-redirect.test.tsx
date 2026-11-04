// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `/` forwards its query string into `(app)` (SHO-300).
 *
 * The workspace agent chat writes `?chatSessionId=X` into the URL so a reload,
 * a second tab or Back reopens the chat that is running. That only works if the
 * root redirect keeps the parameter: a bare `<Redirect href="/(app)" />` minted
 * a fresh empty chat on every full page load.
 */

import { afterEach, expect, mock, test } from "bun:test"
import React from "react"
import { createReactNativeMock } from "../../test/react-native-mock"

let params: Record<string, string | string[]> = {}
const hrefs: unknown[] = []

mock.module("react-native", () =>
  createReactNativeMock({ Platform: { OS: "web", select: (v: any) => v.web ?? v.default } }),
)
mock.module("expo-router", () => ({
  useLocalSearchParams: () => params,
  Redirect: (props: { href: unknown }) => {
    hrefs.push(props.href)
    return null
  },
}))
mock.module("../../contexts/auth", () => ({
  useAuth: () => ({ isAuthenticated: true, isLoading: false, refreshSession: async () => {} }),
}))
mock.module("../../lib/platform-config", () => ({
  usePlatformConfig: () => ({
    configLoaded: true,
    localMode: false,
    needsSetup: false,
  }),
}))
mock.module("../../lib/api", () => ({ API_URL: "http://api.test" }))
mock.module("../../lib/auth-client", () => ({ autoSignInLocally: async () => {} }))

const { render, cleanup, waitFor } = await import("@testing-library/react")
const { default: RootIndex } = await import("../index")

// The screen asks `/api/me` whether onboarding is done before it redirects;
// stubbing fetch keeps that off the network.
const realFetch = globalThis.fetch
globalThis.fetch = (async () =>
  new Response(JSON.stringify({ data: { onboardingCompleted: true } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })) as unknown as typeof globalThis.fetch

afterEach(() => {
  cleanup()
  hrefs.length = 0
})

test("a chat session in the URL reaches the app group", async () => {
  params = { chatSessionId: "sess_123" }
  render(<RootIndex />)

  await waitFor(() => expect(hrefs.length).toBeGreaterThan(0))
  expect(hrefs.at(-1)).toEqual({
    pathname: "/(app)",
    params: { chatSessionId: "sess_123" },
  })
})

test("the landing's own parameters survive the redirect too", async () => {
  params = { chatSessionId: "sess_123", embed: "ide" }
  render(<RootIndex />)

  await waitFor(() => expect(hrefs.length).toBeGreaterThan(0))
  expect(hrefs.at(-1)).toEqual({
    pathname: "/(app)",
    params: { chatSessionId: "sess_123", embed: "ide" },
  })
})

// A `?workspace=` on `/` belongs to the guarded file-link arrival (SHO-284),
// not to the landing: the redirect must not hand it to the screen.
test("a workspace param is left behind at the front door", async () => {
  params = { chatSessionId: "sess_123", workspace: "ws-stranger", file: "p/f.md" }
  render(<RootIndex />)

  await waitFor(() => expect(hrefs.length).toBeGreaterThan(0))
  expect(hrefs.at(-1)).toEqual({
    pathname: "/(app)",
    params: { chatSessionId: "sess_123" },
  })
})

test("a plain arrival still redirects to the app group", async () => {
  params = {}
  render(<RootIndex />)

  await waitFor(() => expect(hrefs.length).toBeGreaterThan(0))
  expect(hrefs.at(-1)).toBe("/(app)")
})
