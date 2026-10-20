// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * "This Mac" in the workspace switcher (SHO-54).
 *
 * The rows are the desktop's *own* workspaces. They stay visible when the
 * machine drops (last-known snapshot, greyed) instead of disappearing, and
 * only an online machine can be opened — an offline row must never fall back
 * to cloud data for a workspace the cloud has never heard of.
 */

import { describe, expect, mock, test } from "bun:test"
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

const { MachineWorkspacesGroup, relativeWhen } = await import("../MachineWorkspacesGroup")

const onlineMachine = {
  id: "inst-1",
  name: "Russell’s MacBook",
  status: "online" as const,
  stale: false,
  lastSeenAt: "2026-10-19T10:00:00.000Z",
  workspaces: [
    { id: "lw-1", name: "Personal", kind: "personal", projectCount: 3, lastActivityAt: "2026-10-19T09:58:00.000Z" },
    { id: "lw-2", name: "Acme Team", kind: "team", projectCount: 1, lastActivityAt: "2026-10-18T09:00:00.000Z" },
  ],
}

const offlineMachine = {
  id: "inst-2",
  name: "Studio iMac",
  status: "offline" as const,
  stale: true,
  lastSeenAt: "2026-10-19T08:00:00.000Z",
  workspaces: [{ id: "lw-9", name: "Archive", kind: "team", projectCount: 0, lastActivityAt: null }],
}

describe("relativeWhen", () => {
  const now = Date.parse("2026-10-19T12:00:00.000Z")

  test("reads as a duration, never a raw timestamp", () => {
    expect(relativeWhen("2026-10-19T11:59:30.000Z", now)).toBe("just now")
    expect(relativeWhen("2026-10-19T11:56:00.000Z", now)).toBe("4 min ago")
    expect(relativeWhen("2026-10-19T09:00:00.000Z", now)).toBe("3 h ago")
    expect(relativeWhen("2026-10-17T12:00:00.000Z", now)).toBe("2 d ago")
    expect(relativeWhen(null, now)).toBe("no activity yet")
  })
})

describe("MachineWorkspacesGroup", () => {
  test('lists the machine’s workspaces under "This Mac" with projects and activity', () => {
    const { container } = render(
      createElement(MachineWorkspacesGroup, { machines: [onlineMachine], onOpen: () => {} }),
    )
    expect(screen.getByText("This Mac")).toBeTruthy()
    expect(screen.getByText("Russell’s MacBook")).toBeTruthy()
    expect(screen.getByText("Personal")).toBeTruthy()
    expect(screen.getByText(/3 projects/)).toBeTruthy()
    // Presence dot carries the state for screen readers ("Online").
    expect(container.querySelector('[accessibilityLabel="Online"]')).toBeTruthy()
  })

  test("opens the machine workspace the user picked", () => {
    const opened: any[] = []
    render(
      createElement(MachineWorkspacesGroup, {
        machines: [onlineMachine],
        onOpen: (machine: any, workspace: any) => opened.push([machine.id, workspace.id]),
      }),
    )
    fireEvent.click(screen.getByLabelText("Acme Team on Russell’s MacBook"))
    expect(opened).toEqual([["inst-1", "lw-2"]])
  })

  test("keeps an offline machine’s last-known rows visible but unopenable", () => {
    const opened: any[] = []
    render(
      createElement(MachineWorkspacesGroup, {
        machines: [offlineMachine],
        onOpen: (_m: any, w: any) => opened.push(w.id),
      }),
    )
    expect(screen.getByText("Archive")).toBeTruthy()
    expect(screen.getByText(/Offline · last seen/)).toBeTruthy()
    const row = screen.getByLabelText("Archive on Studio iMac") as HTMLButtonElement
    expect(row.disabled).toBe(true)
    fireEvent.click(row)
    expect(opened).toEqual([])
  })

  test("renders nothing when the user has no paired machine", () => {
    const { container } = render(
      createElement(MachineWorkspacesGroup, { machines: [], onOpen: () => {} }),
    )
    expect(container.textContent).toBe("")
  })
})
