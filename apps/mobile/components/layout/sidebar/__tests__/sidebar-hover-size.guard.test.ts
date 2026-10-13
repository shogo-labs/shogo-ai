// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Source guard: sidebar rows must not change size on hover.
 * Hover-reveal controls stay in the layout and only fade in. Switching
 * `hidden` to `group-hover:flex` (or hiding a sibling with
 * `group-hover:hidden`) inserts or removes boxes, so the row grows.
 */
import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, resolve } from "node:path"

const layoutRoot = resolve(import.meta.dir, "../..")

const FORBIDDEN: Array<[RegExp, string]> = [
  [/group-hover:flex\b/, "group-hover:flex"],
  [/group-hover:hidden\b/, "group-hover:hidden"],
  [/group-hover:block\b/, "group-hover:block"],
]

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1")
}

function sourceFiles(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir)) {
    if (entry === "__tests__" || entry === "node_modules") continue
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) {
      files.push(...sourceFiles(path))
      continue
    }
    if (entry.endsWith(".tsx") || entry.endsWith(".ts")) files.push(path)
  }
  return files
}

describe("sidebar hover size guard", () => {
  const files = sourceFiles(layoutRoot)

  test("scans sidebar and layout sources", () => {
    expect(files.length).toBeGreaterThan(0)
    expect(files.some((file) => file.endsWith("ChatTreeItem.tsx"))).toBe(true)
    expect(files.some((file) => file.endsWith("MobileWorkspaceShell.tsx"))).toBe(true)
  })

  for (const file of files) {
    const label = relative(layoutRoot, file)
    test(`${label} does not resize on hover`, () => {
      const source = stripComments(readFileSync(file, "utf8"))
      for (const [pattern, name] of FORBIDDEN) {
        if (pattern.test(source)) {
          throw new Error(
            `${label} uses "${name}". Sidebar hover reveals must stay in the ` +
              `layout (opacity-0 / group-hover:opacity-100) so rows never grow.`,
          )
        }
      }
    })
  }
})
