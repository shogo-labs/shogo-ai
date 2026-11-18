// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Every link the app hands to the OS goes through `openExternalLink` (SHO-436).
 *
 * A bare `Linking.openURL` rejects with nobody listening, and on Android that
 * rejection is a native crash report: `Could not open URL 'data:…'` for a
 * `data:` URL, `ActivityNotFoundException` for a `tel:` on a device with no
 * dialer. The helper catches both and tells the person, so a new call site must
 * not go around it.
 */

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const DIRECT_OPEN = /\bLinking\.openURL\s*\(/

function walkSourceFiles(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '__tests__' || name.startsWith('.')) continue
    const path = join(dir, name)
    const stat = statSync(path)
    if (stat.isDirectory()) {
      walkSourceFiles(path, acc)
      continue
    }
    if (/\.(tsx|ts)$/.test(name) && !name.includes('.test.')) acc.push(path)
  }
  return acc
}

describe('opening a link outside the app', () => {
  test('never calls Linking.openURL directly', () => {
    const mobileRoot = join(import.meta.dir, '../..')
    const hits: string[] = []
    for (const root of ['app', 'components', 'lib']) {
      for (const file of walkSourceFiles(join(mobileRoot, root))) {
        // The helper is the one place allowed to call it.
        if (file.endsWith(join('lib', 'open-external-link.ts'))) continue
        if (DIRECT_OPEN.test(readFileSync(file, 'utf8'))) {
          hits.push(file.slice(mobileRoot.length + 1))
        }
      }
    }
    expect(hits).toEqual([])
  })
})
