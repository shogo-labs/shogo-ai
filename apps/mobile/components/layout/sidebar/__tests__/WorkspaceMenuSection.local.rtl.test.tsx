// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { resolve } from "node:path"
import { beforeEach, describe, expect, mock, test } from "bun:test"
import { fireEvent, render, screen } from "@testing-library/react"
import { createElement } from "react"
import { createReactNativeMock } from "../../../../test/react-native-mock"

mock.module("react-native", () =>
  createReactNativeMock({
    Platform: { OS: "web" },
    Pressable: ({ accessibilityLabel, children, onPress, disabled, ...props }: any) =>
      createElement("button", { ...props, "aria-label": accessibilityLabel, onClick: onPress, disabled }, children),
  }),
)

mock.module("@shogo/shared-ui/primitives", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}))

mock.module("lucide-react-native", () => {
  const Icon = (name: string) =>
    function LucideIcon() {
      return createElement("span", { "data-icon": name })
    }
  return Object.fromEntries(
    ["Check", "ChevronRight", "Cloud", "CloudOff", "ExternalLink", "LogIn", "LogOut", "Plus", "Settings", "Sparkles", "Users", "Zap"].map(
      (n) => [n, Icon(n)],
    ),
  )
})

mock.module(resolve(import.meta.dir, "../../../../contexts/posthog"), () => ({ usePostHogSafe: () => null }))
mock.module(resolve(import.meta.dir, "../../../../lib/billing-config"), () => ({ getPlanDisplayName: () => "Free" }))
mock.module(resolve(import.meta.dir, "../../../../lib/analytics"), () => ({ EVENTS: {}, trackEvent: () => {} }))
mock.module(resolve(import.meta.dir, "../../../billing/UsageWindows"), () => ({ CompactUsageWindows: () => null }))

let cloud = { signedIn: false, cloudUrl: null, reachable: true, user: null as any, workspaces: [] as any[] }
const cloudIds = () => new Set(cloud.workspaces.map((w) => w.id))
mock.module(resolve(import.meta.dir, "../../../../lib/workspace-route"), () => ({
  useCloudWorkspaces: () => cloud,
  isCloudWorkspace: (id: string) => cloudIds().has(id),
}))

const signIn = mock(async () => true)
const signOut = mock(async () => true)
mock.module(resolve(import.meta.dir, "../../../../hooks/useCloudSession"), () => ({
  useCloudSession: () => ({ cloud, pending: null, error: null, signIn, signOut }),
}))

const { WorkspaceMenuSection, workspaceKindBadge } = await import("../WorkspaceMenuSection")

const localWorkspaces = [
  { id: "local-personal", name: "Personal", kind: "personal" },
  { id: "local-team", name: "My Workspace", kind: "team" },
]

function renderSection(workspaces: any[]) {
  return render(
    <WorkspaceMenuSection
      workspaces={workspaces}
      currentWorkspace={workspaces[0]}
      billingData={{ hasActiveSubscription: false }}
      workspacePlan={null}
      allPlans={{}}
      showBilling={false}
      onNavigate={() => {}}
      onSwitchWorkspace={() => {}}
      onCreateWorkspace={() => {}}
      localMode
      onClose={() => {}}
    />,
  )
}

beforeEach(() => {
  cloud = { signedIn: false, cloudUrl: null, reachable: true, user: null, workspaces: [] }
  signIn.mockClear()
  signOut.mockClear()
})

describe("workspaceKindBadge", () => {
  test("desktop tags by location", () => {
    expect(workspaceKindBadge({ kind: "personal" }, { localMode: true }).label).toBe("Local")
    expect(workspaceKindBadge({ kind: "team" }, { localMode: true, cloud: true }).label).toBe("Cloud")
    expect(workspaceKindBadge({ kind: "personal" }, { localMode: true, cloud: true }).label).toBe("Cloud")
  })

  test("cloud web tags by kind", () => {
    expect(workspaceKindBadge({ kind: "personal" }).label).toBe("Personal")
    expect(workspaceKindBadge({ kind: "team" }).label).toBe("Team")
  })
})

describe("WorkspaceMenuSection in local mode", () => {
  test("signed out: local workspaces tagged Local, with Sign in", () => {
    renderSection(localWorkspaces)
    expect(screen.getAllByText("Local")).toHaveLength(2)
    expect(screen.queryByText("Cloud")).toBeNull()
    expect(screen.queryByText("Create new workspace")).toBeNull()
    fireEvent.click(screen.getByLabelText("Sign in to Shogo Cloud"))
    expect(signIn).toHaveBeenCalledTimes(1)
  })

  test("signed in: local and cloud side by side, with the account and Sign out", () => {
    cloud = {
      signedIn: true,
      cloudUrl: null,
      reachable: true,
      user: { id: "u", name: "Russ", email: "russ@example.com" },
      workspaces: [
        { id: "cloud-personal", name: "Russ Personal", kind: "personal" },
        { id: "ws-acme", name: "Acme", kind: "team" },
      ],
    }
    renderSection([...localWorkspaces, ...cloud.workspaces])
    expect(screen.getAllByText("Personal").length).toBeGreaterThan(0)
    expect(screen.getByText("Russ Personal")).toBeTruthy()
    expect(screen.getAllByText("Local")).toHaveLength(2)
    expect(screen.getAllByText("Cloud")).toHaveLength(2)
    expect(screen.getByText("russ@example.com")).toBeTruthy()
    expect(screen.queryByLabelText("Sign in to Shogo Cloud")).toBeNull()
    fireEvent.click(screen.getByLabelText("Sign out of Shogo Cloud"))
    expect(signOut).toHaveBeenCalledTimes(1)
  })
})
