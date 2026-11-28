// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * `/` must hand its query string to the `(app)` group (SHO-300): the workspace
 * agent chat writes `?chatSessionId=X` so a reload, a second tab or Back can
 * reopen the running chat, and the redirect used to drop it.
 */

import { expect, test } from "bun:test"
import { appRedirectHref, onboardingRedirectHref } from "../root-redirect"

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

// SHO-613: the sign-up intent keys (`plan`, `trial`, `prompt`, `utm_*`) are part
// of the destination too — an Instagram ad is followed through `/` into
// onboarding, and losing them there is what made an ad unfollowable end to end.
test("the sign-up intent survives the redirect into the app", () => {
  expect(
    appRedirectHref({ plan: "pro", trial: "14", prompt: "hi", utm_source: "ig" }),
  ).toEqual({
    pathname: "/(app)",
    params: { plan: "pro", trial: "14", prompt: "hi", utm_source: "ig" },
  })
})

test("the sign-up intent survives the redirect into onboarding", () => {
  expect(
    onboardingRedirectHref({
      utm_source: "ig",
      utm_medium: "paid",
      utm_campaign: "launch",
      utm_content: "story",
      utm_term: "build",
      plan: "pro",
    }),
  ).toEqual({
    pathname: "/(onboarding)",
    params: {
      utm_source: "ig",
      utm_medium: "paid",
      utm_campaign: "launch",
      utm_content: "story",
      utm_term: "build",
      plan: "pro",
    },
  })
})

test("the intent keys are not the ones the arrival flow guards", () => {
  // `workspace` and `file` still must not ride along (SHO-284).
  expect(
    onboardingRedirectHref({ plan: "pro", workspace: "11111111-2222-3333-4444-555555555555" }),
  ).toEqual({ pathname: "/(onboarding)", params: { plan: "pro" } })
})

test("a plain onboarding arrival has no params", () => {
  expect(onboardingRedirectHref({})).toBe("/(onboarding)")
  expect(onboardingRedirectHref(undefined)).toBe("/(onboarding)")
})
