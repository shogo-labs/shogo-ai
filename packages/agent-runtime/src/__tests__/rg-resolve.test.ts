// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { afterEach, describe, test, expect } from 'bun:test'
import { existsSync } from 'fs'
import { delimiter } from 'path'
import { _rgResolveSeamForTests, prependRgToPath, resolveRgPath } from '../rg-resolve'

describe('resolveRgPath', () => {
  // Snapshot the seam defaults once so we can restore them after each
  // test that mutates them — keeps the public tests below order-independent.
  const defaultRequire = _rgResolveSeamForTests.require
  const defaultExistsSync = _rgResolveSeamForTests.existsSync

  afterEach(() => {
    _rgResolveSeamForTests.require = defaultRequire
    _rgResolveSeamForTests.existsSync = defaultExistsSync
    _rgResolveSeamForTests.reset()
  })

  test('returns a non-empty string', () => {
    const rg = resolveRgPath()
    expect(typeof rg).toBe('string')
    expect(rg.length).toBeGreaterThan(0)
  })

  test('resolves to a real file from @vscode/ripgrep', () => {
    const rg = resolveRgPath()
    // If @vscode/ripgrep is installed, the path should point to an actual binary
    if (rg !== 'rg') {
      expect(existsSync(rg)).toBe(true)
    }
  })

  test('resolved path contains rg in its name', () => {
    const rg = resolveRgPath()
    const lower = rg.toLowerCase()
    expect(lower).toContain('rg')
  })

  test('returns the same value on subsequent calls (cached)', () => {
    const first = resolveRgPath()
    const second = resolveRgPath()
    expect(first).toBe(second)
  })

  test('falls back to "rg" when require(@vscode/ripgrep) throws (catch arm)', () => {
    // Covers the \`} catch { /* package not installed */ }\` arm + the
    // \`_resolved = "rg"\` fallback at the bottom of the function.
    _rgResolveSeamForTests.reset()
    _rgResolveSeamForTests.require = () => {
      throw new Error("Cannot find module '@vscode/ripgrep'")
    }
    expect(resolveRgPath()).toBe('rg')
  })

  test('falls back to "rg" when the bundled binary path does not exist on disk', () => {
    // Covers the if-false path through the try block — require returns a
    // path, existsSync(path) is false → execution reaches the closing
    // brace and falls into the \`_resolved = "rg"\` fallback.
    _rgResolveSeamForTests.reset()
    _rgResolveSeamForTests.require = () => ({ rgPath: '/nonexistent/ripgrep' })
    _rgResolveSeamForTests.existsSync = () => false
    expect(resolveRgPath()).toBe('rg')
  })

  test('reset() clears the module-private cache so the next call re-resolves', () => {
    const first = resolveRgPath()
    _rgResolveSeamForTests.require = () => {
      throw new Error('forced miss')
    }
    // Without reset(), the cached value would be returned and the catch
    // path would not re-run; with reset() the next call re-enters the try.
    expect(resolveRgPath()).toBe(first)
    _rgResolveSeamForTests.reset()
    expect(resolveRgPath()).toBe('rg')
  })

  describe('SHOGO_RG_PATH (desktop: compiled runtime ships rg next to it)', () => {
    const saved = process.env.SHOGO_RG_PATH
    afterEach(() => {
      if (saved === undefined) delete process.env.SHOGO_RG_PATH
      else process.env.SHOGO_RG_PATH = saved
    })

    test('wins over @vscode/ripgrep when the file exists', () => {
      _rgResolveSeamForTests.reset()
      process.env.SHOGO_RG_PATH = '/app/resources/bin/rg'
      _rgResolveSeamForTests.existsSync = (p) => p === '/app/resources/bin/rg'
      _rgResolveSeamForTests.require = () => ({ rgPath: '/node_modules/@vscode/ripgrep/bin/rg' })
      expect(resolveRgPath()).toBe('/app/resources/bin/rg')
    })

    test('is ignored when the file is missing', () => {
      _rgResolveSeamForTests.reset()
      process.env.SHOGO_RG_PATH = '/missing/rg'
      _rgResolveSeamForTests.existsSync = (p) => p === '/node_modules/@vscode/ripgrep/bin/rg'
      _rgResolveSeamForTests.require = () => ({ rgPath: '/node_modules/@vscode/ripgrep/bin/rg' })
      expect(resolveRgPath()).toBe('/node_modules/@vscode/ripgrep/bin/rg')
    })
  })

  describe('prependRgToPath', () => {
    const useRg = (rgPath: string) => {
      _rgResolveSeamForTests.reset()
      _rgResolveSeamForTests.existsSync = (p) => p === rgPath
      _rgResolveSeamForTests.require = () => ({ rgPath })
    }

    test('puts the resolved rg directory first, once', () => {
      useRg('/app/resources/ripgrep/rg')
      const env: NodeJS.ProcessEnv = { PATH: `/usr/bin${delimiter}/bin` }
      prependRgToPath(env)
      prependRgToPath(env)
      expect(env.PATH).toBe(`/app/resources/ripgrep${delimiter}/usr/bin${delimiter}/bin`)
    })

    test('keeps the existing key casing (Windows `Path`)', () => {
      useRg('/app/resources/ripgrep/rg')
      const env: NodeJS.ProcessEnv = { Path: '/usr/bin' }
      prependRgToPath(env)
      expect(env.Path).toBe(`/app/resources/ripgrep${delimiter}/usr/bin`)
      expect(env.PATH).toBeUndefined()
    })

    test('leaves PATH alone when only a bare rg was found', () => {
      _rgResolveSeamForTests.reset()
      _rgResolveSeamForTests.require = () => { throw new Error('missing') }
      const env: NodeJS.ProcessEnv = { PATH: '/usr/bin' }
      prependRgToPath(env)
      expect(env.PATH).toBe('/usr/bin')
    })
  })
})
