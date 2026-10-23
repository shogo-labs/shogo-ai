// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Every switcher surface reads the same list (SHO-108).
 *
 * The wide sidebar, the account popover, the phone sheet and the account screen
 * each render `WorkspaceMenuSection`, and each one must hand it the *whole* list
 * — cloud workspaces plus each paired computer's own — built by
 * `buildWorkspaceEntries` and checked by `currentWorkspaceKey`. A surface that
 * still passes a cloud-only array is how the phone ended up unable to see the
 * machine's workspaces at all.
 *
 * This is a source guard rather than four rendered trees: the phone sheet needs
 * the whole native module graph to mount, and the property being protected is
 * "this call site uses the shared list", which the source states directly.
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const mobileRoot = join(import.meta.dir, "..", "..")

function source(...parts: string[]): string {
  return readFileSync(join(mobileRoot, ...parts), "utf8")
}

const SURFACES: Array<[string, string[]]> = [
  ["the wide sidebar", ["components", "layout", "sidebar", "AppSidebar.tsx"]],
  ["the phone switcher sheet", ["components", "layout", "MobileWorkspaceSwitcher.tsx"]],
  ["the account screen", ["app", "(app)", "account.tsx"]],
]

describe("SHO-108 — one list for every switcher surface", () => {
  for (const [name, path] of SURFACES) {
    test(`${name} builds the shared entry list`, () => {
      const file = source(...path)
      expect(file).toContain("buildWorkspaceEntries({")
      expect(file).toContain("currentWorkspaceKey({")
      // …and gives it to the section, rather than a cloud-only array.
      expect(file).toMatch(/entries=\{(workspaceEntries|entries)\}/)
      expect(file).toMatch(/currentKey=\{(activeWorkspaceKey|activeKey)\}/)
      expect(file).not.toContain("workspaces={allWorkspaces}")
    })
  }

  test("the section has no machine-only group or second switch path", () => {
    const section = source("components", "layout", "sidebar", "WorkspaceMenuSection.tsx")
    expect(section).not.toContain("MachineWorkspacesGroup")
    expect(section).not.toContain("This Mac")
    expect(section).not.toContain("onOpenMachineWorkspace")
    // One row renderer for every host.
    expect(section).toContain("<WorkspaceRow")
    expect(section).not.toContain("workspaceInitial")
  })

  test("the deleted group stays deleted", () => {
    expect(() =>
      source("components", "layout", "sidebar", "MachineWorkspacesGroup.tsx"),
    ).toThrow()
  })
})
