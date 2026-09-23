// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for anchor-member seeding in workspace runtimes: a brand-new anchor
 * project's `<WORKSPACE_DIR>/<id>/` must get the starter template (so the
 * anchor preview has a package.json to build), and a folder with real content
 * — or one whose durable source could not be confirmed absent — must never be
 * seeded.
 *
 * Run: bun test packages/agent-runtime/src/__tests__/workspace-member-seed.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  memberHasProjectSource,
  resolveMemberTechStackId,
  seedEmptyWorkspaceMember,
  shouldSeedAnchorMember,
} from '../workspace-member-seed'

let root: string
let templateDir: string
let savedTemplateEnv: string | undefined

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'member-seed-'))
  templateDir = join(root, 'runtime-template')
  mkdirSync(join(templateDir, 'src'), { recursive: true })
  writeFileSync(join(templateDir, 'package.json'), JSON.stringify({ name: 'template', dependencies: { vite: '*' } }))
  writeFileSync(join(templateDir, 'index.html'), '<div id="root"></div>')
  writeFileSync(join(templateDir, 'src', 'App.tsx'), 'export default () => null')
  savedTemplateEnv = process.env.RUNTIME_TEMPLATE_DIR
  process.env.RUNTIME_TEMPLATE_DIR = templateDir
})

afterEach(() => {
  if (savedTemplateEnv === undefined) delete process.env.RUNTIME_TEMPLATE_DIR
  else process.env.RUNTIME_TEMPLATE_DIR = savedTemplateEnv
  rmSync(root, { recursive: true, force: true })
})

describe('memberHasProjectSource', () => {
  test('missing and empty folders have no source', () => {
    expect(memberHasProjectSource(join(root, 'nope'))).toBe(false)
    const dir = join(root, 'empty')
    mkdirSync(dir)
    expect(memberHasProjectSource(dir)).toBe(false)
  })

  test('bookkeeping entries alone are not source', () => {
    const dir = join(root, 'bookkeeping')
    mkdirSync(join(dir, '.git'), { recursive: true })
    mkdirSync(join(dir, '.shogo'), { recursive: true })
    mkdirSync(join(dir, 'node_modules'), { recursive: true })
    expect(memberHasProjectSource(dir)).toBe(false)
  })

  test('any real file counts as source', () => {
    const dir = join(root, 'real')
    mkdirSync(dir)
    writeFileSync(join(dir, 'README.md'), 'hi')
    expect(memberHasProjectSource(dir)).toBe(true)
  })
})

describe('seedEmptyWorkspaceMember', () => {
  test('seeds the runtime template into an empty member folder (default stack)', () => {
    const dir = join(root, 'ws', 'anchor')
    const result = seedEmptyWorkspaceMember(dir)
    expect(result.seeded).toBe(true)
    expect(existsSync(join(dir, 'package.json'))).toBe(true)
    expect(existsSync(join(dir, 'src', 'App.tsx'))).toBe(true)
  })

  test('seeds a vite stack with the template and the stack marker', () => {
    const dir = join(root, 'ws', 'anchor')
    const result = seedEmptyWorkspaceMember(dir, 'react-app')
    expect(result).toEqual({ seeded: true, techStackId: 'react-app' })
    expect(existsSync(join(dir, 'package.json'))).toBe(true)
    expect(readFileSync(join(dir, '.tech-stack'), 'utf-8')).toBe('react-app')
  })

  test('seeds a non-vite stack without the vite runtime template', () => {
    const dir = join(root, 'ws', 'anchor')
    const result = seedEmptyWorkspaceMember(dir, 'python-data')
    expect(result.seeded).toBe(true)
    expect(readFileSync(join(dir, '.tech-stack'), 'utf-8')).toBe('python-data')
    expect(existsSync(join(dir, 'index.html'))).toBe(false)
  })

  test('never touches a folder that already has project source', () => {
    const dir = join(root, 'ws', 'anchor')
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'src', 'App.tsx'), 'USER CODE')
    const result = seedEmptyWorkspaceMember(dir, 'react-app')
    expect(result.seeded).toBe(false)
    expect(readFileSync(join(dir, 'src', 'App.tsx'), 'utf-8')).toBe('USER CODE')
    expect(existsSync(join(dir, 'package.json'))).toBe(false)
    expect(existsSync(join(dir, '.tech-stack'))).toBe(false)
  })

  test('seeds a folder that only has a .git directory', () => {
    const dir = join(root, 'ws', 'anchor')
    mkdirSync(join(dir, '.git'), { recursive: true })
    expect(seedEmptyWorkspaceMember(dir).seeded).toBe(true)
    expect(existsSync(join(dir, 'package.json'))).toBe(true)
  })

  test('reports not seeded when no template is available', () => {
    process.env.RUNTIME_TEMPLATE_DIR = join(root, 'missing-template')
    const dir = join(root, 'ws', 'anchor')
    expect(seedEmptyWorkspaceMember(dir).seeded).toBe(false)
  })
})

describe('resolveMemberTechStackId', () => {
  test('reads the project entry from the JSON map', () => {
    const raw = JSON.stringify({ a: 'expo-app', b: 'react-app' })
    expect(resolveMemberTechStackId('a', raw)).toBe('expo-app')
    expect(resolveMemberTechStackId('b', raw)).toBe('react-app')
  })

  test('missing, blank, non-string, or malformed values are undefined', () => {
    expect(resolveMemberTechStackId('a', undefined)).toBeUndefined()
    expect(resolveMemberTechStackId('a', '')).toBeUndefined()
    expect(resolveMemberTechStackId('a', '{not json')).toBeUndefined()
    expect(resolveMemberTechStackId('a', JSON.stringify({ a: '  ' }))).toBeUndefined()
    expect(resolveMemberTechStackId('a', JSON.stringify({ a: 7 }))).toBeUndefined()
    expect(resolveMemberTechStackId('a', JSON.stringify({ b: 'react-app' }))).toBeUndefined()
    expect(resolveMemberTechStackId('a', 'null')).toBeUndefined()
  })
})

describe('shouldSeedAnchorMember', () => {
  const base = {
    anchorProjectId: 'anchor',
    memberProjectIds: ['anchor', 'other'],
    hostMediatedDurability: false,
    newProjectIds: [] as string[],
  }

  test('seeds a confirmed-new anchor', () => {
    expect(shouldSeedAnchorMember({ ...base, newProjectIds: ['anchor'] })).toBe(true)
  })

  test('seeds under host-mediated durability (host overlays any backup afterwards)', () => {
    expect(shouldSeedAnchorMember({ ...base, hostMediatedDurability: true })).toBe(true)
  })

  test('does not seed when the anchor download failed, was skipped, or found content', () => {
    expect(shouldSeedAnchorMember(base)).toBe(false)
    expect(shouldSeedAnchorMember({ ...base, newProjectIds: ['other'] })).toBe(false)
  })

  test('requires an explicit anchor that is one of the members', () => {
    expect(shouldSeedAnchorMember({ ...base, anchorProjectId: undefined, hostMediatedDurability: true })).toBe(false)
    expect(shouldSeedAnchorMember({ ...base, anchorProjectId: '  ', hostMediatedDurability: true })).toBe(false)
    expect(
      shouldSeedAnchorMember({ ...base, anchorProjectId: 'stranger', hostMediatedDurability: true, newProjectIds: ['stranger'] }),
    ).toBe(false)
  })
})
