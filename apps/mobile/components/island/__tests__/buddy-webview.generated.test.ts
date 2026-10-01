// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from "bun:test"
import { buildBuddyWebviewHtml, formatBuddyWebviewModule } from "../../../scripts/build-buddy-webview"
import { BUDDY_WEBVIEW_HTML } from "../buddy/buddy-webview.generated"

describe("buddy WebView bundle", () => {
  test("checked-in HTML stays in sync with the engine bundle", async () => {
    const html = await buildBuddyWebviewHtml()
    expect(BUDDY_WEBVIEW_HTML).toBe(html)
    expect(formatBuddyWebviewModule(html)).toContain(JSON.stringify(html))
  })
})
