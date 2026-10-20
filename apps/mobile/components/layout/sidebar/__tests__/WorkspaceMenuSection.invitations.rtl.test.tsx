// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The workspace switcher surfaces invitations you *received*: a "Pending
 * invitations" block above the workspace list, one row per workspace invite,
 * with Accept switching to that workspace (and closing the sheet) and an
 * expired invite rendered disabled.
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
  api: {
    getReceivedInvitations: async () => invitations,
  },
}))

mock.module(resolve(import.meta.dir, "../../../../lib/billing-config"), () => ({ getPlanDisplayName: () => "Free" }))
mock.module(resolve(import.meta.dir, "../../../../lib/analytics"), () => ({ EVENTS: {}, trackEvent: () => {} }))
mock.module(resolve(import.meta.dir, "../../../billing/UsageWindows"), () => ({ CompactUsageWindows: () => null }))
mock.module(resolve(import.meta.dir, "../../../../hooks/useCloudSession"), () => ({
  useCloudSession: () => ({ cloud: { signedIn: false, cloudUrl: null, reachable: true, user: null }, pending: null, error: null, signIn: async () => {}, signOut: async () => {} }),
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

function renderSection() {
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
    />,
  )
}

beforeEach(() => {
  cleanup()
  acceptInvitation.mockClear()
  declineInvitation.mockClear()
  loadAllWorkspaces.mockClear()
  onSwitchWorkspace.mockClear()
  onClose.mockClear()
  invitations = []
})

describe("WorkspaceMenuSection pending invitations", () => {
  test("says nothing when there are no received invitations", async () => {
    renderSection()
    await Promise.resolve()
    expect(screen.queryByText("Pending invitations")).toBeNull()
  })

  test("lists a received workspace invitation above the workspace list", async () => {
    invitations = [
      { id: "inv-1", workspaceId: "ws-joined", role: "admin", projectId: null, status: "pending", workspace: { name: "Gamma" } },
    ]
    const { container } = renderSection()

    expect(await screen.findByText("Pending invitations")).toBeTruthy()
    expect(screen.getByText("Gamma")).toBeTruthy()

    // Above the workspace list, not below it.
    const html = container.innerHTML
    expect(html.indexOf("Pending invitations")).toBeLessThan(html.indexOf("All workspaces"))
  })

  test("accepting joins the workspace, switches to it and closes the sheet", async () => {
    invitations = [
      { id: "inv-1", workspaceId: "ws-joined", role: "admin", projectId: null, status: "pending", workspace: { name: "Gamma" } },
    ]
    renderSection()

    fireEvent.click(await screen.findByLabelText("Accept invitation to Gamma"))

    await waitFor(() => expect(acceptInvitation).toHaveBeenCalledTimes(1))
    expect(acceptInvitation.mock.calls[0][0]).toBe("inv-1")
    await waitFor(() => expect(loadAllWorkspaces).toHaveBeenCalledTimes(1))
    expect(onSwitchWorkspace).toHaveBeenCalledWith("ws-joined")
    expect(onClose).toHaveBeenCalled()
  })

  test("declining removes the invite without switching workspace", async () => {
    invitations = [
      { id: "inv-1", workspaceId: "ws-joined", role: "member", projectId: null, status: "pending", workspace: { name: "Gamma" } },
    ]
    renderSection()

    fireEvent.click(await screen.findByLabelText("Decline invitation to Gamma"))

    expect(declineInvitation).toHaveBeenCalledTimes(1)
    expect(onSwitchWorkspace).not.toHaveBeenCalled()
  })

  test("an expired invite is disabled and says to ask for a new one", async () => {
    invitations = [
      { id: "inv-1", workspaceId: "ws-joined", role: "member", projectId: null, status: "expired", workspace: { name: "Gamma" } },
    ]
    renderSection()

    const accept = (await screen.findByLabelText("Accept invitation to Gamma")) as HTMLButtonElement
    expect(accept.disabled).toBe(true)
    expect(screen.getByText("Expired invitation. Ask for a new invite to join.")).toBeTruthy()
  })

  test("project invitations stay out of the switcher", async () => {
    invitations = [
      { id: "inv-2", workspaceId: "ws-joined", projectId: "proj-1", role: "member", status: "pending", workspace: { name: "Gamma" } },
    ]
    renderSection()
    await Promise.resolve()
    expect(screen.queryByText("Pending invitations")).toBeNull()
  })
})
