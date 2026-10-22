// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-108 QA — the wide-web account popover switches workspace like every other
 * switcher surface.
 *
 * The rail tile, the drawer, the account screen and the phone sheet each hand
 * `WorkspaceMenuSection` the shared entry list. The account popover renders the
 * same list through `AccountMenuBody`, which takes the switch callback under the
 * name `onSelectEntry` — so this spec drives the *real* `AccountMenu` (not the
 * body directly) and presses a row. A body rendered with the callback under a
 * different name looks identical on screen and throws the moment a person taps
 * a workspace, which is exactly what a unit test of the body cannot see.
 */

import { resolve } from "node:path"
import { beforeEach, describe, expect, mock, test } from "bun:test"
import { fireEvent, render, screen } from "@testing-library/react"
import { createElement } from "react"
import { createReactNativeMock } from "../../../../test/react-native-mock"

mock.module("react-native", () =>
  createReactNativeMock({
    Platform: { OS: "web" },
    Pressable: ({ accessibilityLabel, testID, children, onPress, ...props }: any) =>
      createElement(
        "button",
        {
          ...props,
          "aria-label": accessibilityLabel,
          "data-rn-shim": testID,
          "data-selected": props["aria-selected"] ? "true" : undefined,
          onClick: onPress,
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
  const Icon = (name: string) => () => createElement("span", { "data-icon": name })
  return Object.fromEntries(
    [
      "Check",
      "ChevronDown",
      "ChevronRight",
      "Cloud",
      "CloudOff",
      "ExternalLink",
      "LogIn",
      "LogOut",
      "Plus",
      "Sparkles",
      "Users",
      "Zap",
      "Key",
      "Laptop",
      "Mail",
      "MessageSquare",
      "Monitor",
      "Moon",
      "Paintbrush",
      "Plug",
      "RefreshCcw",
      "RefreshCw",
      "Boxes",
      "Building2",
      "BarChart3",
      "Bug",
      "Coins",
      "CreditCard",
      "Settings",
      "Server",
      "Shield",
      "Store",
      "Sun",
      "User",
    ].map((name) => [name, Icon(name)]),
  )
})

/** The popover renders its content inline so a test can reach the workspace list. */
mock.module("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: unknown }) => children,
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
  useDomainActions: () => ({ acceptInvitation: async () => ({}), declineInvitation: async () => ({}) }),
  useDomainActionsOptional: () => ({ acceptInvitation: async () => ({}), declineInvitation: async () => ({}) }),
  getDomainActionsInstance: () => null,
  useWorkspaceCollection: () => ({ all: [], loadAll: async () => {} }),
  useWorkspaceCollectionOptional: () => null,
}))
mock.module(resolve(import.meta.dir, "../../../../contexts/auth"), () => ({
  useAuth: () => ({ user: { id: "user-1", email: "user@example.com" } }),
  useAuthOptional: () => ({ user: { id: "user-1", email: "user@example.com" } }),
  getAuthUserSnapshot: () => ({ id: "user-1", email: "user@example.com" }),
}))
mock.module(resolve(import.meta.dir, "../../../../hooks/useCloudSession"), () => ({
  useCloudSession: () => ({
    cloud: { signedIn: false, cloudUrl: null, reachable: true, user: null, workspaces: [] },
    pending: null,
    error: null,
    signIn: async () => true,
    signOut: async () => true,
  }),
}))
mock.module(resolve(import.meta.dir, "../../../../lib/workspace-route"), () => ({
  routeUrl: (url: string) => url,
  routePath: (path: string) => path,
  isActiveWorkspaceCloud: () => false,
  installWorkspaceFetchRouter: () => {},
  refreshCloudWorkspaces: async () => ({ signedIn: false, cloudUrl: null, reachable: true, user: null, workspaces: [] }),
  setCloudWorkspacesState: () => {},
  getCloudWorkspacesState: () => ({ signedIn: false, cloudUrl: null, reachable: true, user: null, workspaces: [] }),
  subscribeCloudWorkspaces: () => () => {},
  _resetWorkspaceRouteForTests: () => {},
  useCloudWorkspaces: () => ({ signedIn: false, cloudUrl: null, reachable: true, user: null, workspaces: [] }),
  isCloudWorkspace: () => false,
}))
mock.module(resolve(import.meta.dir, "../../../../lib/platform-config"), () => ({
  isLocalMode: () => false,
  isWorkspaceRuntimeEnabled: () => false,
  isProjectWorkspaceRuntimeEnabled: () => false,
  invalidatePlatformConfigCache: () => {},
  usePlatformConfig: () => ({ localMode: false, shogoKeyConnected: false }),
}))
mock.module(resolve(import.meta.dir, "../../../../lib/native-phone-layout"), () => ({
  isNativePlatform: () => false,
  isPhoneLayout: () => false,
  usePhoneLayout: () => false,
  useIsNativePhoneLayout: () => false,
}))
mock.module(resolve(import.meta.dir, "../../../../lib/billing-config"), () => ({
  getPlanDisplayName: () => "Free",
}))
mock.module(resolve(import.meta.dir, "../../../../lib/analytics"), () => ({
  EVENTS: { UPGRADE_CLICKED: "u", WORKSPACE_SWITCHED: "w" },
  trackEvent: () => {},
}))
mock.module(resolve(import.meta.dir, "../../../../lib/api"), () => ({
  isInvitationExpired: () => false,
  api: { getReceivedInvitations: async () => [] },
}))
mock.module(resolve(import.meta.dir, "../../../billing/UsageWindows"), () => ({
  CompactUsageWindows: () => null,
}))

const { AccountMenu } = await import("../AccountMenu")
const { buildWorkspaceEntries, machineWorkspaceKey } = await import("../../../../lib/workspace-entries")

const odin = {
  id: "inst-odin",
  name: "odin",
  status: "online" as const,
  stale: false,
  lastSeenAt: "2026-10-21T05:00:00.000Z",
  workspaces: [{ id: "lw-main", name: "Samsara", kind: "team" }],
}

const entries = buildWorkspaceEntries({
  workspaces: [{ id: "ws-acme", name: "Acme", kind: "team" }],
  machines: [odin],
})

const picked: string[] = []

function props(overrides: Record<string, unknown> = {}) {
  return {
    user: { name: "Russell" },
    onSignOut: () => {},
    isSuperAdmin: false,
    entries,
    currentKey: machineWorkspaceKey("inst-odin", "lw-main"),
    onSelectEntry: (entry: any) => picked.push(entry.key),
    currentWorkspace: { id: "ws-acme", name: "Acme" },
    billingData: {},
    workspacePlan: null,
    allPlans: {},
    showBilling: false,
    onSwitchWorkspace: () => {},
    onCreateWorkspace: () => {},
    onNavigate: () => {},
    ...overrides,
  }
}

beforeEach(() => {
  picked.length = 0
})

describe("SHO-108 QA — the account popover switches like the rest of the switcher", () => {
  test("both rows are listed in the popover, machine row included", () => {
    const { container } = render(<AccountMenu {...(props() as any)} tile={false} isWide />)

    expect(container.querySelector('[data-rn-shim="workspace-row:cloud:ws-acme"]')).toBeTruthy()
    expect(container.querySelector('[data-rn-shim="workspace-row:machine:inst-odin:lw-main"]')).toBeTruthy()
    expect(
      container.querySelector('[data-rn-shim="workspace-row:machine:inst-odin:lw-main"]')?.getAttribute("data-selected"),
    ).toBe("true")
    expect(
      container.querySelector('[data-rn-shim="workspace-row:cloud:ws-acme"]')?.getAttribute("data-selected"),
    ).toBeNull()
  })

  test("pressing the machine row opens that machine's workspace", () => {
    const { container } = render(<AccountMenu {...(props() as any)} tile={false} isWide />)
    const row = container.querySelector('[data-rn-shim="workspace-row:machine:inst-odin:lw-main"]')!

    // Throws "onSelect is not a function" when the popover body is handed the
    // callback under the wrong prop name.
    fireEvent.click(row)

    expect(picked).toEqual([machineWorkspaceKey("inst-odin", "lw-main")])
  })

  test("pressing the cloud row switches back to it", () => {
    const { container } = render(<AccountMenu {...(props() as any)} tile={false} isWide />)
    fireEvent.click(container.querySelector('[data-rn-shim="workspace-row:cloud:ws-acme"]')!)

    expect(picked).toEqual(["cloud:ws-acme"])
  })
})
