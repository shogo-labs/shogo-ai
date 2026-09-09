// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const CONDITIONAL_SHADOW_CLASS =
  /(?:\?|&&)\s*['"`][^'"`]*\bshadow-(?:sm|md|lg|xl|2xl|hard-\d+)/

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

describe('conditional NativeWind shadow classes', () => {
  test('are not toggled on Pressable/View classNames anywhere in the mobile app', () => {
    const mobileRoot = join(import.meta.dir, '../..')
    const hits: string[] = []
    for (const root of ['app', 'components', 'lib']) {
      for (const file of walkSourceFiles(join(mobileRoot, root))) {
        if (file.endsWith('native-active-shadow.ts')) continue
        const source = readFileSync(file, 'utf8')
        if (CONDITIONAL_SHADOW_CLASS.test(source)) {
          hits.push(file.slice(mobileRoot.length + 1))
        }
      }
    }
    expect(hits).toEqual([])
  })
})
