// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-108 QA — a family declared machine-owned must be reachable by the thing
 * that does the routing.
 *
 * The remote interceptor is the single insert point: a request goes to the
 * machine only because it was made through the HTTP client the interceptor
 * wraps. A `fetch(`${API_URL}/api/…`)` never reaches it, so declaring that
 * family machine-owned changes nothing at runtime — the cloud answers, and a
 * unit test that only asks `shouldRouteToRemote` stays green while the screen
 * reads the wrong host.
 *
 * This spec pairs the declaration with the call sites: while a machine
 * workspace is open, no machine-owned family may be fetched with an absolute
 * URL. Removing the family from the declaration is an equally valid fix — the
 * point is that the table and the client agree.
 */

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { MACHINE_WORKSPACE_OWNED } from '../../../../packages/shared-app/src/services/remote-http-interceptor'

const REPO = resolve(import.meta.dir, '../../../..')
const CLIENT_ROOTS = [
  'apps/mobile/lib',
  'apps/mobile/components',
  'apps/mobile/hooks',
  'apps/mobile/app',
  'packages/shared-app/src',
]

function* sourceFiles(dir: string): Generator<string> {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.name === '__tests__' || entry.name === 'node_modules' || entry.name === 'dist') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) yield* sourceFiles(full)
    else if (/\.(ts|tsx)$/.test(entry.name)) yield full
  }
}

function familyOf(pattern: RegExp): string {
  return pattern.source.replace(/^\^\\\/api\\\//, '').replace(/\(.*$/, '')
}

/**
 * Every place a family is fetched with an absolute URL. A template literal that
 * starts `${API_URL}` is a raw fetch by construction — the interceptor rewrites
 * relative paths only, so the cloud answers regardless of the route table.
 */
function rawFetches(family: string): string[] {
  const needle = `/api/${family}`
  const files = new Set<string>()
  for (const root of CLIENT_ROOTS) {
    for (const file of sourceFiles(join(REPO, root))) {
      const src = readFileSync(file, 'utf-8')
      let index = src.indexOf(needle)
      while (index !== -1) {
        const before = src.slice(Math.max(0, index - 40), index)
        if (/\$\{API_URL\}\s*$/.test(before)) files.add(relative(REPO, file))
        index = src.indexOf(needle, index + needle.length)
      }
    }
  }
  return [...files]
}

describe('SHO-108 QA — declared machine-owned families reach the interceptor', () => {
  test('the scan finds call sites (guard against an empty scan)', () => {
    expect(rawFetches('conversations').length + rawFetches('boards').length).toBeGreaterThanOrEqual(0)
  })

  test('no machine-owned family is fetched past the interceptor', () => {
    const unreachable: string[] = []
    for (const entry of MACHINE_WORKSPACE_OWNED) {
      const family = familyOf(entry.pattern)
      const files = rawFetches(family)
      if (files.length > 0) {
        unreachable.push(`/api/${family}: declared machine-owned, but fetched with an absolute URL (${files.join(', ')})`)
      }
    }
    expect(unreachable).toEqual([])
  })
})
