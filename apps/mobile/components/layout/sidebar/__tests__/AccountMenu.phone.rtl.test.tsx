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
    Cloud: Icon("Cloud"),
    CloudOff: Icon("CloudOff"),
    ExternalLink: Icon("ExternalLink"),
    Key: Icon("Key"),
    Laptop: Icon("Laptop"),
    LogIn: Icon("LogIn"),
    LogOut: Icon("LogOut"),
    Mail: Icon("Mail"),
    MessageSquare: Icon("MessageSquare"),
    Monitor: Icon("Monitor"),
    Moon: Icon("Moon"),
    Paintbrush: Icon("Paintbrush"),
    Plus: Icon("Plus"),
    Plug: Icon("Plug"),
    RefreshCcw: Icon("RefreshCcw"),
    RefreshCw: Icon("RefreshCw"),
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
mock.module(resolve(import.meta.dir, "../../../../contexts/domain"), () => ({
  useDomainHttpOptional: () => null,
  getDomainHttpClient: () => null,
  useDomainOptional: () => null,
  getDomainStore: () => null,
  useDomainActions: () => ({
    acceptInvitation: async () => ({}),
    declineInvitation: async () => ({}),
  }),
  useDomainActionsOptional: () => ({
    acceptInvitation: async () => ({}),
    declineInvitation: async () => ({}),
  }),
  getDomainActionsInstance: () => null,
  useWorkspaceCollection: () => ({ all: [], loadAll: async () => {} }),
  useWorkspaceCollectionOptional: () => null,
}))
mock.module(resolve(import.meta.dir, "../../../../contexts/auth"), () => ({
  useAuth: () => ({ user: { id: "user-1", email: "user@example.com" } }),
  useAuthOptional: () => ({ user: { id: "user-1", email: "user@example.com" } }),
  getAuthUserSnapshot: () => ({ id: "user-1", email: "user@example.com" }),
}))
mock.module(resolve(import.meta.dir, "../../../../lib/platform-config"), () => ({
  isLocalMode: () => false,
  isWorkspaceRuntimeEnabled: () => false,
  isProjectWorkspaceRuntimeEnabled: () => false,
  invalidatePlatformConfigCache: () => {},
  usePlatformConfig: () => ({ localMode: false, shogoKeyConnected: false }),
}))
mock.module(resolve(import.meta.dir, "../../../../lib/native-phone-layout"), () => ({
  isNativePlatform: () => true,
  isPhoneLayout: () => true,
  usePhoneLayout: () => true,
  useIsNativePhoneLayout: () => true,
}))
mock.module(resolve(import.meta.dir, "../../../../lib/billing-config"), () => ({
  getPlanDisplayName: () => "Free",
}))
mock.module(resolve(import.meta.dir, "../../../../lib/analytics"), () => ({
  EVENTS: { UPGRADE_CLICKED: "u" },
  trackEvent: () => {},
}))
mock.module(resolve(import.meta.dir, "../../../../lib/api"), () => ({
  isInvitationExpired: () => false,
  api: { getReceivedInvitations: async () => [] },
}))
mock.module(resolve(import.meta.dir, "../../../billing/UsageWindows"), () => ({
  CompactUsageWindows: () => null,
}))

const { AccountMenu, AccountMenuBody, ACCOUNT_SCREEN_HREF } = await import("../AccountMenu")
const { buildWorkspaceEntries, cloudWorkspaceKey } = await import("../../../../lib/workspace-entries")

const props = {
  user: { name: "Ashutosh" },
  onSignOut: () => {},
  isSuperAdmin: false,
  // One list of entries (SHO-108): a cloud workspace here, no paired machine.
  entries: buildWorkspaceEntries({ workspaces: [{ id: "w1", name: "Ashutosh Personal", kind: "personal" }] }),
  currentKey: cloudWorkspaceKey("w1"),
  onSelectEntry: () => {},
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
    // Usage and Cost Optimizer moved to the Analytics screen (More tab).
    expect(screen.queryByLabelText("Usage")).toBeNull()
    expect(screen.queryByLabelText("Cost Optimizer")).toBeNull()
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
    // Profile, appearance, and sign out live on the rail avatar menu.
    expect(screen.queryByLabelText("Profile")).toBeNull()
    expect(screen.queryByLabelText("Sign out")).toBeNull()
    expect(screen.getByText("Settings")).toBeTruthy()
    expect(screen.getByText("Invite")).toBeTruthy()
  })
})

describe("AccountMenuBody free personal-space CTA", () => {
  // Targets users whose original signup workspace was mis-backfilled to
  // `kind: 'team'` — they have a workspace, but not a personal one, so the
  // generic `hasPersonalWorkspace={false}` CTA must still show.
  test("shows the free CTA when the user has no personal workspace", () => {
    const onCreatePersonalWorkspace = mock(() => {})
    render(
      <AccountMenuBody
        {...bodyProps}
        isNative={false}
        hasPersonalWorkspace={false}
        onCreatePersonalWorkspace={onCreatePersonalWorkspace}
      />,
    )

    expect(screen.getByText("Create personal space")).toBeTruthy()
    expect(screen.getByText("Free")).toBeTruthy()

    fireEvent.click(screen.getByText("Create personal space"))
    expect(onCreatePersonalWorkspace).toHaveBeenCalledTimes(1)
  })

  test("hides the CTA once the user already has a personal workspace", () => {
    render(
      <AccountMenuBody
        {...bodyProps}
        isNative={false}
        hasPersonalWorkspace
        onCreatePersonalWorkspace={() => {}}
      />,
    )

    expect(screen.queryByText("Create personal space")).toBeNull()
  })

  test("hides the CTA when hasPersonalWorkspace is omitted (unknown/loading)", () => {
    render(<AccountMenuBody {...bodyProps} isNative={false} />)

    expect(screen.queryByText("Create personal space")).toBeNull()
  })
})
