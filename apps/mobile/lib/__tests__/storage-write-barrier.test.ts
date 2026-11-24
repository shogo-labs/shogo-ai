// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `lib/storage.ts` is only a barrier if nothing writes around it (SHO-566).
 *
 * SHOGO-IOS-16 killed the iOS app in `RNCAsyncStorage _writeEntry` because a
 * value that was not a string crossed the JS→native bridge. The library's own
 * JS guard is not enough to rely on: `2.x` throws for `null`/`undefined` but
 * only *warns* for a number, boolean, object or function and hands it to
 * native anyway. So every write in `apps/mobile` goes through the typed helper,
 * and this test fails when a new direct call appears — the check has to be a
 * test, not a convention, because a caller that skips the helper reintroduces
 * a native crash that no JS `try`/`catch` can see.
 */
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

const APP_ROOT = resolve(import.meta.dir, '../..')
const HELPER = join('lib', 'storage.ts')
const PACKAGE = '@react-native-async-storage/async-storage'

const SKIP_DIRS = new Set([
  'node_modules',
  '.expo',
  '__tests__',
  '__mocks__',
  'ios',
  'android',
  'dist',
  'coverage',
  'test',
  'stubs',
])

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      out.push(...sourceFiles(join(dir, entry.name)))
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$|\.spec\.tsx?$/.test(entry.name)) {
      out.push(join(dir, entry.name))
    }
  }
  return out
}

/** Local names bound to the async-storage module by an import in this file. */
function storageBindings(src: string): string[] {
  const names = new Set<string>()
  for (const line of src.split('\n')) {
    if (!line.includes(PACKAGE) || !line.trimStart().startsWith('import ')) continue
    const braces = line.match(/\{([^}]*)\}/)
    if (braces) {
      for (const part of braces[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/).pop()?.trim()
        if (name) names.add(name)
      }
    }
    const def = line.match(/^import\s+(\w+)\s*(?:,|from)/)
    if (def) names.add(def[1])
  }
  return [...names]
}

const rel = (file: string) => relative(APP_ROOT, file).split(sep).join('/')

describe('AsyncStorage write barrier — no direct writes outside lib/storage.ts', () => {
  test('the helper is the only module that calls setItem / multiSet', () => {
    const offenders: string[] = []

    for (const file of sourceFiles(APP_ROOT)) {
      const src = readFileSync(file, 'utf8')
      const isHelper = rel(file) === HELPER.split(sep).join('/')
      const bindings = isHelper ? [] : storageBindings(src)
      for (const name of bindings) {
        const call = new RegExp(`\\b${name}\\s*\\.\\s*(setItem|multiSet)\\s*\\(`)
        if (call.test(src)) offenders.push(`${rel(file)} → ${name}.setItem/multiSet`)
      }
      if (isHelper) continue
      // A file that never imported the package can still spell the global name
      // (a hoisted helper, a copy-paste); catch that too.
      if (/\bAsyncStorage\s*\.\s*(setItem|multiSet)\s*\(/.test(src)) {
        offenders.push(`${rel(file)} → AsyncStorage.setItem/multiSet`)
      }
    }

    expect(offenders).toEqual([])
  })

  test('the scan actually sees the helper calling through', () => {
    // Guards against a vacuous pass: the helper is excluded above, so assert
    // the pattern this test looks for is present where it is allowed.
    const helper = readFileSync(resolve(APP_ROOT, HELPER), 'utf8')
    expect(/\bAsyncStorage\s*\.\s*setItem\s*\(/.test(helper)).toBe(true)
    expect(storageBindings(helper)).toContain('AsyncStorage')
  })
})
