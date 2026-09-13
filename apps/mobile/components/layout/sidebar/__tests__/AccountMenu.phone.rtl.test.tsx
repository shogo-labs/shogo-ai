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
    Mail: Icon("Mail"),
    Monitor: Icon("Monitor"),
    Moon: Icon("Moon"),
    Paintbrush: Icon("Paintbrush"),
    Plus: Icon("Plus"),
    Plug: Icon("Plug"),
    Boxes: Icon("Boxes"),
    Building2: Icon("Building2"),
    BarChart3: Icon("BarChart3"),
    Bug: Icon("Bug"),
    Coins: Icon("Coins"),
    CreditCard: Icon("CreditCard"),
    Settings: Icon("Settings"),
    Server: Icon("Server"),
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
  useIsNativePhoneLayout: () => true,
}))
mock.module(resolve(import.meta.dir, "../../../../lib/billing-config"), () => ({
  getPlanDisplayName: () => "Free",
}))
mock.module(resolve(import.meta.dir, "../../../../lib/analytics"), () => ({
  EVENTS: { UPGRADE_CLICKED: "u" },
  trackEvent: () => {},
}))
mock.module(resolve(import.meta.dir, "../../../billing/UsageWindows"), () => ({
  CompactUsageWindows: () => null,
}))

const { AccountMenu, AccountMenuBody, ACCOUNT_SCREEN_HREF } = await import("../AccountMenu")

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

const bodyProps = {
  ...props,
  onNavigate: () => {},
  onClose: () => {},
  localMode: false,
}

describe("AccountMenuBody native grouping", () => {
  test("groups native settings into ChatGPT-style sections", () => {
    render(
      <AccountMenuBody
        {...bodyProps}
        user={{ name: "Ashutosh", email: "ashutosh@getodin.ai" }}
        isNative
        isSuperAdmin
        showBilling
      />,
    )

    expect(screen.getByText("Settings")).toBeTruthy()
    expect(screen.getByText("Plan")).toBeTruthy()
    expect(screen.getByText("Account")).toBeTruthy()
    expect(screen.getByText("Workspaces")).toBeTruthy()
    expect(screen.getByText("Theme")).toBeTruthy()
    expect(screen.getByText("Resources")).toBeTruthy()
    expect(screen.getByText("More")).toBeTruthy()
    expect(screen.getByText("Email")).toBeTruthy()
    expect(screen.getByLabelText("Workspace")).toBeTruthy()
    expect(screen.getByLabelText("People")).toBeTruthy()
    expect(screen.getByLabelText("Models")).toBeTruthy()
    expect(screen.getByLabelText("Integrations")).toBeTruthy()
    expect(screen.getByLabelText("Remote Control")).toBeTruthy()
    expect(screen.getByLabelText("Billing")).toBeTruthy()
    expect(screen.getByLabelText("Usage")).toBeTruthy()
    expect(screen.getByLabelText("Cost Optimizer")).toBeTruthy()
    expect(screen.getByLabelText("Profile")).toBeTruthy()
    expect(screen.getByLabelText("API Keys")).toBeTruthy()
    expect(screen.getByLabelText("Appearance")).toBeTruthy()
    expect(screen.getByLabelText("Docs")).toBeTruthy()
    expect(screen.getByLabelText("What's New")).toBeTruthy()
    expect(screen.getByLabelText("Sign out")).toBeTruthy()
    expect(screen.queryByText("All workspaces")).toBeNull()
  })

  test("native Settings rows open sheets instead of the Settings page", () => {
    const onNavigate = mock(() => {})
    const onOpenNativeSettingsTab = mock(() => {})
    render(
      <AccountMenuBody
        {...bodyProps}
        showBilling
        onNavigate={onNavigate}
        onOpenNativeSettingsTab={onOpenNativeSettingsTab}
        isNative
      />,
    )

    fireEvent.click(screen.getByLabelText("Workspace"))
    fireEvent.click(screen.getByLabelText("People"))
    fireEvent.click(screen.getByLabelText("Remote Control"))
    fireEvent.click(screen.getByLabelText("Billing"))
    fireEvent.click(screen.getByLabelText("Appearance"))
    fireEvent.click(screen.getByLabelText("Profile"))
    expect(onOpenNativeSettingsTab).toHaveBeenCalledWith("workspace")
    expect(onOpenNativeSettingsTab).toHaveBeenCalledWith("people")
    expect(onOpenNativeSettingsTab).toHaveBeenCalledWith("remote-control")
    expect(onOpenNativeSettingsTab).toHaveBeenCalledWith("billing")
    expect(onOpenNativeSettingsTab).toHaveBeenCalledWith("appearance")
    expect(onOpenNativeSettingsTab).toHaveBeenCalledWith("account")
    expect(onNavigate).not.toHaveBeenCalled()
  })

  test("wide web popover stays a flat ungrouped menu", () => {
    render(<AccountMenuBody {...bodyProps} isNative={false} />)

    expect(screen.getByText("All workspaces")).toBeTruthy()
    expect(screen.queryByText("Workspace")).toBeNull()
    expect(screen.queryByText("Theme")).toBeNull()
    expect(screen.queryByText("Resources")).toBeNull()
    expect(screen.getByLabelText("Profile")).toBeTruthy()
    expect(screen.getByText("Settings")).toBeTruthy()
    expect(screen.getByText("Invite")).toBeTruthy()
  })
})
