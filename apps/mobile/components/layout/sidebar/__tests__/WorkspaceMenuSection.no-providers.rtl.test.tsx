// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-84 regression — the switcher must render with **no providers above it**.
 *
 * The rail/account popover goes through Gluestack's portal host, which is
 * mounted at `GluestackUIProvider` — *above* `AuthProvider` and
 * `SDKDomainProvider`. So the invites block is rendered exactly where a
 * context read throws, and `useAuth()` in it took local-mode boot down with
 * `useAuth must be used within AuthProvider` (RootErrorBoundary replaced the
 * whole shell; CI run 39413566709, `E2E (local mode) 3/3`).
 *
 * The mocks below reproduce that surface faithfully: the *throwing* accessors
 * still throw (so calling one fails this test), while the optional accessors
 * and the providers' module singletons answer — which is how the block is
 * supposed to work inside a portal.
 */

import { resolve } from "node:path"
import { beforeEach, describe, expect, mock, test } from "bun:test"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { createElement } from "react"
import { createReactNativeMock } from "../../../../test/react-native-mock"

mock.module("react-native", () =>
  createReactNativeMock({
    Platform: { OS: "web" },
    Pressable: ({ accessibilityLabel, children, onPress, disabled, ...props }: any) =>
      createElement("button", { ...props, "aria-label": accessibilityLabel, onClick: onPress, disabled }, children),
    ActivityIndicator: () => createElement("span", { "data-activity": "" }),
  }),
)

mock.module("@shogo/shared-ui/primitives", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}))

mock.module("lucide-react-native", () => {
  const Icon = (name: string) => function LucideIcon() {
    return createElement("span", { "data-icon": name })
  }
  return Object.fromEntries(
    [
      "Check",
      "ChevronDown",
      "ChevronRight",
      "ChevronUp",
      "Cloud",
      "CloudOff",
      "ExternalLink",
      "LogIn",
      "LogOut",
      "Plus",
      "Settings",
      "Sparkles",
      "Users",
      "Zap",
    ].map((n) => [n, Icon(n)]),
  )
})

mock.module(resolve(import.meta.dir, "../../../../contexts/posthog"), () => ({ usePostHogSafe: () => null }))

// No provider in this tree: the context hooks throw, exactly as they do in the
// portal. The singleton accessors stand in for the provider mounted elsewhere.
let snapshotUser: any = { id: "user-invitee", email: "invitee@example.com" }
mock.module(resolve(import.meta.dir, "../../../../contexts/auth"), () => ({
  useAuth: () => {
    throw new Error("useAuth must be used within AuthProvider")
  },
  useAuthOptional: () => null,
  getAuthUserSnapshot: () => snapshotUser,
}))

const acceptInvitation = mock(async () => ({}))
const declineInvitation = mock(async () => ({}))
const loadAllWorkspaces = mock(async () => {})
const http = { get: async () => ({ data: { items: [] } }) }
const store = { workspaceCollection: { all: [], loadAll: loadAllWorkspaces } }
const actions = { acceptInvitation, declineInvitation }

mock.module(resolve(import.meta.dir, "../../../../contexts/domain"), () => ({
  useDomainHttpOptional: () => null,
  getDomainHttpClient: () => http,
  useDomain: () => {
    throw new Error("useSDKDomain must be used within SDKDomainProvider")
  },
  useDomainOptional: () => null,
  getDomainStore: () => store,
  useDomainActions: () => {
    throw new Error("useSDKDomain must be used within SDKDomainProvider")
  },
  useDomainActionsOptional: () => null,
  getDomainActionsInstance: () => actions,
  useWorkspaceCollection: () => {
    throw new Error("useSDKDomain must be used within SDKDomainProvider")
  },
  useWorkspaceCollectionOptional: () => null,
}))

let invitations: any[] = []
mock.module(resolve(import.meta.dir, "../../../../lib/api"), () => ({
  isInvitationExpired: (invitation: { status?: string; expiresAt?: string | number | Date | null }) => {
    if (invitation.status === "expired") return true
    if (!invitation.expiresAt) return false
    const at = new Date(invitation.expiresAt).getTime()
    return Number.isFinite(at) && at <= Date.now()
  },
  api: { getReceivedInvitations: async () => invitations },
}))

mock.module(resolve(import.meta.dir, "../../../../lib/billing-config"), () => ({ getPlanDisplayName: () => "Free" }))
mock.module(resolve(import.meta.dir, "../../../../lib/analytics"), () => ({ EVENTS: {}, trackEvent: () => {} }))
mock.module(resolve(import.meta.dir, "../../../billing/UsageWindows"), () => ({ CompactUsageWindows: () => null }))
mock.module(resolve(import.meta.dir, "../../../../hooks/useCloudSession"), () => ({
  useCloudSession: () => ({
    cloud: { signedIn: false, cloudUrl: null, reachable: true, user: null },
    pending: null,
    error: null,
    signIn: async () => {},
    signOut: async () => {},
  }),
}))
mock.module(resolve(import.meta.dir, "../../../../lib/workspace-route"), () => ({
  isCloudWorkspace: () => false,
  useCloudWorkspaces: () => ({ signedIn: false, cloudUrl: null, reachable: true, user: null, workspaces: [] }),
}))

const { WorkspaceMenuSection } = await import("../WorkspaceMenuSection")
const { buildWorkspaceEntries, cloudWorkspaceKey } = await import("../../../../lib/workspace-entries")

const WORKSPACES = [{ id: "ws-current", name: "Acme", kind: "team" }]
const onSwitchWorkspace = mock((_id: string) => {})
const onClose = mock(() => {})

function renderSection(props: Record<string, unknown> = {}) {
  return render(
    <WorkspaceMenuSection
      entries={buildWorkspaceEntries({ workspaces: WORKSPACES })}
      currentKey={cloudWorkspaceKey(WORKSPACES[0].id)}
      onSelect={(entry: any) => onSwitchWorkspace(entry.id)}
      currentWorkspace={WORKSPACES[0]}
      billingData={{ hasActiveSubscription: false }}
      workspacePlan={null}
      allPlans={{}}
      showBilling={false}
      onNavigate={() => {}}
      onSwitchWorkspace={onSwitchWorkspace}
      onCreateWorkspace={() => {}}
      onClose={onClose}
      {...props}
    />,
  )
}

const PENDING = [
  { id: "inv-1", workspaceId: "ws-joined", role: "admin", projectId: null, status: "pending", workspace: { name: "Gamma" } },
]

beforeEach(() => {
  cleanup()
  acceptInvitation.mockClear()
  declineInvitation.mockClear()
  loadAllWorkspaces.mockClear()
  onSwitchWorkspace.mockClear()
  onClose.mockClear()
  invitations = []
  snapshotUser = { id: "user-invitee", email: "invitee@example.com" }
})

describe("SHO-84 regression — no AuthProvider/SDKDomainProvider above the section", () => {
  test("the portal switcher renders instead of throwing", async () => {
    invitations = PENDING
    expect(() => renderSection({ presentation: "switcher" })).not.toThrow()
  })

  test("the invites block still works through the providers' singletons", async () => {
    invitations = PENDING
    renderSection({ presentation: "switcher" })

    expect(await screen.findByText("Pending invitations")).toBeTruthy()
    fireEvent.click(await screen.findByLabelText("Accept invitation to Gamma"))

    await waitFor(() => expect(acceptInvitation).toHaveBeenCalledTimes(1))
    expect(loadAllWorkspaces).toHaveBeenCalled()
    expect(onSwitchWorkspace).toHaveBeenCalledWith("ws-joined")
    expect(onClose).toHaveBeenCalled()
  })

  test("with no snapshot yet it renders quietly, without invitations", async () => {
    snapshotUser = null
    invitations = PENDING
    expect(() =>
      renderSection({ isNative: true }),
    ).not.toThrow()
    await Promise.resolve()
    expect(screen.queryByText("Pending invitations")).toBeNull()
  })
})
