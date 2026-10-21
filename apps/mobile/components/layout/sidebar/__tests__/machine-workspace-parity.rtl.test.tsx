// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A local workspace is a workspace (SHO-108).
 *
 * The switcher draws cloud workspaces and a paired computer's own workspaces as
 * the same row — same tile, name, kind badge and checkmark — and the machine row
 * adds exactly two things: a `Local` chip and its host. The open machine
 * workspace is the checked row, and no cloud workspace is checked behind it.
 * There is no `This Mac` heading and no nested machine group.
 */

import { resolve } from "node:path"
import { beforeEach, describe, expect, mock, test } from "bun:test"
import { fireEvent, render, screen } from "@testing-library/react"
import { createElement } from "react"
import { createReactNativeMock } from "../../../../test/react-native-mock"

mock.module("react-native", () =>
  createReactNativeMock({
    Platform: { OS: "web" },
    Pressable: ({ accessibilityLabel, accessibilityState, testID, children, onPress, ...props }: any) =>
      createElement(
        "button",
        {
          ...props,
          "aria-label": accessibilityLabel,
          "data-rn-shim": testID,
          "data-selected": accessibilityState?.selected ? "true" : undefined,
          onClick: onPress,
        },
        children,
      ),
  }),
)

mock.module("@shogo/shared-ui/primitives", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}))

mock.module("lucide-react-native", () => {
  const Icon = (name: string) =>
    function LucideIcon(props: any) {
      return createElement("span", { "data-icon": name, "data-rn-shim": props?.testID })
    }
  return Object.fromEntries(
    ["Check", "ChevronRight", "Cloud", "CloudOff", "ExternalLink", "LogIn", "LogOut", "Plus", "Settings", "Sparkles", "Users", "Zap"].map(
      (n) => [n, Icon(n)],
    ),
  )
})

mock.module(resolve(import.meta.dir, "../../../../contexts/posthog"), () => ({ usePostHogSafe: () => null }))
mock.module(resolve(import.meta.dir, "../../../../contexts/auth"), () => ({
  useAuth: () => ({ user: { id: "user-1", email: "user@example.com" } }),
  useAuthOptional: () => ({ user: { id: "user-1", email: "user@example.com" } }),
  getAuthUserSnapshot: () => ({ id: "user-1", email: "user@example.com" }),
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
mock.module(resolve(import.meta.dir, "../../../../lib/billing-config"), () => ({ getPlanDisplayName: () => "Free" }))
mock.module(resolve(import.meta.dir, "../../../../lib/analytics"), () => ({ EVENTS: {}, trackEvent: () => {} }))
mock.module(resolve(import.meta.dir, "../../../billing/UsageWindows"), () => ({ CompactUsageWindows: () => null }))

const cloud = { signedIn: false, cloudUrl: null, reachable: true, user: null as any, workspaces: [] as any[] }
mock.module(resolve(import.meta.dir, "../../../../lib/workspace-route"), () => ({
  routeUrl: (url: string) => url,
  routePath: (path: string) => path,
  isActiveWorkspaceCloud: () => false,
  installWorkspaceFetchRouter: () => {},
  refreshCloudWorkspaces: async () => cloud,
  setCloudWorkspacesState: () => {},
  getCloudWorkspacesState: () => cloud,
  subscribeCloudWorkspaces: () => () => {},
  _resetWorkspaceRouteForTests: () => {},
  useCloudWorkspaces: () => cloud,
  isCloudWorkspace: () => false,
}))

mock.module(resolve(import.meta.dir, "../../../../hooks/useCloudSession"), () => ({
  useCloudSession: () => ({ cloud, pending: null, error: null, signIn: async () => true, signOut: async () => true }),
}))

let activeInstance: any = null
mock.module(resolve(import.meta.dir, "../../../../contexts/active-instance"), () => ({
  useActiveInstance: () => ({ instance: activeInstance }),
}))

const { WorkspaceMenuSection } = await import("../WorkspaceMenuSection")
const { buildWorkspaceEntries, currentWorkspaceKey } = await import("../../../../lib/workspace-entries")

const cloudWorkspace = { id: "ws-acme", name: "Acme", kind: "team" as const }
const odin = {
  id: "inst-odin",
  name: "odin",
  status: "online" as const,
  stale: false,
  lastSeenAt: "2026-10-21T05:00:00.000Z",
  workspaces: [{ id: "lw-main", name: "Samsara", kind: "team", projectCount: 3 }],
}

const entries = buildWorkspaceEntries({ workspaces: [cloudWorkspace], machines: [odin] })

function machineSelection() {
  return {
    instanceId: "inst-odin",
    name: "odin",
    hostname: "odin",
    workspaceId: "ws-acme",
    kind: "desktop",
    source: "machine",
    localWorkspaceId: "lw-main",
    localWorkspaceName: "Samsara",
    localWorkspaceKind: "team",
  }
}

const selected: any[] = []

function renderSection(props: { presentation?: "full" | "switcher"; isNative?: boolean } = {}) {
  const currentKey = currentWorkspaceKey({
    entries,
    currentWorkspaceId: "ws-acme",
    activeInstance,
  })
  return render(
    <WorkspaceMenuSection
      entries={entries}
      currentKey={currentKey}
      onSelect={(entry: any) => selected.push(entry.key)}
      currentWorkspace={cloudWorkspace}
      billingData={{ hasActiveSubscription: false }}
      workspacePlan={null}
      allPlans={{}}
      showBilling={false}
      onNavigate={() => {}}
      onCreateWorkspace={() => {}}
      localMode={false}
      onClose={() => {}}
      {...props}
    />,
  )
}

beforeEach(() => {
  activeInstance = null
  selected.length = 0
})

describe("SHO-108 — the switcher draws one row for every host", () => {
  test("cloud and machine rows are the same row component", () => {
    const { container } = renderSection({ presentation: "switcher" })

    const cloudRow = container.querySelector('[data-rn-shim="workspace-row:cloud:ws-acme"]')
    const machineRow = container.querySelector('[data-rn-shim="workspace-row:machine:inst-odin:lw-main"]')

    expect(cloudRow).toBeTruthy()
    expect(machineRow).toBeTruthy()
    // Same element type and the same accessible role: one row renderer, not two.
    expect(cloudRow?.tagName).toBe(machineRow?.tagName)
    expect(cloudRow?.getAttribute("role")).toBe(machineRow?.getAttribute("role"))
    // Same name treatment and kind badge.
    expect(cloudRow?.textContent).toContain("Acme")
    expect(machineRow?.textContent).toContain("Samsara")
    expect(machineRow?.textContent).toContain("Team")
  })

  test("a machine row adds exactly a Local chip and its host", () => {
    const { container } = renderSection({ presentation: "switcher" })
    const cloudRow = container.querySelector('[data-rn-shim="workspace-row:cloud:ws-acme"]')!
    const machineRow = container.querySelector('[data-rn-shim="workspace-row:machine:inst-odin:lw-main"]')!

    expect(machineRow.textContent).toContain("Local")
    expect(machineRow.textContent).toContain("odin")
    // …and nothing extra on the cloud row.
    expect(cloudRow.textContent).not.toContain("Local")
    expect(machineRow.querySelector('[data-rn-shim="workspace-row-host:machine:inst-odin:lw-main"]')).toBeTruthy()
  })

  test("there is no second machine block", () => {
    renderSection({ presentation: "switcher" })
    expect(screen.queryByText("This Mac")).toBeNull()
    expect(screen.queryByLabelText("This Mac")).toBeNull()
  })

  test("the open machine workspace is the checked row, not the cloud one", () => {
    activeInstance = machineSelection()
    const { container } = renderSection({ presentation: "switcher" })

    expect(container.querySelector('[data-rn-shim="workspace-row-check:machine:inst-odin:lw-main"]')).toBeTruthy()
    expect(container.querySelector('[data-rn-shim="workspace-row-check:cloud:ws-acme"]')).toBeNull()

    const machineRow = container.querySelector('[data-rn-shim="workspace-row:machine:inst-odin:lw-main"]')
    expect(machineRow?.getAttribute("data-selected")).toBe("true")
    const cloudRow = container.querySelector('[data-rn-shim="workspace-row:cloud:ws-acme"]')
    expect(cloudRow?.getAttribute("data-selected")).toBeNull()
  })

  test("the full account list and the phone list use the same row", () => {
    activeInstance = machineSelection()

    for (const presentation of ["full", "switcher"] as const) {
      const view = renderSection({ presentation })
      expect(view.container.querySelector('[data-rn-shim="workspace-row:machine:inst-odin:lw-main"]')).toBeTruthy()
      view.unmount()
    }

    const phone = renderSection({ isNative: true })
    expect(phone.container.querySelector('[data-rn-shim="workspace-row:machine:inst-odin:lw-main"]')).toBeTruthy()
    expect(phone.container.querySelector('[data-rn-shim="workspace-row-check:machine:inst-odin:lw-main"]')).toBeTruthy()
  })

  test("one press path: both rows select through the same callback", () => {
    const { container } = renderSection({ presentation: "switcher" })

    fireEvent.click(container.querySelector('[data-rn-shim="workspace-row:cloud:ws-acme"]')!)
    fireEvent.click(container.querySelector('[data-rn-shim="workspace-row:machine:inst-odin:lw-main"]')!)

    expect(selected).toEqual(["cloud:ws-acme", "machine:inst-odin:lw-main"])
  })

  test("an offline host's row is still pressable", () => {
    const offlineEntries = buildWorkspaceEntries({
      workspaces: [cloudWorkspace],
      machines: [{ id: "inst-imac", name: "Studio iMac", status: "offline", stale: true, workspaces: [{ id: "lw-a", name: "Archive", kind: "team" }] }],
    })
    const { container } = render(
      <WorkspaceMenuSection
        entries={offlineEntries}
        currentKey={null}
        onSelect={(entry: any) => selected.push(entry.key)}
        currentWorkspace={cloudWorkspace}
        billingData={{ hasActiveSubscription: false }}
        workspacePlan={null}
        allPlans={{}}
        showBilling={false}
        onNavigate={() => {}}
        onCreateWorkspace={() => {}}
        localMode={false}
        onClose={() => {}}
        presentation="switcher"
      />,
    )

    const row = container.querySelector('[data-rn-shim="workspace-row:machine:inst-imac:lw-a"]') as HTMLButtonElement
    expect(row).toBeTruthy()
    // Pressable, not disabled: opening it mounts the workspace and shows the
    // app's existing "can't reach the host" state, which explains itself.
    expect((row as HTMLButtonElement).disabled).toBe(false)
    // The row says why it may not answer, instead of being a dead row.
    expect(row.textContent).toContain("Offline")
    fireEvent.click(row)
    expect(selected).toEqual(["machine:inst-imac:lw-a"])
  })
})
