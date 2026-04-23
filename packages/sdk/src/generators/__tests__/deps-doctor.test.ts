// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for deps-doctor.
 *
 * Run: bun test packages/sdk/src/generators/__tests__/deps-doctor.test.ts
 */

import { describe, expect, test, beforeEach } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { resolve } from 'path'

import { ensureFeatureDeps, FEATURE_DEPS } from '../deps-doctor'

let workDir: string

function writePkg(cwd: string, pkg: Record<string, unknown>) {
  writeFileSync(resolve(cwd, 'package.json'), JSON.stringify(pkg, null, 2) + '\n')
}

function readPkg(cwd: string): any {
  return JSON.parse(readFileSync(resolve(cwd, 'package.json'), 'utf-8'))
}

beforeEach(() => {
  workDir = mkdtempSync(resolve(tmpdir(), 'shogo-deps-doctor-'))
})

describe('ensureFeatureDeps', () => {
  test('no features → no modifications', () => {
    writePkg(workDir, { name: 'test', dependencies: { foo: '^1.0.0' } })
    const report = ensureFeatureDeps({ cwd: workDir, features: undefined })
    expect(report.modified).toBe(false)
    expect(report.added).toEqual({})
    expect(readPkg(workDir).dependencies).toEqual({ foo: '^1.0.0' })
  })

  test('voice feature enabled + missing deps → adds them and reports', () => {
    writePkg(workDir, { name: 'test', dependencies: { react: '^19.0.0' } })
    const report = ensureFeatureDeps({
      cwd: workDir,
      features: { voice: true },
    })
    expect(report.modified).toBe(true)
    expect(report.added['@elevenlabs/react']).toBeDefined()
    expect(report.added['@elevenlabs/client']).toBeDefined()
    const pkg = readPkg(workDir)
    expect(pkg.dependencies['@elevenlabs/react']).toBe(FEATURE_DEPS.voice!['@elevenlabs/react'])
    expect(pkg.dependencies['@elevenlabs/client']).toBe(FEATURE_DEPS.voice!['@elevenlabs/client'])
    // Existing deps preserved.
    expect(pkg.dependencies.react).toBe('^19.0.0')
  })

  test('voice feature (object form) enabled → same treatment', () => {
    writePkg(workDir, { name: 'test', dependencies: {} })
    const report = ensureFeatureDeps({
      cwd: workDir,
      features: { voice: { phoneNumber: true } },
    })
    expect(report.modified).toBe(true)
    expect(Object.keys(report.added)).toContain('@elevenlabs/react')
  })

  test('voice feature: deps already present → idempotent (no modification)', () => {
    writePkg(workDir, {
      name: 'test',
      dependencies: {
        '@elevenlabs/react': '^0.10.0',
        '@elevenlabs/client': '^0.10.0',
      },
    })
    const before = readFileSync(resolve(workDir, 'package.json'), 'utf-8')
    const report = ensureFeatureDeps({
      cwd: workDir,
      features: { voice: true },
    })
    expect(report.modified).toBe(false)
    expect(report.added).toEqual({})
    const after = readFileSync(resolve(workDir, 'package.json'), 'utf-8')
    expect(after).toBe(before)
  })

  test('dryRun: reports what would change but does not write', () => {
    writePkg(workDir, { name: 'test', dependencies: {} })
    const before = readFileSync(resolve(workDir, 'package.json'), 'utf-8')
    const report = ensureFeatureDeps({
      cwd: workDir,
      features: { voice: true },
      dryRun: true,
    })
    expect(report.modified).toBe(true)
    expect(Object.keys(report.added).length).toBeGreaterThan(0)
    const after = readFileSync(resolve(workDir, 'package.json'), 'utf-8')
    expect(after).toBe(before)
  })

  test('missing package.json → warn, do not throw', () => {
    const emptyDir = mkdtempSync(resolve(tmpdir(), 'shogo-deps-doctor-empty-'))
    const report = ensureFeatureDeps({
      cwd: emptyDir,
      features: { voice: true },
    })
    expect(report.modified).toBe(false)
    expect(report.warnings.length).toBeGreaterThan(0)
    rmSync(emptyDir, { recursive: true, force: true })
  })

  test('invalid JSON → warn, do not throw', () => {
    writeFileSync(resolve(workDir, 'package.json'), '{ this is not JSON')
    const report = ensureFeatureDeps({
      cwd: workDir,
      features: { voice: true },
    })
    expect(report.modified).toBe(false)
    expect(report.warnings.length).toBeGreaterThan(0)
  })

  test('voice disabled → dependencies NOT removed (safety)', () => {
    writePkg(workDir, {
      name: 'test',
      dependencies: { '@elevenlabs/react': '^0.10.0' },
    })
    const report = ensureFeatureDeps({
      cwd: workDir,
      features: { voice: false as any },
    })
    expect(report.modified).toBe(false)
    // Still there.
    expect(readPkg(workDir).dependencies['@elevenlabs/react']).toBe('^0.10.0')
  })

  test('package.json with no dependencies key → creates it and adds', () => {
    writePkg(workDir, { name: 'test' })
    const report = ensureFeatureDeps({
      cwd: workDir,
      features: { voice: true },
    })
    expect(report.modified).toBe(true)
    const pkg = readPkg(workDir)
    expect(typeof pkg.dependencies).toBe('object')
    expect(pkg.dependencies['@elevenlabs/react']).toBeDefined()
  })
})
