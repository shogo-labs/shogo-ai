// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for scripts/desktop-next-beta-version.ts — see that file's
 * header for why the beta timestamp comes from the commit's committer
 * date (not wall-clock build time): the macOS + Windows release
 * workflows each compute this independently for the same push and must
 * land on the identical version string.
 */
import { describe, expect, test } from 'bun:test'
import {
  formatBetaTimestamp,
  isStableTag,
  nextPatchVersion,
  pickLatestStableTag,
  resolveBetaVersion,
  resolveVersion,
} from '../desktop-next-beta-version'

describe('isStableTag', () => {
  test('accepts plain vX.Y.Z tags', () => {
    expect(isStableTag('v1.14.9')).toBe(true)
    expect(isStableTag('v0.0.1')).toBe(true)
  })

  test('rejects prerelease / malformed tags', () => {
    expect(isStableTag('v1.14.9-beta.1')).toBe(false)
    expect(isStableTag('v1.14.9-nightly.20260101000000')).toBe(false)
    expect(isStableTag('1.14.9')).toBe(false)
    expect(isStableTag('vX.Y.Z')).toBe(false)
  })
})

describe('pickLatestStableTag', () => {
  test('picks the highest semver among stable tags, ignoring prereleases', () => {
    const tags = ['v1.14.8', 'v1.14.9', 'v1.14.10-beta.20260101000000', 'v1.2.0', 'v1.14.9-beta.5']
    expect(pickLatestStableTag(tags)).toBe('v1.14.9')
  })

  test('compares numerically, not lexically (v1.9.0 < v1.10.0)', () => {
    expect(pickLatestStableTag(['v1.9.0', 'v1.10.0'])).toBe('v1.10.0')
  })

  test('returns null when there are no stable tags', () => {
    expect(pickLatestStableTag([])).toBeNull()
    expect(pickLatestStableTag(['v1.0.0-beta.1'])).toBeNull()
  })
})

describe('nextPatchVersion', () => {
  test('bumps the patch component', () => {
    expect(nextPatchVersion('v1.14.9')).toBe('1.14.10')
    expect(nextPatchVersion('v1.14.99')).toBe('1.14.100')
    expect(nextPatchVersion('v2.0.0')).toBe('2.0.1')
  })
})

describe('formatBetaTimestamp', () => {
  test('formats as a fixed-width <date>t<time> UTC string', () => {
    const d = new Date(Date.UTC(2026, 8, 19, 23, 30, 0)) // 2026-09-19T23:30:00Z
    expect(formatBetaTimestamp(d)).toBe('20260919t233000')
  })

  test('zero-pads every component', () => {
    const d = new Date(Date.UTC(2026, 0, 1, 1, 2, 3)) // 2026-01-01T01:02:03Z
    expect(formatBetaTimestamp(d)).toBe('20260101t010203')
  })
})

describe('resolveBetaVersion', () => {
  test('bumps the newest stable tag and appends the timestamp', () => {
    const d = new Date(Date.UTC(2026, 8, 19, 23, 30, 0))
    expect(resolveBetaVersion(['v1.14.9', 'v1.14.8'], d)).toBe('1.14.10-beta.20260919t233000')
  })

  test('falls back to 0.0.1 when there is no stable tag yet', () => {
    const d = new Date(Date.UTC(2026, 0, 1, 0, 0, 0))
    expect(resolveBetaVersion([], d)).toBe('0.0.1-beta.20260101t000000')
  })

  test('is monotonic across ordered commit timestamps for a fixed base', () => {
    const tags = ['v1.14.9']
    const first = resolveBetaVersion(tags, new Date(Date.UTC(2026, 8, 19, 12, 0, 0)))
    const second = resolveBetaVersion(tags, new Date(Date.UTC(2026, 8, 19, 12, 0, 1)))
    expect(first < second).toBe(true)
    // electron-winstaller's convertVersion() strips dots from the
    // prerelease before NuGet's lexical comparison — assert the
    // dot-stripped forms are STILL ordered correctly.
    expect(first.replace('-beta.', '-beta') < second.replace('-beta.', '-beta')).toBe(true)
  })
})

describe('resolveVersion', () => {
  const tags = ['v1.14.9']
  const commitDate = new Date(Date.UTC(2026, 8, 19, 23, 30, 0))

  test('tag push -> stable channel, version stripped of the leading v', () => {
    const result = resolveVersion({
      eventName: 'push',
      ref: 'refs/tags/v1.15.0',
      dispatchVersion: undefined,
      dispatchChannel: undefined,
      tags,
      commitDate,
    })
    expect(result).toEqual({ version: '1.15.0', channel: 'stable' })
  })

  test('tag push ignores workflow_dispatch inputs even if somehow present', () => {
    const result = resolveVersion({
      eventName: 'push',
      ref: 'refs/tags/v1.15.0-rc.1',
      dispatchVersion: '9.9.9',
      dispatchChannel: 'beta',
      tags,
      commitDate,
    })
    expect(result).toEqual({ version: '1.15.0-rc.1', channel: 'stable' })
  })

  test('workflow_dispatch defaults to stable when no channel input given', () => {
    const result = resolveVersion({
      eventName: 'workflow_dispatch',
      ref: 'refs/heads/main',
      dispatchVersion: '0.5.0',
      dispatchChannel: undefined,
      tags,
      commitDate,
    })
    expect(result).toEqual({ version: '0.5.0', channel: 'stable' })
  })

  test('workflow_dispatch honors an explicit beta channel input', () => {
    const result = resolveVersion({
      eventName: 'workflow_dispatch',
      ref: 'refs/heads/main',
      dispatchVersion: '0.5.0',
      dispatchChannel: 'beta',
      tags,
      commitDate,
    })
    expect(result).toEqual({ version: '0.5.0', channel: 'beta' })
  })

  test('push to main resolves a beta version off the newest stable tag', () => {
    const result = resolveVersion({
      eventName: 'push',
      ref: 'refs/heads/main',
      dispatchVersion: undefined,
      dispatchChannel: undefined,
      tags,
      commitDate,
    })
    expect(result).toEqual({ version: '1.14.10-beta.20260919t233000', channel: 'beta' })
  })

  test('push to an unrelated branch falls back to the 0.0.0-dev placeholder', () => {
    const result = resolveVersion({
      eventName: 'push',
      ref: 'refs/heads/some-feature-branch',
      dispatchVersion: undefined,
      dispatchChannel: undefined,
      tags,
      commitDate,
    })
    expect(result).toEqual({ version: '0.0.0-dev', channel: 'stable' })
  })
})

describe('beta version is Squirrel/NuGet safe (SHOG-750)', () => {
  const INT32_MAX = 2147483647

  /**
   * Mirrors `electron-winstaller`'s `convertVersion()`, which strips dots from
   * the prerelease when deriving the NuGet package id. Squirrel then compares
   * that string, and the legacy NuGet `SemanticVersion` runs `Int32.Parse`
   * over its numeric runs — a 14-digit run overflowed and failed every
   * Windows beta build.
   */
  const convertVersion = (version: string): string => {
    const parts = version.split('-')
    const mainVersion = parts.shift() as string
    return parts.length > 0
      ? [mainVersion, parts.join('-').replace(/\./g, '')].join('-')
      : mainVersion
  }

  const maxDigitRun = (s: string): number =>
    Math.max(0, ...(s.match(/\d+/g) ?? []).map(Number))

  const dates = [
    Date.UTC(2026, 8, 22, 9, 37, 36),
    Date.UTC(2026, 0, 1, 0, 0, 0),
    Date.UTC(2026, 11, 31, 23, 59, 59),
    Date.UTC(2030, 5, 15, 12, 30, 45),
    Date.UTC(9999, 11, 31, 23, 59, 59),
  ]

  test('every numeric run in the NuGet-converted version fits in Int32', () => {
    for (const ms of dates) {
      const converted = convertVersion(resolveBetaVersion(['v1.14.9'], new Date(ms)))
      expect(maxDigitRun(converted)).toBeLessThanOrEqual(INT32_MAX)
    }
  })

  test('the legacy 14-digit stamp would NOT have fit — guards against regressing', () => {
    // Documents the actual failure: 20260922093736 is ~9,400x Int32.MaxValue.
    expect(maxDigitRun('beta20260922093736')).toBeGreaterThan(INT32_MAX)
  })

  test('the stamp keeps a fixed width so lexical order equals chronological order', () => {
    const widths = new Set(dates.map((ms) => formatBetaTimestamp(new Date(ms)).length))
    expect(widths.size).toBe(1)
  })

  test('the stamp splits into exactly two digit runs around a literal t', () => {
    expect(formatBetaTimestamp(new Date(dates[0]))).toMatch(/^\d{8}t\d{6}$/)
  })

  test('stays ordered after dot-stripping across a year boundary', () => {
    const tags = ['v1.14.9']
    const dec = convertVersion(resolveBetaVersion(tags, new Date(Date.UTC(2026, 11, 31, 23, 59, 59))))
    const jan = convertVersion(resolveBetaVersion(tags, new Date(Date.UTC(2027, 0, 1, 0, 0, 0))))
    expect(dec < jan).toBe(true)
  })

  test('any future build outranks the last published legacy 14-digit beta', () => {
    // Upgrade continuity: the newest legacy beta published before this change
    // was 1.14.10-beta.20260922093736. Every build from that commit date
    // onward must compare GREATER, or existing beta installs would see a
    // downgrade and stop updating. `t` (0x74) sorts above every digit.
    const legacy = 'beta20260922093736'
    const sameSecond = Date.UTC(2026, 8, 22, 9, 37, 36)
    for (const ms of [sameSecond, sameSecond + 1000, Date.UTC(2027, 0, 1, 0, 0, 0)]) {
      const converted = convertVersion(resolveBetaVersion(['v1.14.9'], new Date(ms)))
      const prerelease = converted.split('-')[1]
      expect(prerelease > legacy).toBe(true)
    }
  })

  test('both release workflows derive the identical string from one commit date', () => {
    // macOS and Windows run this script in separate jobs for the same push and
    // must agree, or they race to create two different releases for one commit.
    const commitDate = new Date(Date.UTC(2026, 8, 22, 9, 37, 36))
    const macos = resolveBetaVersion(['v1.14.9'], commitDate)
    const windows = resolveBetaVersion(['v1.14.9'], new Date(commitDate.getTime()))
    expect(macos).toBe(windows)
  })
})
