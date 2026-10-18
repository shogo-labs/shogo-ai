// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { resolve } from "node:path"
import { beforeEach, describe, expect, mock, test } from "bun:test"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { createElement } from "react"
import { createReactNativeMock } from "../../../../test/react-native-mock"

const push = mock((_href: string) => {})
let kind: "personal" | "team" = "team"
let features: { marketplace: boolean; workBoards: boolean } = { marketplace: true, workBoards: true }

mock.module("react-native", () =>
  createReactNativeMock({
    Platform: { OS: "ios" },
    Pressable: ({ accessibilityLabel, accessibilityRole, children, onPress, ...props }: any) =>
      createElement(
        "button",
        { ...props, "aria-label": accessibilityLabel, onClick: onPress, role: accessibilityRole },
        children,
      ),
  }),
)
mock.module("expo-router", () => ({ usePathname: () => "/(app)/more", useRouter: () => ({ push }) }))
mock.module("@shogo/shared-ui/primitives", () => ({ cn: (...args: unknown[]) => args.filter(Boolean).join(" ") }))
mock.module(resolve(import.meta.dir, "../../../../hooks/useWorkspaceExperience"), () => ({
  useWorkspaceExperience: () => ({ kind, showMarketplace: true }),
}))
mock.module(resolve(import.meta.dir, "../../../../lib/platform-config"), () => ({
  usePlatformConfig: () => ({ features }),
}))
mock.module(resolve(import.meta.dir, "../../../team-chat/TeamChatSidebarProvider"), () => ({
  useTeamChatNav: () => ({ enabled: false, list: [], counts: {} }),
}))
mock.module(resolve(import.meta.dir, "../../../team-chat/ConversationRows"), () => ({
  PanelLink: () => null,
}))
mock.module(resolve(import.meta.dir, "../NavItem"), () => ({ NavItem: () => null }))
mock.module(resolve(import.meta.dir, "../WorkspaceChatsPanel"), () => ({ WorkspaceChatsPanel: () => null }))

const { MorePanel } = await import("../TabPanels")

beforeEach(() => {
  cleanup()
  push.mockClear()
  kind = "team"
  features = { marketplace: true, workBoards: true }
})

describe("MorePanel", () => {
  test("the phone More screen ends with a Settings row that opens settings", () => {
    render(<MorePanel variant="screen" />)
    const settings = screen.getByRole("link", { name: "Settings" })
    expect(settings).toBeTruthy()
    expect(settings.textContent).toContain("Account, workspace, integrations and billing")
    const rows = screen.getAllByRole("link")
    expect(rows[rows.length - 1]).toBe(settings)
    fireEvent.click(settings)
    expect(push).toHaveBeenCalledWith("/(app)/settings")
  })

  test("a personal workspace also lists Settings as its last row", () => {
    kind = "personal"
    features = { marketplace: false, workBoards: false }
    render(<MorePanel variant="screen" />)
    const rows = screen.getAllByRole("link")
    expect(rows.map((row) => row.getAttribute("aria-label"))).toEqual(["Analytics", "Settings"])
    fireEvent.click(screen.getByRole("link", { name: "Settings" }))
    expect(push).toHaveBeenCalledWith("/(app)/settings")
  })

  test("the desktop sidebar More panel lists Settings too", () => {
    render(<MorePanel />)
    expect(screen.getByRole("link", { name: "Settings" })).toBeTruthy()
  })
})
