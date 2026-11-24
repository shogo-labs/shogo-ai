// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * QA acceptance for SHO-564 — "rejoining a chat on iOS is slow and often
 * fails".
 *
 * The card's cause 1 is a credential shape, and the failure it produces is
 * specific: on iOS expo/fetch reads an *undefined* `credentials` as
 * `'include'`, `ExpoURLSessionTask` then turns on `httpShouldHandleCookies` and
 * appends our own `Cookie` header on top of whatever the shared jar holds, and
 * better-auth answers 401. `/turn` 401'd 882 times in one morning and the chat
 * only ever showed "Rejoining live reply…" until it gave up.
 *
 * So the server in these tests is as unforgiving as the phone: **it refuses any
 * request that asks for the cookie jar** (`credentials === 'include'`) or that
 * carries a `Cookie` the person no longer holds. That is the same request the
 * device sent before this card, so the tests below fail if the transport ever
 * goes back to leaving `credentials` to the platform.
 *
 * The rejoin path itself is driven for real (`probeChatTurn`), including the
 * one session refresh the card asks for when the API refuses the credential.
 *
 *   bun test apps/mobile/components/chat/__tests__/qa-sho564-rejoin-native.acceptance.test.ts
 */

import { describe, expect, test } from "bun:test"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { mock } from "bun:test"
import { createReactNativeMock } from "../../../test/react-native-mock"

mock.module("react-native", () =>
  createReactNativeMock({ Platform: { OS: "ios" } } as any),
)

const MOBILE = join(import.meta.dir, "../../..")

let storedCookie = "better-auth.session_token=dead"
mock.module(join(MOBILE, "lib/auth-client"), () => ({
  authClient: { getCookie: () => storedCookie },
}))

const { authedCredentials, nativeAuthHeaders } = await import("../../../lib/authed-fetch-init")
const { probeChatTurn } = await import("../probe-turn-status")

/** What the device currently holds in SecureStore; `null` = signed out. */
function setCookie(cookie: string | null) {
  storedCookie = cookie ?? ""
}

/**
 * The API as the phone experiences it: a request may present the session
 * **only** as a `Cookie` header with `credentials: 'omit'`. Asking for the jar
 * mixes in a stale cookie and better-auth refuses it.
 */
function strictApi(
  body: unknown = { status: "active", turnId: "turn-live" },
  /** Override which cookie the API still honours (a revoked session). */
  accepts: () => string | null = () => storedCookie,
) {
  const calls: Array<{ headers: Record<string, string>; credentials?: RequestCredentials }> = []
  const fn = (async (_input: RequestInfo | URL, init: any) => {
    const headers = (init?.headers ?? {}) as Record<string, string>
    calls.push({ headers, credentials: init?.credentials })
    const jarAsked = init?.credentials === "include" || init?.credentials === undefined
    const presented = headers.Cookie
    if (jarAsked || !presented || presented !== accepts()) {
      return { ok: false, status: 401, async json() { return null } } as any
    }
    return { ok: true, status: 200, async json() { return body } } as any
  }) as unknown as typeof globalThis.fetch
  return Object.assign(fn, { calls })
}

describe("rejoining a live turn on iOS", () => {
  test("the probe carries the session the way native needs it", async () => {
    setCookie("better-auth.session_token=live")
    const fetch = strictApi()

    const snapshot = await probeChatTurn({
      url: "http://api.test/api/workspaces/w/chat/s/turn",
      fetch,
      headers: nativeAuthHeaders,
      credentials: authedCredentials(),
    })

    expect(fetch.calls).toHaveLength(1)
    expect(fetch.calls[0].credentials).toBe("omit")
    expect(fetch.calls[0].headers.Cookie).toBe("better-auth.session_token=live")
    expect(snapshot).toEqual({ status: "active", turnId: "turn-live", answered: true })
  })

  test("a refused credential refreshes the session once and the retry re-attaches", async () => {
    // The stored cookie has gone stale (the app sat in the background): the API
    // only honours the one the refresh will store.
    setCookie("better-auth.session_token=stale")
    const fetch = strictApi(undefined, () => "better-auth.session_token=fresh")
    let refreshes = 0

    const snapshot = await probeChatTurn({
      url: "http://api.test/api/workspaces/w/chat/s/turn",
      fetch,
      headers: nativeAuthHeaders,
      credentials: authedCredentials(),
      onRefused: async () => {
        refreshes += 1
        setCookie("better-auth.session_token=fresh")
        return true
      },
      retryDelaysMs: [1, 1],
    })

    // Exactly one refresh, and the retry presents the refreshed cookie — not
    // the dead one the first attempt carried.
    expect(refreshes).toBe(1)
    expect(fetch.calls).toHaveLength(2)
    expect(fetch.calls[1].headers.Cookie).toBe("better-auth.session_token=fresh")
    expect(fetch.calls[1].credentials).toBe("omit")
    // The whole point of the card: the live reply comes back.
    expect(snapshot).toEqual({ status: "active", turnId: "turn-live", answered: true })
  })

  test("when the refresh cannot help, the probe says the session is gone", async () => {
    // The session is revoked server-side: no cookie the device can present is
    // accepted, so the refresh the probe performs cannot rescue it.
    setCookie("better-auth.session_token=stale")
    const fetch = strictApi(undefined, () => null)

    const snapshot = await probeChatTurn({
      url: "http://api.test/api/workspaces/w/chat/s/turn",
      fetch,
      headers: nativeAuthHeaders,
      credentials: authedCredentials(),
      onRefused: async () => false,
    })

    // Reported, not swallowed: `probeChatTurn` must never answer a 401 with a
    // plain `unknown`, which ChatPanel reads as "no live turn" and goes idle.
    expect(snapshot.refused).toBe(true)
    expect(snapshot.answered).toBe(false)
    expect(snapshot.status).toBe("unknown")
  })

  test("the request shape that caused the bug is refused by the same API", async () => {
    // `credentials: Platform.OS === "web" ? "include" : undefined` with no
    // Cookie header — what `/turn`, `/tasks`, quick-actions, Stop and
    // `/api/machines` sent before this card.
    setCookie("better-auth.session_token=live")
    const fetch = strictApi()

    const snapshot = await probeChatTurn({
      url: "http://api.test/api/workspaces/w/chat/s/turn",
      fetch,
      credentials: undefined,
    })

    expect(fetch.calls[0].credentials).toBeUndefined()
    expect(fetch.calls[0].headers.Cookie).toBeUndefined()
    expect(snapshot.refused).toBe(true)
  })
})

describe("the credential rule at the call sites", () => {
  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      if (["node_modules", "__tests__", ".expo", "dist"].includes(entry)) continue
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) walk(full, out)
      else if (/\.tsx?$/.test(entry)) out.push(full)
    }
    return out
  }

  const read = (rel: string) => readFileSync(join(MOBILE, rel), "utf8")
  const code = (text: string) =>
    text
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\*)/.test(line))
      .join("\n")

  test("no module picks credentials with a ternary that throws native away", () => {
    // The literal shape from the card's cause 1.
    const offenders = walk(MOBILE)
      .filter((file) =>
        /credentials:\s*Platform\.OS\s*===\s*["']web["']\s*\?\s*["']include["']\s*:\s*undefined/.test(
          code(readFileSync(file, "utf8")),
        ),
      )
      .map((file) => file.slice(MOBILE.length + 1))
    expect(offenders).toEqual([])
  })

  test("every listed ChatPanel call goes through the shared init", () => {
    const panel = code(read("components/chat/ChatPanel.tsx"))
    // history search, quick-actions, task list, task cancel, task output and
    // the tunnel health poll.
    expect((panel.match(/authedFetchInit\(/g) ?? []).length).toBeGreaterThanOrEqual(6)
    // No call site leaves the mode to the platform (`undefined` is what the
    // phone turns into `'include'`). The one ternary left is the send
    // transport, which asks for the jar on web and `'omit'` on native.
    expect(panel).not.toMatch(/credentials:\s*Platform\.OS[^\n]*:\s*undefined/)
    expect(panel).not.toMatch(/credentials:\s*undefined/)
    expect((panel.match(/authedCredentials\(\)/g) ?? []).length).toBeGreaterThanOrEqual(6)
  })

  test("the rejoin probe refreshes the session instead of going quiet", () => {
    const panel = code(read("components/chat/ChatPanel.tsx"))
    expect(panel).toMatch(/onRefused:\s*\(\)\s*=>\s*reauthorizeChatRef\.current\(\)/)
    expect(panel).toMatch(/credentials:\s*authedCredentials\(\)/)
    // A refusal has to be visible as a signed-out session, not as an idle chat.
    expect(panel).toMatch(/if \(snapshot\.refused[\s\S]{0,200}setSessionExpired\(true\)/)
  })

  test("Stop omits the jar on native and the host badge uses the shared fetch", () => {
    const stop = code(read("lib/chat-stop.ts"))
    // Both builders: the stop and the per-subagent cancel.
    expect(stop.match(/init\.credentials = 'omit'/g) ?? []).toHaveLength(2)
    expect(read("hooks/useWorkspaceHosts.ts")).toContain('agentFetch(`${API_URL}/api/machines`)')
  })
})
