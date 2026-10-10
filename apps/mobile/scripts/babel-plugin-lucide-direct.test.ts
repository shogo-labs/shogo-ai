// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import { createRequire } from 'node:module'
import { readdirSync } from 'node:fs'
import path from 'node:path'
import plugin, { loadIconMap } from './babel-plugin-lucide-direct.js'

// @babel/core is a transitive Expo dependency, stored by Bun but not hoisted
// to the workspace root. Resolve it from the store so this test stays a unit test.
function transformSync(source: string, options: { plugins: unknown[]; babelrc: boolean; configFile: boolean }) {
  const store = path.resolve(__dirname, '../../../node_modules/.bun')
  const dir = readdirSync(store).find((name) => name.startsWith('@babel+core@'))
  if (!dir) throw new Error('@babel/core is not installed in the bun store')
  const corePkg = path.join(store, dir, 'node_modules/@babel/core/package.json')
  const babel = createRequire(corePkg)('@babel/core') as {
    transformSync: (code: string, opts: typeof options) => { code?: string } | null
  }
  return babel.transformSync(source, options)
}

describe('babel-plugin-lucide-direct', () => {
  test('maps alias exports onto icon files', () => {
    const map = loadIconMap()
    expect(map.get('Code2')).toBe('code-xml.js')
    expect(map.get('Grid3X3')).toBe('grid-3x3.js')
    expect(map.get('Grid3x3')).toBe('grid-3x3.js')
  })

  test('rewrites named imports and leaves namespace imports', () => {
    const source = `
      import { Code2 as Code, X } from 'lucide-react-native'
      import * as Lucide from 'lucide-react-native'
      export const icons = { Code, X, Lucide }
    `
    const out = transformSync(source, { plugins: [plugin], babelrc: false, configFile: false })
    expect(out?.code).toContain("lucide-react-native/dist/esm/icons/code-xml.js")
    expect(out?.code).toContain("lucide-react-native/dist/esm/icons/x.js")
    expect(out?.code).toContain("import * as Lucide from 'lucide-react-native'")
    expect(out?.code).toContain('cssInterop(')
    expect(out?.code).not.toContain("import { Code2 as Code, X }")
  })
})
