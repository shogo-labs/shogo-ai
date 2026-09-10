// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { resolve } from "node:path"
import { describe, expect, mock, test } from "bun:test"
import { fireEvent, render, screen } from "@testing-library/react"
import { createElement } from "react"
import { createReactNativeMock } from "../../../../test/react-native-mock"

mock.module("react-native", () =>
  createReactNativeMock({
    Platform: { OS: "ios" },
    Pressable: ({ accessibilityLabel, accessibilityRole, children, onPress, ...props }: any) =>
      createElement(
        "button",
        {
          ...props,
          "aria-label": accessibilityLabel,
          onClick: onPress,
          role: accessibilityRole,
        },
        children,
      ),
  }),
)

mock.module("@shogo/shared-ui/primitives", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
  Avatar: () => null,
}))

mock.module("lucide-react-native", () => {
  const Icon = (name: string) =>
    function LucideIcon() {
      return createElement("span", { "data-icon": name })
    }
  return {
    Check: Icon("Check"),
    ChevronDown: Icon("ChevronDown"),
    ChevronRight: Icon("ChevronRight"),
    ExternalLink: Icon("ExternalLink"),
    Key: Icon("Key"),
    LogOut: Icon("LogOut"),
    Monitor: Icon("Monitor"),
    Moon: Icon("Moon"),
    Plus: Icon("Plus"),
    Settings: Icon("Settings"),
    Shield: Icon("Shield"),
    Sparkles: Icon("Sparkles"),
    Store: Icon("Store"),
    Sun: Icon("Sun"),
    User: Icon("User"),
    Users: Icon("Users"),
    Zap: Icon("Zap"),
  }
})

mock.module("@/components/ui/popover", () => ({
  Popover: () => null,
  PopoverBackdrop: () => null,
  PopoverBody: ({ children }: { children: unknown }) => children,
  PopoverContent: ({ children }: { children: unknown }) => children,
}))

mock.module(resolve(import.meta.dir, "../../../../contexts/posthog"), () => ({
  usePostHogSafe: () => null,
}))
mock.module(resolve(import.meta.dir, "../../../../contexts/theme"), () => ({
  useTheme: () => ({ theme: "dark", setTheme: () => {} }),
}))
mock.module(resolve(import.meta.dir, "../../../../lib/platform-config"), () => ({
  usePlatformConfig: () => ({ localMode: false, shogoKeyConnected: false }),
}))
mock.module(resolve(import.meta.dir, "../../../../lib/native-phone-layout"), () => ({
  isNativePlatform: () => true,
}))
mock.module(resolve(import.meta.dir, "../../../../lib/billing-config"), () => ({
  getPlanDisplayName: () => "Free",
}))
mock.module(resolve(import.meta.dir, "../../../../lib/analytics"), () => ({
  EVENTS: { UPGRADE_CLICKED: "u" },
  trackEvent: () => {},
}))
mock.module(resolve(import.meta.dir, "../../../../lib/phone-density"), () => ({
  densityFor: () => ({
    icon: { xs: 14, sm: 16, md: 18, lg: 20, nav: 18 },
    text: { caption: "text-xs", label: "text-sm", body: "text-base", title: "text-lg", heading: "text-xl" },
    hit: "h-11 w-11",
    rowPad: "px-4 py-3.5",
    rowMin: "min-h-11",
  }),
}))
mock.module(resolve(import.meta.dir, "../../../billing/UsageWindows"), () => ({
  CompactUsageWindows: () => null,
}))

const { AccountMenu, ACCOUNT_SCREEN_HREF } = await import("../AccountMenu")

const props = {
  user: { name: "Ashutosh" },
  onSignOut: () => {},
  isSuperAdmin: false,
  workspaces: [{ id: "w1", name: "Ashutosh Personal" }],
  currentWorkspace: { id: "w1", name: "Ashutosh Personal" },
  billingData: {},
  workspacePlan: null,
  allPlans: {},
  showBilling: false,
  onSwitchWorkspace: () => {},
  onCreateWorkspace: () => {},
}

describe("AccountMenu phone chrome", () => {
  test("opens a full account screen instead of a sheet", () => {
    const onNavigate = mock(() => {})
    render(<AccountMenu {...props} isWide={false} onNavigate={onNavigate} />)

    fireEvent.click(screen.getByRole("button", { name: /open account$/ }))
    expect(onNavigate).toHaveBeenCalledWith(ACCOUNT_SCREEN_HREF)
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull()
  })

  test("native ignores isWide and still opens the account screen", () => {
    const onNavigate = mock(() => {})
    render(<AccountMenu {...props} isWide={true} onNavigate={onNavigate} />)

    fireEvent.click(screen.getByRole("button", { name: /open account$/ }))
    expect(onNavigate).toHaveBeenCalledWith(ACCOUNT_SCREEN_HREF)
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull()
  })
})
