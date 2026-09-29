// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, it } from 'bun:test'
import { validateCriticalPath, validateQuarantine } from '../check-e2e-quarantine'
import { CRITICAL_PATH_SPECS } from '../../e2e/staging/critical-path'
import { QUARANTINE, quarantineGrepInvert } from '../../e2e/staging/quarantine'

const today = new Date('2026-09-28T12:00:00Z')
const spec = `test("flaky thing", async () => {})`
const entry = {
  file: 'a.test.ts',
  title: 'flaky thing',
  owner: '@someone',
  reason: 'Stripe iframe timing',
  expires: '2026-10-05',
}

function check(overrides: Partial<typeof entry> = {}, source: string | null = spec) {
  return validateQuarantine([{ ...entry, ...overrides }], { today, readSpec: () => source })
}

describe('validateQuarantine', () => {
  it('accepts an owned, unexpired entry that matches a test title', () => {
    expect(check()).toEqual([])
  })

  it('fails on or after the expiry date', () => {
    expect(check({ expires: '2026-09-28' })[0]).toContain('expired')
  })

  it('caps how long a spec may stay quarantined', () => {
    expect(check({ expires: '2026-12-31' })[0]).toContain('more than')
  })

  it('requires an owner and a reason', () => {
    const errors = check({ owner: '', reason: ' ' })
    expect(errors.some((e) => e.includes('missing owner'))).toBe(true)
    expect(errors.some((e) => e.includes('missing reason'))).toBe(true)
  })

  it('flags stale entries whose title or file no longer exists', () => {
    expect(check({ title: 'renamed' })[0]).toContain('stale entry')
    expect(check({}, null)[0]).toContain('not found')
  })

  it('the checked-in registry is valid today', () => {
    expect(validateQuarantine(QUARANTINE)).toEqual([])
  })
})

describe('validateCriticalPath', () => {
  it('the checked-in critical-path list points at real, unquarantined specs', () => {
    expect(validateCriticalPath(CRITICAL_PATH_SPECS, QUARANTINE)).toEqual([])
  })

  it('fails when a gate spec is missing or quarantined', () => {
    expect(validateCriticalPath(['gone.test.ts'], [], { exists: () => false })[0]).toContain('not found')
    expect(validateCriticalPath(['a.test.ts'], [entry], { exists: () => true })[0]).toContain('quarantined')
    expect(validateCriticalPath([], [])[0]).toContain('empty')
  })
})

describe('quarantineGrepInvert', () => {
  it('is undefined for an empty registry so Playwright runs everything', () => {
    expect(quarantineGrepInvert([])).toBeUndefined()
  })

  it('matches only the quarantined title at the end of the full test path', () => {
    const [re] = quarantineGrepInvert([{ ...entry, title: 'a (b) c?' }])!
    expect(re.test('a.test.ts Suite a (b) c?')).toBe(true)
    expect(re.test('a.test.ts Suite a (b) c? more')).toBe(false)
  })
})
