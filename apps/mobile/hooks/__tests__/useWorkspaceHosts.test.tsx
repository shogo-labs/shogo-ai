// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-564 — `/api/machines` on a native device.
 *
 * The host badge polled every 30 s with a bare `credentials: "include"` and no
 * `Cookie` header. On iOS `'include'` lets NSURLSession add the shared cookie
 * jar on top, better-auth refused it, and the badge never loaded (645 refusals
 * in one day). The hook now goes through `agentFetch`, which carries the session
 * cookie and `credentials: 'omit'` on native.
 *
 * The fake server here is the point of view that matters: **no `Cookie` header,
 * no hosts.** That is precisely what the device sent before this fix, so the
 * test fails if the hook ever goes back to a bare `fetch`.
 *
 *   bun test apps/mobile/hooks/__tests__/useWorkspaceHosts.test.tsx
 */

import { afterEach, describe, expect, mock, test } from "bun:test"
import { resolve } from "node:path"
import { cleanup, renderHook, waitFor } from "@testing-library/react"
import { createReactNativeMock } from "../../test/react-native-mock"
// The real helper: the wiring under test is the helper's, only the network is
// faked. (`lib/agent-fetch` itself is replaced below, so this test can see the
// init the hook's request actually ends up with.)
import { authedCredentials, authedFetchInit, nativeAuthHeaders } from "../../lib/authed-fetch-init"

mock.module("react-native", () =>
  createReactNativeMock({
    Platform: { OS: "ios" },
    AppState: { currentState: "active", addEventListener: () => ({ remove: () => {} }) },
  } as any),
)

mock.module(resolve(import.meta.dir, "../../lib/api"), () => ({
  API_URL: "http://api.test",
}))

/** What the device holds in SecureStore; `null` reproduces the broken case. */
let sessionCookie: string | null = "better-auth.session_token=native-cookie"

mock.module(resolve(import.meta.dir, "../../lib/auth-client"), () => ({
  authClient: { getCookie: () => sessionCookie },
}))

mock.module(resolve(import.meta.dir, "../../lib/agent-fetch"), () => ({
  authedCredentials,
  authedFetchInit,
  nativeAuthHeaders,
  agentFetch: (input: RequestInfo | URL, init?: RequestInit) =>
    globalThis.fetch(input, authedFetchInit(init)),
}))

const MACHINES = {
  machines: [
    { id: "inst-1", name: "Russell's MacBook", kind: "desktop", status: "online", lastSeenAt: null },
  ],
}

const seen: Array<{ url: string; cookie: string | undefined; credentials?: RequestCredentials }> = []

const realFetch = globalThis.fetch
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const cookie = (init?.headers as Record<string, string> | undefined)?.Cookie
  seen.push({
    url: typeof input === "string" ? input : input.toString(),
    cookie,
    credentials: init?.credentials,
  })
  return cookie === sessionCookie && cookie
    ? new Response(JSON.stringify(MACHINES), { status: 200 })
    : new Response(JSON.stringify({ error: { message: "unauthorized" } }), { status: 401 })
}) as typeof globalThis.fetch

const { useWorkspaceHosts } = await import("../useWorkspaceHosts")

afterEach(() => {
  cleanup()
  seen.length = 0
  sessionCookie = "better-auth.session_token=native-cookie"
})

describe("useWorkspaceHosts on native", () => {
  test("sends the session cookie and omits the jar, so the hosts load", async () => {
    const { result } = renderHook(() => useWorkspaceHosts())

    await waitFor(() => expect(result.current.hosts).toHaveLength(1))
    expect(result.current.hosts[0]).toMatchObject({ instanceId: "inst-1", presence: "online" })
    expect(result.current.error).toBeNull()

    const request = seen.find((r) => r.url.endsWith("/api/machines"))
    expect(request).toBeDefined()
    expect(request!.cookie).toBe("better-auth.session_token=native-cookie")
    expect(request!.credentials).toBe("omit")
  })

  test("a poll with no cookie is refused, and the badge says why", async () => {
    // The old request: no Cookie header, credentials left to the platform.
    sessionCookie = null
    const { result } = renderHook(() => useWorkspaceHosts())

    await waitFor(() => expect(result.current.error).toBe("unauthorized"))
    expect(result.current.hosts).toEqual([])
    expect(seen[0].credentials).toBe("omit")
  })
})
