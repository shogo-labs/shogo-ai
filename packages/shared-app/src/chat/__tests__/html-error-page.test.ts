// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-483: a Cloudflare 502 page reached the chat banner as raw HTML
 * (Sentry JAVASCRIPT-REACT-45, ~190 events) — the AI SDK uses the response
 * body as the error message.
 *
 * Run: bun test packages/shared-app/src/chat/__tests__/html-error-page.test.ts
 */
import { describe, expect, test } from "bun:test"
import { formatErrorMessage, summarizeHtmlErrorPage } from "../message-helpers"
import { buildChatStreamErrorReport, classifyChatError } from "../chat-error-telemetry"

const CLOUDFLARE_502 = `<!DOCTYPE html>
<!--[if lt IE 7]> <html class="no-js ie6 oldie" lang="en-US"> <![endif]-->
<!--[if gt IE 8]><!--> <html class="no-js" lang="en-US"> <!--<![endif]-->
<head>

<title>shogo.ai | 502: Bad gateway</title>
<meta charset="UTF-8" />
</head>
<body><span class="cf-footer-item">Performance &amp; security by Cloudflare</span></body></html>`

describe("summarizeHtmlErrorPage", () => {
  test("reads the status and title of a CDN error page", () => {
    expect(summarizeHtmlErrorPage(CLOUDFLARE_502)).toEqual({
      status: 502,
      title: "shogo.ai | 502: Bad gateway",
    })
  })

  test("leaves JSON and plain text alone", () => {
    expect(summarizeHtmlErrorPage('{"error":{"message":"nope"}}')).toBeNull()
    expect(summarizeHtmlErrorPage("Failed to fetch")).toBeNull()
    expect(summarizeHtmlErrorPage("Use <html> tags in your answer")).toBeNull()
  })
})

describe("formatErrorMessage on an HTML page", () => {
  test("says the servers did not respond, with the status, and no markup", () => {
    const message = formatErrorMessage(CLOUDFLARE_502)
    expect(message).toBe("Shogo's servers didn't respond (502: Bad gateway). Please tap Retry in a moment.")
    expect(message).not.toContain("<")
  })
})

describe("chat stream error telemetry for an HTML page", () => {
  test("is a connection error with the status tagged and a short rawMessage", () => {
    const err = new Error(CLOUDFLARE_502)
    expect(classifyChatError(err)).toBe("connection")
    const report = buildChatStreamErrorReport(err, { phase: "stream" })
    expect(report?.class).toBe("connection")
    expect(report?.tags.upstreamStatus).toBe("502")
    expect(report?.extra.rawMessage).toBe("HTML error page 502: shogo.ai | 502: Bad gateway")
  })
})
