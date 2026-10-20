// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-84 acceptance — the invitation block renders on *both* surfaces.
 *
 * `WorkspaceMenuSection` is rendered by the wide sidebar/popover
 * (`presentation="switcher"` and the wide-web default) and by the native
 * sidebar (`isNative`), and each of those branches composes the list itself.
 * The dev's spec only renders the wide-web default, so a branch that forgot to
 * include the block would still be green. This spec renders every branch the
 * switcher actually uses and asserts the block is there, above the rows, and
 * operable.
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
const authUser = { id: "user-invitee", email: "invitee@example.com" }
mock.module(resolve(import.meta.dir, "../../../../contexts/auth"), () => ({
  useAuth: () => ({ user: authUser }),
  useAuthOptional: () => ({ user: authUser }),
  getAuthUserSnapshot: () => authUser,
}))

const acceptInvitation = mock(async () => ({}))
const declineInvitation = mock(async () => ({}))
const loadAllWorkspaces = mock(async () => {})
const http = { get: async () => ({ data: { items: [] } }) }

const domainStore = { workspaceCollection: { all: [], loadAll: loadAllWorkspaces } }
const domainActions = { acceptInvitation, declineInvitation }

mock.module(resolve(import.meta.dir, "../../../../contexts/domain"), () => ({
  useDomainHttpOptional: () => http,
  getDomainHttpClient: () => http,
  useDomainOptional: () => domainStore,
  getDomainStore: () => domainStore,
  useDomainActions: () => domainActions,
  useDomainActionsOptional: () => domainActions,
  getDomainActionsInstance: () => domainActions,
  useWorkspaceCollection: () => domainStore.workspaceCollection,
  useWorkspaceCollectionOptional: () => domainStore.workspaceCollection,
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

const WORKSPACES = [
  { id: "ws-current", name: "Acme", kind: "team" },
  { id: "ws-other", name: "Beta", kind: "team" },
]

const onSwitchWorkspace = mock((_id: string) => {})
const onClose = mock(() => {})

function renderSection(props: Record<string, unknown> = {}) {
  return render(
    <WorkspaceMenuSection
      workspaces={WORKSPACES}
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
})

describe("SHO-84 AC4 — every switcher surface lists the invitation", () => {
  test("the phone/native sidebar branch shows it", async () => {
    invitations = PENDING
    renderSection({ isNative: true })

    expect(await screen.findByText("Pending invitations")).toBeTruthy()
    expect(screen.getByText("Gamma")).toBeTruthy()
  })

  test("the popover switcher branch (presentation=switcher) shows it above the rows", async () => {
    invitations = PENDING
    const { container } = renderSection({ presentation: "switcher" })

    expect(await screen.findByText("Pending invitations")).toBeTruthy()
    const html = container.innerHTML
    expect(html.indexOf("Pending invitations")).toBeLessThan(html.indexOf("Acme"))
  })

  test("the wide-web default branch shows it", async () => {
    invitations = PENDING
    renderSection()

    expect(await screen.findByText("Pending invitations")).toBeTruthy()
  })

  test("the popover switcher accepts: joins, switches and closes", async () => {
    invitations = PENDING
    renderSection({ presentation: "switcher" })

    fireEvent.click(await screen.findByLabelText("Accept invitation to Gamma"))

    await waitFor(() => expect(acceptInvitation).toHaveBeenCalledTimes(1))
    expect(onSwitchWorkspace).toHaveBeenCalledWith("ws-joined")
    expect(onClose).toHaveBeenCalled()
  })
})

describe("SHO-84 AC5 — no pending invites means no empty box", () => {
  test("switcher branch renders nothing", async () => {
    renderSection({ presentation: "switcher" })
    await Promise.resolve()
    expect(screen.queryByText("Pending invitations")).toBeNull()
  })

  test("wide-web branch renders nothing", async () => {
    renderSection()
    await Promise.resolve()
    expect(screen.queryByText("Pending invitations")).toBeNull()
  })
})
