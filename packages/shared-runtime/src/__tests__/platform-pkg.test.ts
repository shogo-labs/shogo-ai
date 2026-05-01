// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Unit tests for the Windows-aware install-routing in platform-pkg.ts.
// We can't reasonably exercise the full install flow in a unit test
// (would require spawning npm/bun against a real package.json), so the
// coverage here focuses on the small but fragile detection function
// `isNodeAvailableOnWindows` which now drives the bun-fallback path.
//
// On non-Windows hosts, `isNodeAvailableOnWindows` is hard-wired to
// return true (bun is the only manager); we still smoke-test that
// invariant so a future "make this multi-platform" refactor can't
// silently regress it.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { isNodeAvailableOnWindows } from '../platform-pkg'

const TMP = join(process.env.TEMP ?? process.env.TMPDIR ?? '/tmp', 'test-platform-pkg')

// `isNodeAvailableOnWindows` short-circuits to `true` when the standard
// install directory (`C:\Program Files\nodejs\npm.cmd`) exists, *before*
// it ever walks the PATH. So any "no npm anywhere" assertion is only
// meaningful when that file isn't present on the test host.
const SYSTEM_NPM_CMD = 'C:\\Program Files\\nodejs\\npm.cmd'
const HOST_HAS_SYSTEM_NPM = process.platform === 'win32' && existsSync(SYSTEM_NPM_CMD)

describe('isNodeAvailableOnWindows', () => {
  beforeEach(() => {
    rmSync(TMP, { recursive: true, force: true })
    mkdirSync(TMP, { recursive: true })
  })

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true })
  })

  test('returns true on non-Windows hosts regardless of PATH', () => {
    if (process.platform === 'win32') return // skip on Windows
    expect(isNodeAvailableOnWindows('')).toBe(true)
    expect(isNodeAvailableOnWindows(undefined)).toBe(true)
    expect(isNodeAvailableOnWindows('/totally/bogus')).toBe(true)
  })

  test('returns true on Windows when npm.cmd is on PATH (synthetic dir)', () => {
    if (process.platform !== 'win32') return // PATH walk only checked on Windows
    const dir = join(TMP, 'fake-node')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'npm.cmd'), '')
    // Exercise the PATH walk — should find the synthetic npm.cmd.
    expect(isNodeAvailableOnWindows(dir)).toBe(true)
  })

  test('returns false on Windows when no PATH entry contains npm.cmd (and system Node is absent)', () => {
    if (process.platform !== 'win32') return
    if (HOST_HAS_SYSTEM_NPM) return // host has a system Node install — short-circuit makes this test meaningless
    const dir = join(TMP, 'no-npm')
    mkdirSync(dir, { recursive: true })
    expect(isNodeAvailableOnWindows(dir)).toBe(false)
  })

  test('handles undefined PATH on Windows without throwing', () => {
    if (process.platform !== 'win32') return
    // Falls through to the standard install dir check; that may or may
    // not exist on the host. The contract is "must not throw".
    expect(() => isNodeAvailableOnWindows(undefined)).not.toThrow()
  })
})
