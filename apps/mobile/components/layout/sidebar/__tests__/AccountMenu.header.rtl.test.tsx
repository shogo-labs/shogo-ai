// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-130 AC 1: the bold workspace name in the wide panel header has to follow
 * the workspace *in view*, not the cloud workspace. With a machine workspace
 * open, `currentWorkspace` is still the cloud workspace (identity, billing and
 * membership are the cloud account's), so the header read "Local User Personal"
 * above a machine's projects — the one surface the request-level path rewrite
 * cannot fix, because it is rendered rather than requested.
 */
import { resolve } from "node:path"
import { describe, expect, mock, test } from "bun:test"
import { render, screen } from "@testing-library/react"
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

// The header button's `trigger` render prop is the thing under test, so this
// Popover renders it (the phone spec's stub returns null).
mock.module("@/components/ui/popover", () => ({
  Popover: ({ trigger }: { trigger: (props: object) => unknown }) =>
    createElement("div", null, trigger({})),
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
  isPhoneLayout: () => false,
  usePhoneLayout: () => false,
  useIsNativePhoneLayout: () => false,
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

const { WorkspaceHeaderButton } = await import("../AccountMenu")
const { buildWorkspaceEntries, cloudWorkspaceKey } = await import("../../../../lib/workspace-entries")

const cloudWorkspace = { id: "w1", name: "Local User Personal" }
const machineWorkspace = { id: "machine-team", name: "Studio Mac Team" }

const props = {
  user: { name: "Russell" },
  onSignOut: () => {},
  onNavigate: () => {},
  isSuperAdmin: false,
  isWide: true,
  entries: buildWorkspaceEntries({ workspaces: [cloudWorkspace] }),
  currentKey: cloudWorkspaceKey("w1"),
  onSelectEntry: () => {},
  currentWorkspace: cloudWorkspace,
  billingData: {},
  workspacePlan: null as string | null,
  allPlans: {},
  showBilling: false,
  onSwitchWorkspace: () => {},
  onCreateWorkspace: () => {},
  localMode: false,
}

describe("WorkspaceHeaderButton names the workspace in view", () => {
  test("a machine workspace is open → the machine's workspace name", () => {
    render(<WorkspaceHeaderButton {...props} identityWorkspace={machineWorkspace} />)

    expect(screen.getByRole("button", { name: "Studio Mac Team, workspace menu" })).toBeTruthy()
    expect(screen.getByText("Studio Mac Team")).toBeTruthy()
    expect(screen.queryByText("Local User Personal")).toBeNull()
  })

  test("no machine workspace → the cloud workspace", () => {
    render(<WorkspaceHeaderButton {...props} identityWorkspace={cloudWorkspace} />)

    expect(screen.getByRole("button", { name: "Local User Personal, workspace menu" })).toBeTruthy()
  })

  test("an older caller that passes no identity still names a workspace", () => {
    render(<WorkspaceHeaderButton {...props} />)

    expect(screen.getByRole("button", { name: "Local User Personal, workspace menu" })).toBeTruthy()
  })
})
