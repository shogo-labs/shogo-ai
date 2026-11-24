// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-564 guard — the 401 every native API call hit cannot come back.
 *
 * `expo/fetch` turns an *undefined* `credentials` into `'include'`, and on iOS
 * `'include'` copies the shared cookie jar into the request and appends our
 * `Cookie` on top. A stale jar therefore broke the rejoin probe (`/turn`), the
 * task list, quick-actions, Stop and `/api/machines` — 882 refused `/turn`
 * probes in one morning — while a send, which already passed `'omit'` plus the
 * cookie, worked.
 *
 * Two rules, both cheap to keep:
 *
 *   1. Nowhere in `apps/mobile` may a request pick its credentials with
 *      `Platform.OS === "web" ? "include" : undefined`: the `undefined` *is* the
 *      bug.
 *   2. A module that calls the API from native must not use a bare
 *      `credentials: "include"` either. Build the init with `authedFetchInit`
 *      from `lib/agent-fetch` (or call `agentFetch`), which carries the cookie
 *      header and `'omit'` where the platform needs it. The list below is the
 *      native transport surface: add a module when it starts calling the API
 *      itself, rather than re-deriving the cookie handling.
 *
 *   bun test apps/mobile/lib/__tests__/authed-fetch.guard.test.ts
 */

import { describe, expect, test } from "bun:test"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"

const MOBILE = join(import.meta.dir, "../..")

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "__tests__" || entry === ".expo" || entry === "dist") {
      continue
    }
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.tsx?$/.test(entry)) out.push(full)
  }
  return out
}

/** Every module that speaks to the API on a native device. */
const AUTHED_FETCH_MODULES = [
  "lib/agent-fetch.ts",
  "lib/chat-stop.ts",
  "components/chat/probe-turn-status.ts",
  "components/chat/ChatPanel.tsx",
  "hooks/useWorkspaceHosts.ts",
]

const rel = (file: string) => file.slice(MOBILE.length + 1)

/**
 * Source with comments removed — the rules are about code, and the shared
 * helper's own doc comment says `credentials: 'include'` when explaining web.
 */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join("\n")
}

describe("credentials are never left to the platform", () => {
  test("no request derives its credentials from a ternary that throws away native", () => {
    const offenders = walk(MOBILE)
      .filter((file) => rel(file) !== "lib/__tests__/authed-fetch.guard.test.ts")
      .filter((file) =>
        /credentials:\s*Platform\.OS\s*===\s*["']web["']\s*\?\s*["']include["']\s*:\s*undefined/.test(
          code(readFileSync(file, "utf8")),
        ),
      )
      .map(rel)

    expect(offenders).toEqual([])
  })

  test("no native transport module asks for the cookie jar", () => {
    const offenders = AUTHED_FETCH_MODULES.filter((relative) =>
      /credentials:\s*["']include["']/.test(
        code(readFileSync(join(MOBILE, relative), "utf8")),
      ),
    )

    // `credentials: "include"` on native = jar cookies + our Cookie header.
    expect(offenders).toEqual([])
  })

  test("the transport modules go through the shared helper", () => {
    const chatPanel = readFileSync(join(MOBILE, "components/chat/ChatPanel.tsx"), "utf8")
    expect(chatPanel).toContain("authedFetchInit")
    expect(chatPanel).toContain("authedCredentials()")

    const hosts = readFileSync(join(MOBILE, "hooks/useWorkspaceHosts.ts"), "utf8")
    expect(hosts).toContain("agentFetch(`${API_URL}/api/machines`)")

    const stop = readFileSync(join(MOBILE, "lib/chat-stop.ts"), "utf8")
    // Both builders — stop and the per-subagent cancel — must omit on native.
    expect(stop.match(/init\.credentials = 'omit'/g)).toHaveLength(2)
  })
})
