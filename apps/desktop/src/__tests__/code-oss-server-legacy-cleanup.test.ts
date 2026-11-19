// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanupLegacyCodeOss, legacyCodeOssPaths } from '../code-oss-server/legacy-cleanup'

const scratch = mkdtempSync(join(tmpdir(), 'shogo-legacy-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))
const DIR_LINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir'

describe('cleanupLegacyCodeOss', () => {
  test('removes every leftover of the old clone-and-build setup', () => {
    const tempDir = join(scratch, 'temp')
    const homeDir = join(scratch, 'home')
    const dataDir = join(scratch, 'data')
    const checkout = join(tempDir, 'shogo-codeoss-checkouts', '9f88946d7178', 'vscode')
    mkdirSync(checkout, { recursive: true })
    writeFileSync(join(checkout, 'package.json'), '{}')
    mkdirSync(join(homeDir, '.shogo', 'code-oss', 'abc', 'vscode'), { recursive: true })
    mkdirSync(join(dataDir, 'shogo-ide', 'upstream', 'vscode'), { recursive: true })
    mkdirSync(join(dataDir, 'shogo-ide', 'hardening', 'runtime-shogo-ide', 'proj-123', 'system-extensions'), { recursive: true })
    // The old no-space install path was a link into the checkout: remove the
    // link, never what it points at.
    const linkTarget = join(scratch, 'must-survive')
    mkdirSync(linkTarget, { recursive: true })
    writeFileSync(join(linkTarget, 'keep.txt'), 'x')
    symlinkSync(linkTarget, join(tempDir, 'shogo-codeoss-0123abcd'), DIR_LINK_TYPE)
    // Unrelated neighbours stay.
    mkdirSync(join(tempDir, 'shogo-codeoss-notes'), { recursive: true })
    mkdirSync(join(homeDir, '.shogo', 'other'), { recursive: true })
    writeFileSync(join(dataDir, 'shogo-ide', 'keep.json'), '{}')

    const removed = cleanupLegacyCodeOss({ tempDir, homeDir, dataDir })
    expect(removed.sort()).toEqual(
      [
        join(tempDir, 'shogo-codeoss-checkouts'),
        join(tempDir, 'shogo-codeoss-0123abcd'),
        join(homeDir, '.shogo', 'code-oss'),
        join(dataDir, 'shogo-ide', 'upstream'),
        join(dataDir, 'shogo-ide', 'hardening', 'runtime-shogo-ide'),
      ].sort(),
    )
    for (const p of removed) expect(existsSync(p)).toBe(false)
    expect(existsSync(join(linkTarget, 'keep.txt'))).toBe(true)
    expect(existsSync(join(tempDir, 'shogo-codeoss-notes'))).toBe(true)
    expect(existsSync(join(homeDir, '.shogo', 'other'))).toBe(true)
    expect(existsSync(join(dataDir, 'shogo-ide', 'keep.json'))).toBe(true)
  })

  test('tolerates nothing being there', () => {
    const empty = join(scratch, 'empty')
    expect(cleanupLegacyCodeOss({ tempDir: join(empty, 't'), homeDir: join(empty, 'h'), dataDir: join(empty, 'd') })).toEqual([])
    expect(legacyCodeOssPaths({ tempDir: join(empty, 't'), homeDir: join(empty, 'h'), dataDir: join(empty, 'd') })).toHaveLength(4)
  })
})
