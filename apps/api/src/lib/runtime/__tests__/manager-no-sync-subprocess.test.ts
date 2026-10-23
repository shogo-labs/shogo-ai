// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-185 — no synchronous subprocess on the runtime manager's request path.
 *
 * The desktop's tunnel runs in the same process as its local API, so a blocking
 * `execSync('lsof …')` there froze `/health` as well. Three missed probes and the
 * desktop supervisor killed the API mid-request, which the cloud saw as the
 * tunnel dropping with 1006; in-flight relays then timed out and evicted a live
 * tunnel's owner.
 *
 * `isPortListening` runs up to 50×3 times on one `allocatePortAsync`, so this
 * guard pins the one function that made it cheap to regress.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

const MANAGER_SOURCE = readFileSync(join(import.meta.dir, '..', 'manager.ts'), 'utf8')

function functionBody(name: string): string {
  const start = MANAGER_SOURCE.indexOf(`${name}(`)
  if (start < 0) throw new Error(`${name} not found in manager.ts`)
  // Walk braces so nested blocks don't cut the body short.
  const open = MANAGER_SOURCE.indexOf('{', start)
  let depth = 0
  for (let i = open; i < MANAGER_SOURCE.length; i++) {
    if (MANAGER_SOURCE[i] === '{') depth++
    else if (MANAGER_SOURCE[i] === '}') {
      depth--
      if (depth === 0) return MANAGER_SOURCE.slice(open, i + 1)
    }
  }
  throw new Error(`${name} body did not close`)
}

describe('runtime manager hot paths', () => {
  test('isPortListening never shells out', () => {
    const body = functionBody('isPortListening')
    expect(body).not.toMatch(/execSync|spawnSync|execFileSync/)
    // It probes the socket directly instead.
    expect(body).toMatch(/connect\(/)
  })
})
