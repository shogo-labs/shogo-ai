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
    expect(labels.get("billing")).toBe("Billing")
    expect(settingsNavItems(["billing"])[0]?.label).toBe(labels.get("billing"))
  })

  test("usage and cost optimizer live on the Analytics screen, not in settings", () => {
    const ids = SETTINGS_TABS.map((tab) => tab.id)
    expect(ids).not.toContain("analytics")
    expect(ids).not.toContain("costs")
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
    expect(local.map((tab) => tab.id)).toContain("models")
    expect(cloud.map((tab) => tab.id)).toContain("models")
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

  test("chat preferences only exist in a team workspace", () => {
    const has = (opts: Parameters<typeof visibleSettingsTabs>[0]) =>
      visibleSettingsTabs(opts).some((tab) => tab.id === "chat")

    expect(has({ teamChat: true })).toBe(true)
    expect(has({ teamChat: true, localMode: true })).toBe(true)
    expect(has({ teamChat: true, isDesktop: true, localMode: false })).toBe(true)
    // Every caller that has not opted in keeps the old tab list.
    expect(has({})).toBe(false)
    expect(has({ localMode: false, showBilling: true, platform: "web" })).toBe(false)
    expect(has({ teamChat: false })).toBe(false)
  })

  test("chat sits between People and Models in both nav lists", () => {
    const ids = (names: Parameters<typeof settingsNavItems>[0]) =>
      settingsNavItems(names).map((item) => item.id)

    // Mirrors MOBILE_NAV_ITEMS / LOCAL_NAV_ITEMS in (app)/settings.tsx, where
    // People only exists in cloud mode.
    const mobile = ids(["workspace", "people", "chat", "models", "integrations"])
    const local = ids(["workspace", "chat", "models", "integrations"])
    expect(mobile.indexOf("chat")).toBe(mobile.indexOf("people") + 1)
    expect(mobile.indexOf("models")).toBe(mobile.indexOf("chat") + 1)
    expect(local.indexOf("chat")).toBe(local.indexOf("workspace") + 1)
    expect(settingsNavItems(["chat"])[0]?.label).toBe("Chat")
  })
})
