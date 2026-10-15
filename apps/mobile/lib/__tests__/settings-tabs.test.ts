// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from "bun:test"
import {
  SETTINGS_TABS,
  settingsNavItems,
  settingsTabFromParam,
  visibleSettingsTabs,
} from "../settings-tabs"

describe("settings tabs", () => {
  test("team activity is its own plan tab, placed just before Usage", () => {
    const ids = SETTINGS_TABS.map((tab) => tab.id)
    const team = SETTINGS_TABS.find((tab) => tab.id === "team-activity")
    expect(team?.label).toBe("Team activity")
    expect(team?.group).toBe("plan")
    expect(ids.indexOf("team-activity")).toBe(ids.indexOf("analytics") - 1)
    expect(visibleSettingsTabs({ localMode: true, showBilling: false }).map((tab) => tab.id)).toContain("team-activity")
    expect(visibleSettingsTabs({ localMode: false, showBilling: true }).map((tab) => tab.id)).toContain("team-activity")
  })

  test("the ?tab= param selects a known tab and falls back to Workspace", () => {
    expect(settingsTabFromParam("people")).toBe("people")
    expect(settingsTabFromParam(["team-activity", "billing"])).toBe("team-activity")
    expect(settingsTabFromParam("nope")).toBe("workspace")
    expect(settingsTabFromParam(undefined)).toBe("workspace")
  })

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
    expect(cloud.map((tab) => tab.id)).toContain("automations")
    expect(local.map((tab) => tab.id)).toContain("automations")
  })

  test("computer-files tab requires both the desktop shell and local mode", () => {
    const has = (opts: Parameters<typeof visibleSettingsTabs>[0]) =>
      visibleSettingsTabs(opts).some((tab) => tab.id === "computer-files")

    expect(has({ localMode: true, isDesktop: true })).toBe(true)
    expect(has({ localMode: false, showBilling: true, isDesktop: true })).toBe(false)
    expect(has({ localMode: true, isDesktop: false })).toBe(false)
    expect(has({ localMode: false, showBilling: true, isDesktop: false })).toBe(false)
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
