// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { beforeEach, describe, expect, test } from "bun:test"
import {
  armPermissionNudge,
  dismissPermissionNudge,
  resetPermissionNudgeForTests,
  shouldShowPermissionNudge,
} from "../permission-nudge"

beforeEach(() => {
  resetPermissionNudgeForTests()
})

describe("permission nudge", () => {
  test("stays hidden until a direct message or mention arrives", () => {
    expect(shouldShowPermissionNudge("default")).toBe(false)
    armPermissionNudge("thread")
    expect(shouldShowPermissionNudge("default")).toBe(false)
    armPermissionNudge(undefined)
    expect(shouldShowPermissionNudge("default")).toBe(false)
  })

  test("a direct message arms it, and it shows while permission is undecided", () => {
    armPermissionNudge("dm")
    expect(shouldShowPermissionNudge("default")).toBe(true)
  })

  test("a mention arms it too", () => {
    armPermissionNudge("mention")
    expect(shouldShowPermissionNudge("default")).toBe(true)
  })

  test("never shows once permission is granted or denied", () => {
    armPermissionNudge("dm")
    expect(shouldShowPermissionNudge("granted")).toBe(false)
    expect(shouldShowPermissionNudge("denied")).toBe(false)
    expect(shouldShowPermissionNudge(null)).toBe(false)
  })

  test("'Not now' hides it for good", () => {
    armPermissionNudge("dm")
    dismissPermissionNudge()
    expect(shouldShowPermissionNudge("default")).toBe(false)
    armPermissionNudge("mention")
    expect(shouldShowPermissionNudge("default")).toBe(false)
  })
})
