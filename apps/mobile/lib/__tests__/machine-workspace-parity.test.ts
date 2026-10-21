// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A machine workspace's features are routed by *declaration*, and every
 * declaration has to be real (SHO-108).
 *
 * The interceptor decides the host once for every call, which only works while
 * the two lists it decides from stay honest. Two ways they stop being honest,
 * both seen on this card:
 *
 *   - a family is declared machine-owned but nothing can reach it (its callers
 *     fetch an absolute `${API_URL}` URL, which never enters the interceptor),
 *     so the test proves a behaviour that cannot happen; and
 *   - a family is declared but its path exists nowhere (`/api/work-templates`),
 *     or a cloud pin shadows it (first match wins), leaving a declaration that
 *     never fires.
 *
 * So: every declared family must resolve machine-ward for a machine workspace
 * and cloud-ward otherwise, must not be shadowed, must exist in the API, and —
 * where the app actually calls it — must be called through the workspace client
 * rather than a bare one. A new family added to either list without the other
 * side of this pairing fails here.
 */

import { describe, expect, test } from "bun:test"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import {
  MACHINE_WORKSPACE_CLOUD_ONLY,
  MACHINE_WORKSPACE_FAMILIES,
  MACHINE_WORKSPACE_OWNED,
  shouldRouteToRemote,
  type RouteEntry,
} from "@shogo/shared-app/services"

const mobileRoot = join(import.meta.dir, "..", "..")
const repoRoot = join(mobileRoot, "..", "..")
const MACHINE_WORKSPACE_ID = "ws-on-the-machine"

const DECLARED: RouteEntry[] = [...MACHINE_WORKSPACE_OWNED, ...MACHINE_WORKSPACE_FAMILIES]

/** `/api/boards(/|?|$)` → `/api/boards`, the family the declaration is about. */
function familyOf(entry: RouteEntry): string {
  const source = entry.pattern.source
  const match = source.match(/^\^\\\/api\\\/([a-z0-9-]+)/)
  if (!match) throw new Error(`not a top-level family pattern: ${source}`)
  return match[1]
}

const FAMILIES = DECLARED.map(familyOf)

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "__tests__") continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) walk(path, out)
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(path)
  }
  return out
}

const apiSource = walk(join(repoRoot, "apps", "api", "src"), []).map((path) => ({
  path,
  source: readFileSync(path, "utf8"),
}))

const mobileSource = walk(join(mobileRoot), []).map((path) => ({
  path: path.slice(mobileRoot.length + 1),
  source: readFileSync(path, "utf8"),
}))

describe("SHO-108 — machine-workspace routing is declared, and the declarations are real", () => {
  test("the families are what the lists say they are", () => {
    // Guards the parser above: a pattern it cannot read would silently drop a
    // family from every assertion in this file.
    expect(FAMILIES.length).toBe(DECLARED.length)
    expect(FAMILIES).toContain("boards")
    expect(FAMILIES).toContain("chat-mentionables")
  })

  for (const family of FAMILIES) {
    test(`/api/${family} goes to the machine workspace, and to the cloud otherwise`, () => {
      for (const path of [`/api/${family}`, `/api/${family}/abc`, `/api/${family}?x=1`]) {
        expect(shouldRouteToRemote(path, { machineWorkspaceId: MACHINE_WORKSPACE_ID })).toBe(true)
        // No machine workspace in view → the same call is a cloud call. A
        // declaration that leaked would send a cloud workspace's boards to a
        // computer that has never heard of it.
        expect(shouldRouteToRemote(path, { machineWorkspaceId: null })).toBe(false)
      }
    })

    test(`/api/${family} is not shadowed by a cloud pin`, () => {
      // Cloud pins are checked first, so a family that appears in both lists
      // would resolve cloud-ward forever and its "machine-owned" comment would
      // be a lie.
      const path = `/api/${family}/abc`
      for (const entry of MACHINE_WORKSPACE_CLOUD_ONLY) {
        expect(entry.pattern.test(path)).toBe(false)
      }
    })

    test(`/api/${family} is a path the API actually serves`, () => {
      // A path segment, at any depth: a family names a route top-level or under
      // a workspace (`/api/workspaces/:id/reminders`). A declaration for a path
      // nobody serves (`/api/work-templates`, `/api/conversation-message-edits`
      // both were) is a comment that reads as a guarantee.
      const segment = new RegExp(`/${family}(?:[/'"?:]|$)`)
      const served = apiSource.some(({ source }) => segment.test(source))
      expect(served).toBe(true)
    })
  }

  test("no machine-owned family is fetched with an absolute URL", () => {
    // A raw `${API_URL}/api/...` fetch never enters the interceptor, so the
    // declaration cannot apply to it and the screen reads the cloud while a
    // machine workspace is open. This is the escape hatch that kept the `@`
    // picker on the cloud even though its family was declared (SHO-108).
    const problems: string[] = []
    for (const family of FAMILIES) {
      const callers = mobileSource.filter(({ source }) =>
        new RegExp(`/api/${family}(?:[/?\`"'])`).test(source),
      )
      for (const caller of callers) {
        // The absolute-URL escape hatch: `${API_URL}/api/...` is a raw fetch,
        // which the interceptor never sees, so the declaration cannot apply.
        if (new RegExp("\\$\\{API_URL\\}/api/" + family + "(?:[/?`\"'])").test(caller.source)) {
          problems.push(
            `/api/${family}: ${caller.path} builds an absolute URL, bypassing the interceptor`,
          )
        }
      }
    }
    expect(problems).toEqual([])
  })
})
