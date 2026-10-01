// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { resolve } from "node:path"
import { beforeEach, describe, expect, mock, test } from "bun:test"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { createElement } from "react"
import { createReactNativeMock } from "../../../../test/react-native-mock"

const push = mock((_href: string) => {})
let pathname = "/(app)"
let chat: any

mock.module("react-native", () =>
  createReactNativeMock({
    Platform: { OS: "ios" },
    Pressable: ({ accessibilityLabel, accessibilityRole, accessibilityState, children, onPress, ...props }: any) =>
      createElement(
        "button",
        { ...props, "aria-label": accessibilityLabel, "aria-selected": accessibilityState?.selected, onClick: onPress, role: accessibilityRole },
        children,
      ),
  }),
)
mock.module("expo-router", () => ({ usePathname: () => pathname, useRouter: () => ({ push }) }))
mock.module("@shogo/shared-ui/primitives", () => ({ cn: (...args: unknown[]) => args.filter(Boolean).join(" ") }))
mock.module("lucide-react-native", () => {
  const Icon = () => createElement("span")
  return { Bell: Icon, Bot: Icon, Folder: Icon, Hash: Icon, Home: Icon, MessagesSquare: Icon, Mic: Icon, MoreHorizontal: Icon, Plus: Icon, Settings: Icon, Target: Icon }
})
mock.module(resolve(import.meta.dir, "../../../branding/ShogoLogoMark"), () => ({ ShogoLogoMark: () => createElement("span") }))
mock.module(resolve(import.meta.dir, "../../CreateMenu"), () => ({ CreateMenu: () => createElement("span") }))
mock.module(resolve(import.meta.dir, "../../ProfileMenu"), () => ({ ProfileMenu: () => createElement("span") }))
mock.module(resolve(import.meta.dir, "../../../team-chat/TeamChatSidebarProvider"), () => ({ useTeamChatNav: () => chat }))
mock.module(resolve(import.meta.dir, "../../../../hooks/useAgentActivity"), () => ({
  useAgentActivity: () => ({ tasks: [] }),
}))

const { WideSidebar } = await import("../WideSidebar")

const TEAM_TABS = ["home", "channels", "dms", "agents", "projects", "activity", "more"] as const
const PERSONAL_TABS = ["home", "meetings", "goals", "activity", "more"] as const

function renderSidebar(overrides: Record<string, unknown> = {}) {
  return render(
    <WideSidebar
      workspaceId="w1"
      tabs={[...TEAM_TABS]}
      kind="team"
      showAdmin={false}
      renderPanel={(tab, hide) => (
        <div data-testid="panel">
          {tab}
          <button onClick={hide}>hide</button>
        </div>
      )}
      {...(overrides as any)}
    />,
  )
}

beforeEach(() => {
  cleanup()
  push.mockClear()
  pathname = "/(app)"
  chat = { enabled: true, list: [], counts: { channels: 0, dms: 0, inbox: 0 } }
})

describe("WideSidebar", () => {
  test("shows a rail tab per workspace tab and starts on Home", () => {
    renderSidebar()
    for (const label of ["Home", "Channels", "DMs", "Agents", "Projects", "Activity", "More"]) {
      expect(screen.getByRole("tab", { name: label })).toBeTruthy()
    }
    expect(screen.getByTestId("panel").textContent).toContain("home")
  })

  test("selecting a panel tab swaps the panel without leaving the page", () => {
    renderSidebar()
    fireEvent.click(screen.getByRole("tab", { name: "Channels" }))
    expect(screen.getByTestId("panel").textContent).toContain("channels")
    expect(screen.getByRole("tab", { name: "Channels" }).getAttribute("aria-selected")).toBe("true")
    expect(push).not.toHaveBeenCalled()
  })

  test("selecting the active tab again hides, then restores, the panel", () => {
    renderSidebar()
    fireEvent.click(screen.getByRole("tab", { name: "Home" }))
    expect(screen.queryByTestId("panel")).toBeNull()
    fireEvent.click(screen.getByRole("tab", { name: "Home" }))
    expect(screen.getByTestId("panel")).toBeTruthy()
  })

  test("the panel's own hide button collapses it to the rail", () => {
    renderSidebar()
    fireEvent.click(screen.getByText("hide"))
    expect(screen.queryByTestId("panel")).toBeNull()
    expect(screen.getByRole("tab", { name: "Home" })).toBeTruthy()
  })

  test("badges channels, DMs and activity from live counts", () => {
    chat.counts = { channels: 3, dms: 120, inbox: 2 }
    renderSidebar()
    expect(screen.getByRole("tab", { name: "Channels, 3 unread" })).toBeTruthy()
    expect(screen.getByRole("tab", { name: "DMs, 120 unread" })).toBeTruthy()
    expect(screen.getByRole("tab", { name: "Activity, 2 unread" })).toBeTruthy()
    expect(screen.getByText("99+")).toBeTruthy()
  })

  test("follows the route: opening a channel selects Channels", () => {
    chat.list = [{ id: "c1", kind: "channel" }]
    pathname = "/(app)/c/c1"
    renderSidebar()
    expect(screen.getByTestId("panel").textContent).toContain("channels")
  })

  test("team chat tabs disappear while team chat is off", () => {
    chat = { ...chat, enabled: false }
    renderSidebar()
    expect(screen.queryByRole("tab", { name: "Channels" })).toBeNull()
    expect(screen.queryByRole("tab", { name: "DMs" })).toBeNull()
    expect(screen.queryByRole("tab", { name: "Agents" })).toBeNull()
    expect(screen.getByRole("tab", { name: "Projects" })).toBeTruthy()
  })

  test("personal workspaces get their own tab set; Activity routes to its page", () => {
    chat = { enabled: false, list: [], counts: { channels: 0, dms: 0, inbox: 0 } }
    renderSidebar({ tabs: [...PERSONAL_TABS], kind: "personal" })
    expect(screen.queryByRole("tab", { name: "Channels" })).toBeNull()
    expect(screen.getByRole("tab", { name: "Meetings" })).toBeTruthy()
    fireEvent.click(screen.getByRole("tab", { name: "Activity" }))
    expect(push).toHaveBeenCalledWith("/(app)/activity")
    fireEvent.click(screen.getByRole("tab", { name: "Meetings" }))
    expect(push).toHaveBeenCalledWith("/(app)/meetings")
  })
})
