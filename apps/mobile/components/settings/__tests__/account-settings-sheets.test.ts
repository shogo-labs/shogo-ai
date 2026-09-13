// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from "bun:test"
import { accountSettingsSheetGroups, accountSettingsSheetTitle } from "../account-settings-sheets"

describe("accountSettingsSheetGroups", () => {
  test("labels come from the shared title map", () => {
    const groups = accountSettingsSheetGroups({ localMode: false, showBilling: true })
    const tabs = groups.flatMap((group) => group.tabs)
    expect(groups.map((group) => group.title)).toEqual(["Settings", "Plan"])
    expect(tabs.find((tab) => tab.id === "analytics")?.label).toBe("Usage")
    expect(tabs.find((tab) => tab.id === "analytics")?.label).toBe(
      accountSettingsSheetTitle("analytics"),
    )
  })

  test("hides cloud-only tabs in local mode", () => {
    const groups = accountSettingsSheetGroups({ localMode: true, showBilling: false })
    const ids = groups.flatMap((group) => group.tabs.map((tab) => tab.id))
    expect(ids).toContain("security")
    expect(ids).toContain("support")
    expect(ids).not.toContain("people")
    expect(ids).not.toContain("billing")
  })
})
