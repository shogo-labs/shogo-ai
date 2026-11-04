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

test("the parameters the landing understands survive with the chat session", () => {
  expect(appRedirectHref({ chatSessionId: "s", embed: "ide" })).toEqual({
    pathname: "/(app)",
    params: { chatSessionId: "s", embed: "ide" },
  })
})

// `workspace=` and `file=` are the guarded file-link arrival (SHO-284): the
// sidebar and `useFileLinkArrival` decide, once the workspace list is known,
// whether a link may move the person. Forwarding them through `/` would hand
// every page load to that flow, so the redirect leaves them alone.
test("a workspace or file param is not forwarded", () => {
  expect(
    appRedirectHref({
      chatSessionId: "s",
      workspace: "11111111-2222-3333-4444-555555555555",
      file: "proj-1/E2E-REPORT.md",
    }),
  ).toEqual({ pathname: "/(app)", params: { chatSessionId: "s" } })
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
