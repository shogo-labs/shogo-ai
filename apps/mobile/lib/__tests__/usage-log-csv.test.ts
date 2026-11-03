// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The usage-log CSV download follows the workspace in view (SHO-108, folds
 * SHO-91's symptom).
 *
 * Every workspace, including one hosted on a paired desktop, exports from this
 * app's API (SHO-285).
 */

import { describe, expect, mock, test } from "bun:test"

mock.module("../api-url", () => ({ API_URL: "https://app.test" }))

const { memberMessagesCsvPath, memberMessagesCsvUrl, usageLogCsvPath, usageLogCsvUrl } = await import(
  "../usage-log-csv",
)

describe("SHO-108 — the usage CSV comes from the workspace in view", () => {
  test("it is this app's own API, for every workspace", () => {
    expect(usageLogCsvUrl({ workspaceId: "ws-cloud", params: { period: "30d" } })).toBe(
      "https://app.test/api/workspaces/ws-cloud/analytics/usage-log.csv?period=30d",
    )
  })




  test("no filters means no query string", () => {
    expect(usageLogCsvPath("ws-cloud")).toBe("/api/workspaces/ws-cloud/analytics/usage-log.csv")
  })
})

describe("SHO-199 — one person's messages export", () => {
  test("names the person and the window, so the file is only their rows", () => {
    expect(
      memberMessagesCsvPath("ws-cloud", "user-1", { since: "2026-07-01T00:00:00.000Z", audience: "person" }),
    ).toBe(
      "/api/workspaces/ws-cloud/member-activity/messages.csv?user=user-1&since=2026-07-01T00%3A00%3A00.000Z&audience=person",
    )
  })

  test("a user id that needs escaping is encoded, not pasted into the path", () => {
    expect(memberMessagesCsvPath("ws-cloud", "user/../1")).toBe(
      "/api/workspaces/ws-cloud/member-activity/messages.csv?user=user%2F..%2F1",
    )
  })

})
