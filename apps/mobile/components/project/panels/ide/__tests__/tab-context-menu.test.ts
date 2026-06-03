// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * UX-COPY-PATH — unit tests for the pure tab context-menu helper.
 *
 * Pure module, no React / clipboard / shell / DOM — runs under `bun test`.
 * Pins: absolute + relative path computation (separator normalisation,
 * outside-root fallback, case sensitivity per platform); the menu model
 * ordering + per-item enablement; reveal relabelling; and close-target
 * resolution incl. pinned-tab preservation.
 */
import { describe, expect, test } from "bun:test"
import {
  buildTabContextMenu,
  revealActionLabel,
  tabAbsolutePath,
  tabRelativePath,
  tabsToClose,
  type Tab,
  type TabMenuActionId,
} from "../tab-context-menu"

const tab = (id: string, path: string | null = id, extra: Partial<Tab> = {}): Tab => ({ id, path, ...extra })

const ROOT = "/home/u/project"

describe("tabAbsolutePath", () => {
  test("normalises back-slashes and dup separators", () => {
    expect(tabAbsolutePath(tab("t", "C:\\a\\\\b\\c.ts"))).toBe("C:/a/b/c.ts")
  })
  test("null for virtual/untitled (null or empty path)", () => {
    expect(tabAbsolutePath(tab("u", null))).toBeNull()
    expect(tabAbsolutePath(tab("u", ""))).toBeNull()
  })
})

describe("tabRelativePath", () => {
  test("returns path relative to workspace root with forward slashes", () => {
    expect(tabRelativePath(tab("t", `${ROOT}/src/components/Login.tsx`), ROOT)).toBe("src/components/Login.tsx")
  })
  test("normalises a windows-style absolute + root", () => {
    expect(tabRelativePath(tab("t", "C:\\proj\\src\\a.ts"), "C:\\proj", "windows")).toBe("src/a.ts")
  })
  test("tolerates a trailing slash on the root", () => {
    expect(tabRelativePath(tab("t", `${ROOT}/a.ts`), `${ROOT}/`)).toBe("a.ts")
  })
  test("path === root → empty string", () => {
    expect(tabRelativePath(tab("t", ROOT), ROOT)).toBe("")
  })
  test("file OUTSIDE the root → falls back to absolute path", () => {
    expect(tabRelativePath(tab("t", "/etc/hosts"), ROOT)).toBe("/etc/hosts")
  })
  test("does not treat /work as a prefix of /workspace (separator-aware)", () => {
    expect(tabRelativePath(tab("t", "/workspace/a.ts"), "/work")).toBe("/workspace/a.ts")
  })
  test("no/empty workspace root → absolute path", () => {
    expect(tabRelativePath(tab("t", `${ROOT}/a.ts`), null)).toBe(`${ROOT}/a.ts`)
    expect(tabRelativePath(tab("t", `${ROOT}/a.ts`), "")).toBe(`${ROOT}/a.ts`)
  })
  test("virtual tab → null", () => {
    expect(tabRelativePath(tab("u", null), ROOT)).toBeNull()
  })
  test("case-insensitive root match on mac/windows", () => {
    expect(tabRelativePath(tab("t", "/Home/U/Project/Src/A.ts"), ROOT, "mac")).toBe("Src/A.ts")
    expect(tabRelativePath(tab("t", "C:\\Proj\\A.ts"), "c:\\proj", "windows")).toBe("A.ts")
  })
  test("case-sensitive root match on linux (mismatch → absolute fallback)", () => {
    expect(tabRelativePath(tab("t", "/Home/U/Project/a.ts"), ROOT, "linux")).toBe("/Home/U/Project/a.ts")
  })
})

describe("revealActionLabel", () => {
  test("per-platform labels", () => {
    expect(revealActionLabel("mac")).toBe("Reveal in Finder")
    expect(revealActionLabel("windows")).toBe("Reveal in File Explorer")
    expect(revealActionLabel("linux")).toBe("Open Containing Folder")
  })
})

describe("tabsToClose", () => {
  const tabs = [tab("a"), tab("b"), tab("c"), tab("d")]

  test("close → just the clicked tab", () => {
    expect(tabsToClose("close", "b", tabs).map((t) => t.id)).toEqual(["b"])
  })
  test("close others → everything except clicked", () => {
    expect(tabsToClose("closeOthers", "b", tabs).map((t) => t.id)).toEqual(["a", "c", "d"])
  })
  test("close to the right → only tabs after clicked", () => {
    expect(tabsToClose("closeToRight", "b", tabs).map((t) => t.id)).toEqual(["c", "d"])
  })
  test("close to the right of the LAST tab → none", () => {
    expect(tabsToClose("closeToRight", "d", tabs)).toEqual([])
  })
  test("close all → everything", () => {
    expect(tabsToClose("closeAll", "b", tabs).map((t) => t.id)).toEqual(["a", "b", "c", "d"])
  })
  test("pinned tabs are preserved by bulk closes", () => {
    const withPin = [tab("a", "a", { pinned: true }), tab("b"), tab("c", "c", { pinned: true }), tab("d")]
    expect(tabsToClose("closeOthers", "b", withPin).map((t) => t.id)).toEqual(["d"])
    expect(tabsToClose("closeAll", "b", withPin).map((t) => t.id)).toEqual(["b", "d"])
    expect(tabsToClose("closeToRight", "b", withPin).map((t) => t.id)).toEqual(["d"])
  })
  test("close (single) still works on a pinned clicked tab", () => {
    const withPin = [tab("a", "a", { pinned: true }), tab("b")]
    expect(tabsToClose("close", "a", withPin).map((t) => t.id)).toEqual(["a"])
  })
  test("unknown clicked id → empty for close/right, full-but-filtered for others/all", () => {
    expect(tabsToClose("close", "zzz", tabs)).toEqual([])
    expect(tabsToClose("closeToRight", "zzz", tabs)).toEqual([])
    expect(tabsToClose("closeOthers", "zzz", tabs).map((t) => t.id)).toEqual(["a", "b", "c", "d"])
  })
  test("does not mutate the input array", () => {
    const copy = [...tabs]
    tabsToClose("closeAll", "a", tabs)
    expect(tabs).toEqual(copy)
  })
})

describe("buildTabContextMenu", () => {
  const tabs = [tab("a"), tab("b"), tab("c")]

  test("ordered ids with separators in the right places", () => {
    const menu = buildTabContextMenu(tab("b"), tabs, ROOT, { platform: "mac" })
    expect(menu.map((m) => m.id)).toEqual([
      "copyPath", "copyRelativePath", "reveal", "close", "closeOthers", "closeToRight", "closeAll",
    ])
    expect(menu.find((m) => m.id === "reveal")?.separatorBefore).toBe(true)
    expect(menu.find((m) => m.id === "close")?.separatorBefore).toBe(true)
  })

  test("reveal uses the platform label", () => {
    expect(buildTabContextMenu(tab("b"), tabs, ROOT, { platform: "windows" }).find((m) => m.id === "reveal")?.label)
      .toBe("Reveal in File Explorer")
  })

  test("copy + reveal DISABLED for a virtual/untitled tab", () => {
    const menu = buildTabContextMenu(tab("u", null), [tab("u", null), tab("b")])
    const byId = (id: TabMenuActionId) => menu.find((m) => m.id === id)!
    expect(byId("copyPath").enabled).toBe(false)
    expect(byId("copyRelativePath").enabled).toBe(false)
    expect(byId("reveal").enabled).toBe(false)
    expect(byId("close").enabled).toBe(true)
  })

  test("onDisk:false disables reveal even when a path exists", () => {
    const menu = buildTabContextMenu(tab("b"), tabs, ROOT, { onDisk: false })
    expect(menu.find((m) => m.id === "reveal")?.enabled).toBe(false)
    // copy is still enabled — the path string exists even if not yet saved
    expect(menu.find((m) => m.id === "copyPath")?.enabled).toBe(true)
  })

  test("Close Others disabled when only one tab is open", () => {
    const menu = buildTabContextMenu(tab("only"), [tab("only")], ROOT)
    expect(menu.find((m) => m.id === "closeOthers")?.enabled).toBe(false)
    expect(menu.find((m) => m.id === "close")?.enabled).toBe(true)
  })

  test("Close to the Right disabled on the last tab", () => {
    const menu = buildTabContextMenu(tab("c"), tabs, ROOT)
    expect(menu.find((m) => m.id === "closeToRight")?.enabled).toBe(false)
  })

  test("Close Others/All disabled when every other tab is pinned", () => {
    const t = [tab("a", "a", { pinned: true }), tab("b"), tab("c", "c", { pinned: true })]
    const menu = buildTabContextMenu(tab("b"), t, ROOT)
    expect(menu.find((m) => m.id === "closeOthers")?.enabled).toBe(false)
    // closeAll still has the unpinned clicked tab 'b'
    expect(menu.find((m) => m.id === "closeAll")?.enabled).toBe(true)
  })

  test("Close All disabled when the only tab is pinned", () => {
    const menu = buildTabContextMenu(tab("p", "p", { pinned: true }), [tab("p", "p", { pinned: true })], ROOT)
    expect(menu.find((m) => m.id === "closeAll")?.enabled).toBe(false)
  })

  test("defaults to linux label + handles non-array tabs defensively", () => {
    const menu = buildTabContextMenu(tab("b"), undefined as unknown as Tab[], ROOT)
    expect(menu.find((m) => m.id === "reveal")?.label).toBe("Open Containing Folder")
    expect(menu.find((m) => m.id === "closeOthers")?.enabled).toBe(false)
  })
})
