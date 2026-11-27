// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * "Save for later" is only useful if the saved list can be found.
 *
 * The wide sidebar's Home panel listed Later, but the phone drawer — the only
 * sidebar a phone gets — did not, so a message saved on a phone went nowhere
 * visible. Every sidebar that can save has to offer the list, and the save
 * action itself has to say where the message went.
 *
 * A source guard, like the SHO-108 switcher test: mounting the drawer pulls in
 * the whole native module graph, and what is being protected here is "this
 * surface renders the link at all", which the source states directly.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const mobileRoot = join(import.meta.dir, '..', '..', '..', '..')

function source(...parts: string[]): string {
  return readFileSync(join(mobileRoot, ...parts), 'utf8')
}

const SURFACES: Array<[string, string[]]> = [
  ['the wide sidebar Home panel', ['components', 'layout', 'sidebar', 'TabPanels.tsx']],
  ['the phone drawer', ['components', 'layout', 'sidebar', 'AppSidebar.tsx']],
]

describe('Later is reachable from every sidebar', () => {
  for (const [name, path] of SURFACES) {
    test(`${name} links to the Later screen`, () => {
      const file = source(...path)
      expect(file).toMatch(/label="Later"/)
      expect(file).toContain('/(app)/c/later')
      expect(file).toContain('useSavedCount')
    })
  }

  test('the Later screen is still a route', () => {
    const file = source('app', '(app)', 'c', 'later.tsx')
    expect(file).toContain("'saved' | 'reminders' | 'scheduled'")
  })

  test('saving a message points at the list', () => {
    const file = source('components', 'team-chat', 'MessageRow.tsx')
    expect(file).toContain('toast.show(')
    expect(file).toContain('/(app)/c/later')
  })
})
