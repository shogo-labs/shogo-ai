// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Opening a machine workspace lands where a cloud workspace lands (SHO-108).
 *
 * A machine **team** workspace lands on the workspace agent with an empty chat
 * (SHO-4's rule) and a **personal** one follows the personal landing. Neither is
 * special-cased into the projects view: the switch takes the same route a cloud
 * workspace switch takes, so `lib/root-destination` resolves the landing from the
 * kind of the workspace that is now in view.
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { agentSessionSource, appHomeSurface } from "../root-destination"
import {
  buildWorkspaceEntries,
  currentWorkspaceKey,
  machineInstanceForEntry,
} from "../workspace-entries"

const odin = {
  id: "inst-odin",
  name: "odin",
  status: "online" as const,
  stale: false,
  workspaces: [
    { id: "lw-team", name: "Samsara", kind: "team" },
    { id: "lw-personal", name: "Home", kind: "personal" },
  ],
}

const entries = buildWorkspaceEntries({
  workspaces: [{ id: "ws-acme", name: "Acme", kind: "team" }],
  machines: [odin],
})

const teamEntry = entries.find((entry) => entry.name === "Samsara")!
const personalEntry = entries.find((entry) => entry.name === "Home")!

describe("SHO-108 — a machine workspace lands like a cloud workspace", () => {
  test("the selection carries the machine's own kind, so the shell follows it", () => {
    expect(machineInstanceForEntry(teamEntry, "ws-acme")?.localWorkspaceKind).toBe("team")
    expect(machineInstanceForEntry(personalEntry, "ws-acme")?.localWorkspaceKind).toBe("personal")
  })

  test("a machine team workspace lands on the workspace agent, on an empty chat", () => {
    // The landing itself is kind-driven, exactly as it is for a cloud workspace.
    expect(
      appHomeSurface({ kind: teamEntry.kind, narrow: false, runtimeEnabled: true }),
    ).toBe("agent")
    expect(
      appHomeSurface({ kind: teamEntry.kind, narrow: true, runtimeEnabled: true }),
    ).toBe("agent")
    expect(agentSessionSource({ startNewSession: true, kind: teamEntry.kind })).toBe("new")
  })

  test("a machine personal workspace keeps the personal landing", () => {
    expect(
      appHomeSurface({ kind: personalEntry.kind, narrow: false, runtimeEnabled: true }),
    ).toBe("agent")
    // Personal keeps resuming its primary chat rather than starting a new one.
    expect(agentSessionSource({ startNewSession: true, kind: personalEntry.kind })).toBe("primary")
  })

  test("the machine workspace is the one in view once selected", () => {
    const instance = machineInstanceForEntry(teamEntry, "ws-acme")!
    expect(
      currentWorkspaceKey({ entries, currentWorkspaceId: "ws-acme", activeInstance: instance }),
    ).toBe(teamEntry.key)
  })

  test("opening one takes the workspace-switch route, not a hard push", () => {
    const sidebar = readFileSync(
      join(import.meta.dir, "..", "..", "components", "layout", "sidebar", "AppSidebar.tsx"),
      "utf8",
    )

    // The old path: a machine-only handler that pushed the projects route.
    expect(sidebar).not.toContain("handleOpenMachineWorkspace")
    // The machine branch selects the instance and then lands where every
    // workspace switch lands.
    const machineBranch = sidebar.slice(
      sidebar.indexOf("const machine = machineInstanceForEntry"),
      sidebar.indexOf("// Back to a cloud workspace"),
    )
    expect(machineBranch).toContain("setActiveInstance(machine)")
    expect(machineBranch).toContain("reloadAfterWorkspaceSwitch()")
    expect(machineBranch).not.toContain('router.push("/(app)"')
  })
})
