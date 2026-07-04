// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const testDir = dirname(fileURLToPath(import.meta.url))

declare function describe(name: string, fn: () => void): void
declare function test(name: string, fn: () => void | Promise<void>): void
declare function expect(actual: unknown): { toContain(expected: string): void }

describe('web html shell translation guard', () => {
  test('opts the React root out of browser translation', () => {
    const htmlSource = readFileSync(resolve(testDir, '../../app/+html.tsx'), 'utf8')
    const postExportSource = readFileSync(resolve(testDir, '../../scripts/inject-analytics.js'), 'utf8')

    expect(htmlSource).toContain('<html lang="en" translate="no" className="notranslate">')
    expect(htmlSource).toContain('<meta name="google" content="notranslate" />')
    expect(postExportSource).toContain('translate="no"')
    expect(postExportSource).toContain('notranslate')
    expect(postExportSource).toContain('name="google" content="notranslate"')
  })
})
