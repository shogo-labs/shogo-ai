// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-156 acceptance 1 — a new workspace sees **Social** in More.
 *
 * The link used to follow the number of connected accounts, so a workspace with
 * none (every new one) never saw the screen that lets it connect one. It now
 * follows the capability: a 200 from `/social/status` shows the row, anything
 * else hides it.
 */

import { resolve } from "node:path"
import { beforeEach, describe, expect, mock, test } from "bun:test"
import { cleanup, render, screen } from "@testing-library/react"
import { createElement } from "react"
import { createReactNativeMock } from "../../../../test/react-native-mock"

const push = mock((_href: string) => {})

/** What `/social/status` answers for this test; `null` means the request fails. */
let statusAnswer: unknown | null = { mode: "cloud", connected: false, accounts: 0 }

const http = {
  get: mock(async (path: string) => {
    if (path.includes("/social/status")) {
      if (statusAnswer === null) throw new Error("HTTP 403")
      return { data: statusAnswer }
    }
    if (path.includes("/social/accounts")) return { data: { accounts: [] } }
    throw new Error(`unexpected GET ${path}`)
  }),
}

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
  useWorkspaceExperience: () => ({ kind: "team", showMarketplace: true }),
}))
mock.module(resolve(import.meta.dir, "../../../../lib/platform-config"), () => ({
  usePlatformConfig: () => ({ features: { marketplace: true, workBoards: true } }),
  isLocalMode: () => false,
  isWorkspaceRuntimeEnabled: () => false,
  isProjectWorkspaceRuntimeEnabled: () => false,
}))
mock.module(resolve(import.meta.dir, "../../../../contexts/domain"), () => ({
  useDomainHttp: () => http,
}))
mock.module(resolve(import.meta.dir, "../../../../hooks/useActiveWorkspace"), () => ({
  useActiveWorkspace: () => ({ id: "ws-1" }),
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
  http.get.mockClear()
  statusAnswer = { mode: "cloud", connected: false, accounts: 0 }
})

describe("SHO-156 — Social in More", () => {
  test("a workspace with zero connected accounts still gets the Social row", async () => {
    render(<MorePanel variant="screen" />)

    const social = await screen.findByRole("link", { name: "Social" })
    expect(social.getAttribute("aria-label")).toBe("Social")

    // The gate is the capability, not the account count: the panel must ask the
    // status route and must not have kept the old accounts-based check.
    const paths = http.get.mock.calls.map((call) => String(call[0]))
    expect(paths.some((path) => path.endsWith("/social/status"))).toBe(true)
    expect(paths.some((path) => path.endsWith("/social/accounts"))).toBe(false)
  })

  test("Social opens the social screen", async () => {
    render(<MorePanel variant="screen" />)
    const social = await screen.findByRole("link", { name: "Social" })
    social.click()
    expect(push).toHaveBeenCalledWith("/(app)/social")
  })

  test("desktop answers `unavailable` — still a 200, so the row stays and the screen explains it", async () => {
    statusAnswer = { mode: "unavailable", configured: false, connected: false, accounts: 0 }
    render(<MorePanel />)
    expect(await screen.findByRole("link", { name: "Social" })).toBeTruthy()
  })

  test("when social management is off the status route fails, and no Social row appears", async () => {
    statusAnswer = null
    render(<MorePanel variant="screen" />)

    // Wait for the rejection to land before asserting the row is absent.
    await screen.findByRole("link", { name: "Analytics" })
    expect(screen.queryByRole("link", { name: "Social" })).toBeNull()
  })
})
