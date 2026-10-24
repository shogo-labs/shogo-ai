// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Guards the nativewind pins (exact 4.2.2 in apps/mobile + the root
// `overrides` entry for react-native-css-interop).
//
// Why: a non-frozen `bun install` used to float nativewind from 4.2.2 to
// 4.2.7, which drags in react-native-css-interop 0.2.7. That version's
// `babel.js` asks Babel for `react-native-reanimated/plugin`, and reanimated
// is deliberately absent (stubbed in metro.config.js, excluded from
// autolinking), so config resolution throws and *every* Expo web bundle
// answers HTTP 500 — the symptom was Playwright local specs timing out in
// e2e/local/global-setup.ts. The drift also silently dropped our css-interop
// patch (aspect-ratio / colorScheme / doctor fixes).

import { describe, expect, test } from 'bun:test'
import { loadOptions } from '@babel/core'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const mobileDir = fileURLToPath(new URL('../..', import.meta.url))
const repoRoot = join(mobileDir, '..', '..')

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function installedPackage(pkg: string): {
  version: string
  dependencies?: Record<string, string>
} {
  return readJson(join(mobileDir, 'node_modules', pkg, 'package.json')) as {
    version: string
    dependencies?: Record<string, string>
  }
}

function installedVersion(pkg: string): string {
  return installedPackage(pkg).version
}

describe('nativewind / css-interop pins', () => {
  test('nativewind is pinned to 4.2.2', () => {
    expect(readJson(join(mobileDir, 'package.json')).dependencies).toMatchObject({
      nativewind: '4.2.2',
    })
    expect(installedVersion('nativewind')).toBe('4.2.2')
  })

  test('no other css-interop version can be installed', () => {
    expect(installedVersion('react-native-css-interop')).toBe('0.2.2')
    // The copy of nativewind we load must ask for the patched version exactly,
    // not a range that can float to an unpatched 0.2.7.
    expect(installedPackage('nativewind').dependencies).toMatchObject({
      'react-native-css-interop': '0.2.2',
    })
    // A future nativewind release must not be able to drag in a second copy.
    expect(readJson(join(repoRoot, 'package.json')).overrides).toMatchObject({
      'react-native-css-interop': '0.2.2',
    })
  })

  test('the css-interop patch is applied', () => {
    const parseDeclaration = readFileSync(
      join(mobileDir, 'node_modules/react-native-css-interop/dist/css-to-rn/parseDeclaration.js'),
      'utf8',
    )
    expect(parseDeclaration).toContain('!aspectRatio || aspectRatio.auto || !aspectRatio.ratio')
  })
})

describe('mobile babel config', () => {
  // `loadOptions` resolves presets and plugins eagerly, the way Metro does: a
  // preset naming a missing plugin throws here with
  // "Cannot find module 'react-native-reanimated/plugin'".
  test('resolves for a metro web bundle', () => {
    const options = loadOptions({
      filename: join(mobileDir, 'index.js'),
      cwd: mobileDir,
      caller: { name: 'metro', bundler: 'metro', platform: 'web', supportsStaticESM: true },
    })
    const keys = (options.plugins ?? []).map((plugin) => plugin.key)

    // nativewind/babel loaded, and the worklets plugin it names resolved.
    expect(keys).toContain('react-native-css-interop-imports')
    expect(keys).toContain('worklets')
  })
})
