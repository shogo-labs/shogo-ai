// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The ignore rules are the difference between moving a 19.5 GB content
 * workspace and moving 4.6 GB of it. These tests pin the defaults (the numbers
 * the plan step reports), the gitignore behaviour people expect from
 * `.shogoignore`, and the one case that is easy to get wrong: a directory rule
 * must not exclude a *file* with the same name.
 */

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compileIgnoreRules, DEFAULT_MOVE_IGNORE_RULES, isMoveIgnored, moveIgnoreRules } from '../ignores'

const defaults = compileIgnoreRules(DEFAULT_MOVE_IGNORE_RULES)

describe('default move ignores', () => {
  test('build output and per-machine directories are skipped', () => {
    for (const path of ['out/render.mp4', '.tmp/scratch.json', 'node_modules/react/index.js', 'dist/app.js', '.shogo/logs/build.log']) {
      expect(isMoveIgnored(path, false, defaults)).toBe(true)
    }
  })

  test('content is not', () => {
    for (const path of ['src/App.tsx', 'posts/2026-10-01.md', 'public/logo.png', 'package.json']) {
      expect(isMoveIgnored(path, false, defaults)).toBe(false)
    }
  })

  test('nested output directories are skipped too', () => {
    expect(isMoveIgnored('projects/x/out/a.mp4', false, defaults)).toBe(true)
  })

  test('a directory-only rule does not exclude a file of the same name', () => {
    expect(isMoveIgnored('out', false, defaults)).toBe(false)
    expect(isMoveIgnored('out', true, defaults)).toBe(true)
  })
})

describe('.shogoignore', () => {
  test('a project can exclude more, and re-include with !', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shogo-ignore-'))
    writeFileSync(
      join(dir, '.shogoignore'),
      ['# big renders we regenerate', 'renders/', '*.psd', '!keep.psd', ''].join('\n'),
    )
    const rules = moveIgnoreRules(dir)
    expect(isMoveIgnored('renders/hero.mp4', false, rules)).toBe(true)
    expect(isMoveIgnored('art/banner.psd', false, rules)).toBe(true)
    expect(isMoveIgnored('art/keep.psd', false, rules)).toBe(false)
    expect(isMoveIgnored('posts/a.md', false, rules)).toBe(false)
  })

  test('an anchored rule only matches from the project root', () => {
    const rules = compileIgnoreRules(['/public/big.bin'])
    expect(isMoveIgnored('public/big.bin', false, rules)).toBe(true)
    expect(isMoveIgnored('nested/public/big.bin', false, rules)).toBe(false)
  })

  test('** crosses directories', () => {
    const rules = compileIgnoreRules(['**/snapshots/**'])
    expect(isMoveIgnored('a/b/snapshots/x/y.png', false, rules)).toBe(true)
    expect(isMoveIgnored('snapshots/top.png', false, rules)).toBe(true)
  })

  test('a broken ignore file cannot stop a move', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shogo-ignore-bad-'))
    writeFileSync(join(dir, '.shogoignore'), '\u0000\n!\n   \n# only a comment\n')
    expect(() => moveIgnoreRules(dir)).not.toThrow()
    expect(isMoveIgnored('src/a.ts', false, moveIgnoreRules(dir))).toBe(false)
  })

  test('a missing ignore file means defaults only', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shogo-ignore-none-'))
    mkdirSync(join(dir, 'src'), { recursive: true })
    expect(moveIgnoreRules(dir)).toHaveLength(DEFAULT_MOVE_IGNORE_RULES.length)
  })
})
