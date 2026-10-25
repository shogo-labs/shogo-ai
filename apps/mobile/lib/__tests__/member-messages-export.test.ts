// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The Export action on a team-table row (SHO-199): the window it asks for and
 * where the download goes. Kept out of the component so it runs without
 * mounting the analytics screen.
 */

import { describe, expect, mock, test } from "bun:test"

mock.module("../api-url", () => ({ API_URL: "https://app.test" }))

const { exportMemberMessages, memberMessagesSince } = await import("../member-messages-export")

const NOW = new Date("2026-07-08T12:00:00.000Z")
const MACHINE = {
  relayBaseUrl: "https://app.test/api/machines/inst-odin/w/lw-main",
  localWorkspaceId: "lw-main",
}

describe("memberMessagesSince", () => {
  test("rolling periods become an ISO start, all time omits it", () => {
    expect(memberMessagesSince("7d", NOW)).toBe("2026-07-01T12:00:00.000Z")
    expect(memberMessagesSince("30d", NOW)).toBe("2026-06-08T12:00:00.000Z")
    expect(memberMessagesSince("90d", NOW)).toBe("2026-04-09T12:00:00.000Z")
    expect(memberMessagesSince("all", NOW)).toBeUndefined()
  })
})

describe("exportMemberMessages", () => {
  test("opens this person's messages for the range on screen", () => {
    const opened: string[] = []
    const url = exportMemberMessages({
      workspaceId: "ws-1",
      userId: "user-1",
      period: "7d",
      now: NOW,
      open: (u) => opened.push(u),
    })

    expect(url).toBe(
      "https://app.test/api/workspaces/ws-1/member-activity/messages.csv?user=user-1&since=2026-07-01T12%3A00%3A00.000Z",
    )
    expect(opened).toEqual([url])
  })

  test("all time exports the whole history instead of the last 7 days", () => {
    const url = exportMemberMessages({
      workspaceId: "ws-1",
      userId: "user-1",
      period: "all",
      now: NOW,
      open: () => {},
    })
    expect(url).toBe("https://app.test/api/workspaces/ws-1/member-activity/messages.csv?user=user-1")
  })

  test("a paired computer's workspace exports from that machine", () => {
    const url = exportMemberMessages({
      workspaceId: "ws-cloud",
      userId: "user-1",
      period: "all",
      machine: MACHINE,
      now: NOW,
      open: () => {},
    })
    expect(url).toBe(
      "https://app.test/api/machines/inst-odin/w/lw-main/api/workspaces/lw-main/member-activity/messages.csv?user=user-1",
    )
  })
})
