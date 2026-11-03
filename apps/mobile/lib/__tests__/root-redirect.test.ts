// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * `/` must hand its query string to the `(app)` group (SHO-300): the workspace
 * agent chat writes `?chatSessionId=X` so a reload, a second tab or Back can
 * reopen the running chat, and the redirect used to drop it.
 */

import { expect, test } from "bun:test"
import { appRedirectHref } from "../root-redirect"

test("a chat session in the URL survives the redirect", () => {
  expect(appRedirectHref({ chatSessionId: "sess_123" })).toEqual({
    pathname: "/(app)",
    params: { chatSessionId: "sess_123" },
  })
})

test("every parameter survives, not just the chat session", () => {
  expect(appRedirectHref({ chatSessionId: "s", embed: "ide" })).toEqual({
    pathname: "/(app)",
    params: { chatSessionId: "s", embed: "ide" },
  })
})

test("a repeated parameter keeps all of its values", () => {
  expect(appRedirectHref({ chatSessionId: ["first", "second"] })).toEqual({
    pathname: "/(app)",
    params: { chatSessionId: ["first", "second"] },
  })
})

test("an empty value is not forwarded", () => {
  expect(appRedirectHref({ chatSessionId: "", embed: [] })).toBe("/(app)")
})

test("a plain arrival redirects with no params", () => {
  expect(appRedirectHref({})).toBe("/(app)")
  expect(appRedirectHref(undefined)).toBe("/(app)")
})
