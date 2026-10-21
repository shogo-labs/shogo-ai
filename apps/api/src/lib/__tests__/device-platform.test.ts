// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Device identity normalisation + release-tag resolution.
 *
 * The 8 platform spellings asserted here are the ones production actually
 * carried (read off `api_keys` on 2026-10-21): 8 spellings for 3 operating
 * systems, plus 11 `shogo-cli/unknown` device keys counted as desktops.
 */

import { describe, expect, test } from 'bun:test'
import {
  compareSemver,
  isSameRelease,
  parseChannel,
  parseClient,
  parseDevicePlatform,
  parseSemver,
  deviceOsLabel,
} from '../device-platform'
import { deployedAppVersion, resolveAppVersion } from '../app-version'

describe('parseDevicePlatform', () => {
  // Every value observed in production, mapped to exactly one OS.
  const production: Array<[string, string, string | null]> = [
    ['darwin', 'macos', null],
    ['darwin-arm64', 'macos', 'arm64'],
    ['darwin-x64', 'macos', 'x64'],
    ['win32', 'windows', null],
    ['win32-x64', 'windows', 'x64'],
    ['linux', 'linux', null],
    ['linux-x64', 'linux', 'x64'],
    ['linux-arm64', 'linux', 'arm64'],
  ]

  for (const [raw, os, arch] of production) {
    test(`${raw} → ${os}/${arch ?? 'unknown arch'}`, () => {
      expect(parseDevicePlatform(raw)).toEqual({ os, arch })
    })
  }

  test('null, empty and unrecognised values land on unknown', () => {
    expect(parseDevicePlatform(null)).toEqual({ os: 'unknown', arch: null })
    expect(parseDevicePlatform(undefined)).toEqual({ os: 'unknown', arch: null })
    expect(parseDevicePlatform('')).toEqual({ os: 'unknown', arch: null })
    expect(parseDevicePlatform('freebsd')).toEqual({ os: 'unknown', arch: null })
  })

  test('is case and whitespace insensitive', () => {
    expect(parseDevicePlatform('  Darwin-ARM64 ')).toEqual({ os: 'macos', arch: 'arm64' })
    expect(parseDevicePlatform('Win32')).toEqual({ os: 'windows', arch: null })
  })

  test('never returns more than the four known OSes', () => {
    const raws = ['darwin', 'darwin-arm64', 'darwin-x64', 'win32', 'win32-x64', 'linux', 'linux-x64', 'linux-arm64', null]
    const oses = new Set(raws.map((raw) => parseDevicePlatform(raw).os))
    expect([...oses].sort()).toEqual(['linux', 'macos', 'unknown', 'windows'])
  })

  test('labels are stable for the admin UI', () => {
    expect(deviceOsLabel('macos')).toBe('macOS')
    expect(deviceOsLabel('windows')).toBe('Windows')
    expect(deviceOsLabel('linux')).toBe('Linux')
    expect(deviceOsLabel('unknown')).toBe('Unknown')
  })
})

describe('parseClient', () => {
  test('shogo-cli versions are CLI, never desktop', () => {
    expect(parseClient('shogo-cli/unknown')).toBe('cli')
    expect(parseClient('shogo-cli/1.2.3', 'darwin-arm64')).toBe('cli')
    expect(parseClient('SHOGO-CLI/1.0.0')).toBe('cli')
  })

  test('a shogo-cli platform token is CLI even without a version', () => {
    expect(parseClient(null, 'shogo-cli')).toBe('cli')
  })

  test('real app versions are desktop', () => {
    expect(parseClient('2.3.6')).toBe('desktop')
    expect(parseClient('2.3.6-beta.20261020t083308')).toBe('desktop')
  })

  test('missing version is unknown rather than desktop', () => {
    expect(parseClient(null)).toBe('unknown')
    expect(parseClient('')).toBe('unknown')
  })
})

describe('parseChannel', () => {
  test('separates betas from stable', () => {
    expect(parseChannel('2.3.6-beta.20261020t083308')).toBe('beta')
    expect(parseChannel('2.3.6-rc.1')).toBe('stable')
    expect(parseChannel('2.3.6')).toBe('stable')
    expect(parseChannel(null)).toBe('stable')
  })
})

describe('parseSemver / compareSemver', () => {
  test('parses stable, prerelease and v-prefixed tags', () => {
    expect(parseSemver('2.3.6')).toEqual({ major: 2, minor: 3, patch: 6, prerelease: null })
    expect(parseSemver('v2.3.6')).toEqual({ major: 2, minor: 3, patch: 6, prerelease: null })
    expect(parseSemver('2.3.6-beta.1')?.prerelease).toBe('beta.1')
    expect(parseSemver('not-a-version')).toBeNull()
  })

  test('orders numerically, not lexicographically', () => {
    expect(compareSemver('2.3.6', '2.10.0')).toBeLessThan(0)
    expect(compareSemver('2.10.0', '2.9.9')).toBeGreaterThan(0)
    expect(compareSemver('2.3.6', '2.3.6')).toBe(0)
  })

  test('a beta sorts below its stable release', () => {
    expect(compareSemver('2.3.6-beta.20261020t083308', '2.3.6')).toBeLessThan(0)
    expect(compareSemver('2.3.6', '2.3.6-beta.1')).toBeGreaterThan(0)
  })

  test('unparsable versions sort below parsable ones', () => {
    expect(compareSemver('shogo-cli/unknown', '2.3.6')).toBeLessThan(0)
    expect(compareSemver('2.3.6', 'shogo-cli/unknown')).toBeGreaterThan(0)
  })

  test('isSameRelease treats a v-prefixed tag as the same release', () => {
    expect(isSameRelease('2.3.6', '2.3.6')).toBe(true)
    expect(isSameRelease('2.3.6', 'v2.3.6')).toBe(true)
    expect(isSameRelease('2.3.6', '2.3.7')).toBe(false)
    expect(isSameRelease('2.3.6', null)).toBe(false)
  })
})

describe('resolveAppVersion', () => {
  test('prefers APP_VERSION, then SHOGO_APP_VERSION', () => {
    expect(resolveAppVersion({ APP_VERSION: '2.3.6', SHOGO_APP_VERSION: '2.3.5' })).toBe('2.3.6')
    expect(resolveAppVersion({ SHOGO_APP_VERSION: '2.3.5' })).toBe('2.3.5')
  })

  test('treats an unpinned or placeholder deployment as unknown', () => {
    expect(resolveAppVersion({})).toBeNull()
    expect(resolveAppVersion({ APP_VERSION: '' })).toBeNull()
    expect(resolveAppVersion({ APP_VERSION: '0.0.0' })).toBeNull()
    expect(resolveAppVersion({ APP_VERSION: 'APP_VERSION_PLACEHOLDER' })).toBeNull()
  })

  test('deployedAppVersion reads the process env', () => {
    const previous = process.env.APP_VERSION
    process.env.APP_VERSION = '9.9.9'
    expect(deployedAppVersion()).toBe('9.9.9')
    delete process.env.APP_VERSION
    expect(deployedAppVersion()).toBeNull()
    if (previous !== undefined) process.env.APP_VERSION = previous
  })
})
