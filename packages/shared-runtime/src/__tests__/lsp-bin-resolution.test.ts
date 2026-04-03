// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { resolveBin } from '../lsp-service'

const TMP = join(process.env.TEMP ?? process.env.TMPDIR ?? '/tmp', 'test-lsp-bin-resolution')
const IS_WINDOWS = process.platform === 'win32'

function touch(path: string) {
  writeFileSync(path, '', 'utf-8')
}

describe('resolveBin', () => {
  beforeEach(() => {
    rmSync(TMP, { recursive: true, force: true })
  })

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true })
  })

  test('finds extensionless binary in .bin/ (POSIX)', () => {
    const dir = join(TMP, 'pkg-a')
    mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true })
    touch(join(dir, 'node_modules', '.bin', 'typescript-language-server'))

    const result = resolveBin('typescript-language-server', [dir])
    expect(result).toBeTruthy()
    expect(result!.resolved).toBe(join(dir, 'node_modules', '.bin', 'typescript-language-server'))
    expect(result!.viaBun).toBe(false)
  })

  if (IS_WINDOWS) {
    test('finds .exe shim in .bin/ on Windows', () => {
      const dir = join(TMP, 'pkg-b')
      mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true })
      touch(join(dir, 'node_modules', '.bin', 'typescript-language-server.exe'))

      const result = resolveBin('typescript-language-server', [dir])
      expect(result).toBeTruthy()
      expect(result!.resolved).toBe(join(dir, 'node_modules', '.bin', 'typescript-language-server.exe'))
      expect(result!.viaBun).toBe(false)
    })

    test('finds .cmd shim in .bin/ on Windows', () => {
      const dir = join(TMP, 'pkg-c')
      mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true })
      touch(join(dir, 'node_modules', '.bin', 'typescript-language-server.cmd'))

      const result = resolveBin('typescript-language-server', [dir])
      expect(result).toBeTruthy()
      expect(result!.resolved).toBe(join(dir, 'node_modules', '.bin', 'typescript-language-server.cmd'))
      expect(result!.viaBun).toBe(false)
    })

    test('prefers extensionless over .exe when both exist', () => {
      const dir = join(TMP, 'pkg-d')
      mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true })
      touch(join(dir, 'node_modules', '.bin', 'typescript-language-server'))
      touch(join(dir, 'node_modules', '.bin', 'typescript-language-server.exe'))

      const result = resolveBin('typescript-language-server', [dir])
      expect(result).toBeTruthy()
      expect(result!.resolved).toBe(join(dir, 'node_modules', '.bin', 'typescript-language-server'))
    })
  }

  test('falls back to direct module entry point when .bin/ has no match', () => {
    const dir = join(TMP, 'pkg-e')
    mkdirSync(join(dir, 'node_modules', 'typescript-language-server', 'lib'), { recursive: true })
    touch(join(dir, 'node_modules', 'typescript-language-server', 'lib', 'cli.mjs'))

    const result = resolveBin('typescript-language-server', [dir], 'lib/cli.mjs')
    expect(result).toBeTruthy()
    expect(result!.resolved).toBe(
      join(dir, 'node_modules', 'typescript-language-server', 'lib', 'cli.mjs'),
    )
    expect(result!.viaBun).toBe(true)
  })

  test('searches multiple directories in order', () => {
    const dirA = join(TMP, 'search-a')
    const dirB = join(TMP, 'search-b')
    mkdirSync(join(dirA, 'node_modules', '.bin'), { recursive: true })
    mkdirSync(join(dirB, 'node_modules', '.bin'), { recursive: true })
    touch(join(dirB, 'node_modules', '.bin', 'pyright'))

    const result = resolveBin('pyright', [dirA, dirB])
    expect(result).toBeTruthy()
    expect(result!.resolved).toBe(join(dirB, 'node_modules', '.bin', 'pyright'))
  })

  test('first directory wins when both have the binary', () => {
    const dirA = join(TMP, 'first-a')
    const dirB = join(TMP, 'first-b')
    mkdirSync(join(dirA, 'node_modules', '.bin'), { recursive: true })
    mkdirSync(join(dirB, 'node_modules', '.bin'), { recursive: true })
    touch(join(dirA, 'node_modules', '.bin', 'pyright'))
    touch(join(dirB, 'node_modules', '.bin', 'pyright'))

    const result = resolveBin('pyright', [dirA, dirB])
    expect(result).toBeTruthy()
    expect(result!.resolved).toBe(join(dirA, 'node_modules', '.bin', 'pyright'))
  })

  test('returns undefined when nothing found and no directEntryPath', () => {
    const dir = join(TMP, 'empty')
    mkdirSync(dir, { recursive: true })

    const result = resolveBin('nonexistent-server', [dir])
    expect(result).toBeUndefined()
  })

  test('returns undefined when nothing found even with directEntryPath', () => {
    const dir = join(TMP, 'empty2')
    mkdirSync(dir, { recursive: true })

    const result = resolveBin('nonexistent-server', [dir], 'lib/cli.mjs')
    expect(result).toBeUndefined()
  })

  test('does not accept bare name without filesystem check', () => {
    const dir = join(TMP, 'no-bare')
    mkdirSync(dir, { recursive: true })

    const result = resolveBin('typescript-language-server', [dir])
    expect(result).toBeUndefined()
  })
})
