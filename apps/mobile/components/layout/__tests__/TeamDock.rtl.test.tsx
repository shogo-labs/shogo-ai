// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { resolve } from "node:path"
import { beforeEach, describe, expect, mock, test } from "bun:test"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { createElement } from "react"
import { createReactNativeMock } from "../../../test/react-native-mock"

const replace = mock((_href: string) => {})
const push = mock((_href: string) => {})
let pathname = "/(app)"
let chat: any
let tasks: any[] = []

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
mock.module("expo-router", () => ({ usePathname: () => pathname, useRouter: () => ({ replace, push }) }))
mock.module("@shogo/shared-ui/primitives", () => ({ cn: (...args: unknown[]) => args.filter(Boolean).join(" ") }))
mock.module("lucide-react-native", () => {
  const Icon = () => createElement("span")
  return { Bell: Icon, Home: Icon, MessagesSquare: Icon, MoreHorizontal: Icon, Search: Icon, Bot: Icon, Folder: Icon, Hash: Icon, Mic: Icon, Plus: Icon, Settings: Icon, Target: Icon }
})
mock.module(resolve(import.meta.dir, "../../../contexts/theme"), () => ({ useResolvedTheme: () => "light" }))
mock.module(resolve(import.meta.dir, "../../ui/LiquidGlassBackdrop"), () => ({ LiquidGlassBackdrop: () => null, supportsLiquidGlass: () => false }))
mock.module(resolve(import.meta.dir, "../../branding/ShogoLogoMark"), () => ({ ShogoLogoMark: () => null }))
mock.module(resolve(import.meta.dir, "../CreateMenu"), () => ({ CreateMenu: () => null }))
mock.module(resolve(import.meta.dir, "../ProfileMenu"), () => ({ ProfileMenu: () => null }))
mock.module(resolve(import.meta.dir, "../../team-chat/TeamChatSidebarProvider"), () => ({ useTeamChatNav: () => chat }))
mock.module(resolve(import.meta.dir, "../../../hooks/useAgentActivity"), () => ({ useAgentActivity: () => ({ tasks }) }))

const { TeamDock } = await import("../TeamDock")

beforeEach(() => {
  cleanup()
  replace.mockClear()
  push.mockClear()
  pathname = "/(app)"
  tasks = []
  chat = { enabled: true, list: [], counts: { channels: 0, dms: 0, inbox: 0 } }
})

describe("TeamDock", () => {
  test("shows Home, DMs, Activity and More, with Home selected on Home", () => {
    render(<TeamDock maxWidth={640} />)
    for (const name of ["Home", "DMs", "Activity", "More"]) expect(screen.getByRole("tab", { name })).toBeTruthy()
    expect(screen.getByRole("tab", { name: "Home" }).getAttribute("aria-selected")).toBe("true")
    expect(screen.getByRole("tab", { name: "DMs" }).getAttribute("aria-selected")).not.toBe("true")
  })

  test("tabs navigate to their screens", () => {
    render(<TeamDock maxWidth={640} />)
    fireEvent.click(screen.getByRole("tab", { name: "DMs" }))
    fireEvent.click(screen.getByRole("tab", { name: "Activity" }))
    fireEvent.click(screen.getByRole("tab", { name: "More" }))
    expect(replace.mock.calls.map((c) => c[0])).toEqual(["/(app)/c/dms", "/(app)/activity", "/(app)/more"])
  })

  test("the search button is separate from the tabs and opens search", () => {
    render(<TeamDock maxWidth={640} />)
    expect(screen.queryByRole("tab", { name: "Search" })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Search" }))
    expect(push).toHaveBeenCalledWith("/(app)/search")
  })

  test("a DM conversation highlights DMs; a channel stays under Home", () => {
    chat.list = [{ id: "dm1", kind: "dm" }, { id: "ch1", kind: "public" }]
    pathname = "/(app)/c/dm1"
    const view = render(<TeamDock maxWidth={640} />)
    expect(screen.getByRole("tab", { name: "DMs" }).getAttribute("aria-selected")).toBe("true")
    view.unmount()
    pathname = "/(app)/c/ch1"
    render(<TeamDock maxWidth={640} />)
    expect(screen.getByRole("tab", { name: "Home" }).getAttribute("aria-selected")).toBe("true")
  })

  test("badges DMs and Activity from live counts", () => {
    chat.counts = { channels: 0, dms: 4, inbox: 2 }
    render(<TeamDock maxWidth={640} />)
    expect(screen.getByRole("tab", { name: "DMs, 4 unread" })).toBeTruthy()
    expect(screen.getByRole("tab", { name: "Activity, 2 unread" })).toBeTruthy()
  })
})
