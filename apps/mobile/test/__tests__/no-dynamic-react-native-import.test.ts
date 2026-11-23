// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `react-native` is only ever imported statically, by name (SHOGO-IOS-15).
 *
 * A dynamic `await import('react-native')` compiles to a wildcard namespace
 * import, and building that namespace reads *every* lazy getter on
 * `react-native/index.js` — including the deprecated `PushNotificationIOS`
 * one, which constructs `new NativeEventEmitter(NativePushNotificationManagerIOS)`.
 * Shogo does not link that native module, so the getter throws
 * "`new NativeEventEmitter()` requires a non-null argument" the first time
 * anything dynamically imports `react-native`, from a frame that has nothing
 * to do with push notifications (the share sheet, an image preview).
 *
 * Importing what you need by name touches only that export. expo modules can
 * still be imported dynamically — this is specific to react-native's lazy
 * getter table.
 */

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const DYNAMIC_REACT_NATIVE = /import\s*\(\s*['"]react-native['"]\s*\)/

/** Blank out comments so prose that quotes the pattern cannot trip the guard. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ''))
    .replace(/^(\s*)\/\/.*$/gm, '')
}

function walkSourceFiles(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '__tests__' || name.startsWith('.')) continue
    const path = join(dir, name)
    const stat = statSync(path)
    if (stat.isDirectory()) {
      walkSourceFiles(path, acc)
      continue
    }
    if (/\.(tsx|ts)$/.test(name) && !/\.(test|spec)\./.test(name)) acc.push(path)
  }
  return acc
}

describe('importing react-native', () => {
  test('never uses a dynamic import, which reads every lazy getter and crashes', () => {
    const mobileRoot = join(import.meta.dir, '../..')
    const hits: string[] = []
    for (const root of ['app', 'components', 'hooks', 'lib']) {
      for (const file of walkSourceFiles(join(mobileRoot, root))) {
        const source = stripComments(readFileSync(file, 'utf8'))
        const line = source.split('\n').findIndex((text) => DYNAMIC_REACT_NATIVE.test(text))
        if (line >= 0) hits.push(`${file.slice(mobileRoot.length + 1)}:${line + 1}`)
      }
    }
    expect(hits).toEqual([])
  })
})
