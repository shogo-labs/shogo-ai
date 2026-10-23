// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The usage-log CSV download follows the workspace in view (SHO-108, folds
 * SHO-91's symptom).
 *
 * The download is a plain URL, so it cannot go through the interceptor like the
 * JSON analytics call does. Before this it was built from `${API_URL}` by hand,
 * so while a paired computer's own workspace was open the tab showed that
 * machine's numbers and the CSV handed back the cloud workspace's.
 */

import { describe, expect, mock, test } from "bun:test"
import { shouldRouteToRemote } from "../../../../packages/shared-app/src/services/remote-http-interceptor"

mock.module("../api-url", () => ({ API_URL: "https://app.test" }))

const { usageLogCsvPath, usageLogCsvUrl } = await import("../usage-log-csv")

const MACHINE = {
  relayBaseUrl: "https://app.test/api/machines/inst-odin/w/lw-main",
  localWorkspaceId: "lw-main",
}

describe("SHO-108 — the usage CSV comes from the workspace in view", () => {
  test("without a machine it is this app's own API", () => {
    expect(usageLogCsvUrl({ workspaceId: "ws-cloud", params: { period: "30d" } })).toBe(
      "https://app.test/api/workspaces/ws-cloud/analytics/usage-log.csv?period=30d",
    )
  })

  test("with a machine workspace open it goes through that machine's relay", () => {
    expect(
      usageLogCsvUrl({ workspaceId: "ws-cloud", params: { period: "30d" }, machine: MACHINE }),
    ).toBe(
      "https://app.test/api/machines/inst-odin/w/lw-main/api/workspaces/lw-main/analytics/usage-log.csv?period=30d",
    )
  })

  test("the machine path names the machine's own workspace id, not the cloud one", () => {
    const url = usageLogCsvUrl({ workspaceId: "ws-cloud", machine: MACHINE })
    expect(url).toContain("/api/workspaces/lw-main/")
    expect(url).not.toContain("ws-cloud")
  })

  test("the path is the one the JSON analytics call uses, whatever the host", () => {
    // Same route, same filters: the download and the numbers describe one workspace.
    const path = usageLogCsvPath("ws-cloud", { period: "7d", model: "gpt-5", limit: 100 })
    expect(path).toBe(
      "/api/workspaces/ws-cloud/analytics/usage-log.csv?period=7d&model=gpt-5&limit=100",
    )
    expect(shouldRouteToRemote("/api/workspaces/ws-cloud/analytics/usage-log.csv", { machineWorkspaceId: "lw-main" })).toBe(
      true,
    )
  })

  test("no filters means no query string", () => {
    expect(usageLogCsvPath("ws-cloud")).toBe("/api/workspaces/ws-cloud/analytics/usage-log.csv")
  })
})
