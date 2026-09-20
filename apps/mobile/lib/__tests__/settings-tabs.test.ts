// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from "bun:test"
import {
  SETTINGS_TABS,
  settingsNavItems,
  visibleSettingsTabs,
} from "../settings-tabs"

describe("settings tabs", () => {
  test("uses one label catalog for navigation and account sheets", () => {
    const labels = new Map(SETTINGS_TABS.map((tab) => [tab.id, tab.label]))
    expect(labels.get("costs")).toBe("Cost Optimizer")
    expect(settingsNavItems(["costs"])[0]?.label).toBe(labels.get("costs"))
  })

  test("applies cloud, local, billing, and iOS visibility rules", () => {
    const cloud = visibleSettingsTabs({ localMode: false, showBilling: true, platform: "web" })
    const local = visibleSettingsTabs({ localMode: true, showBilling: false, platform: "darwin" })
    const ios = visibleSettingsTabs({ localMode: false, showBilling: true, platform: "ios" })

    expect(cloud.map((tab) => tab.id)).toContain("people")
    expect(cloud.map((tab) => tab.id)).toContain("compute")
    expect(local.map((tab) => tab.id)).toContain("security")
    expect(local.map((tab) => tab.id)).toContain("billing")
    expect(local.map((tab) => tab.id)).not.toContain("people")
    expect(ios.map((tab) => tab.id)).not.toContain("compute")
  })

  test("updates tab is desktop-only regardless of local/cloud mode", () => {
    const desktopLocal = visibleSettingsTabs({ localMode: true, isDesktop: true })
    const desktopCloud = visibleSettingsTabs({ localMode: false, showBilling: true, isDesktop: true })
    const webCloud = visibleSettingsTabs({ localMode: false, showBilling: true, isDesktop: false })
    const webLocalNonDesktop = visibleSettingsTabs({ localMode: true, isDesktop: false })

    expect(desktopLocal.map((tab) => tab.id)).toContain("updates")
    expect(desktopCloud.map((tab) => tab.id)).toContain("updates")
    expect(webCloud.map((tab) => tab.id)).not.toContain("updates")
    expect(webLocalNonDesktop.map((tab) => tab.id)).not.toContain("updates")
  })
})
