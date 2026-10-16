// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import {
  absoluteDateText,
  dateValue,
  docTokenFor,
  docTokenRegex,
  fullDateLabel,
  localPartsOf,
  parseDateQuickPicks,
  parseDateValue,
  parseDocToken,
  relativeDateLabel,
  type DocRef,
} from '../doc-tokens'

// Tuesday, October 13 2026, 15:00 UTC (20:30 in Kolkata, 08:00 in Los Angeles).
const NOW = new Date(Date.UTC(2026, 9, 13, 15, 0))

describe('tokens', () => {
  const refs: DocRef[] = [
    { kind: 'user', id: 'u1' },
    { kind: 'agent', projectId: null },
    { kind: 'agent', projectId: 'p_1' },
    { kind: 'channel', id: 'c-1' },
    { kind: 'project', id: 'p2' },
    { kind: 'date', value: '2026-10-13' },
    { kind: 'date', value: '2026-10-13T09:30Z' },
  ]

  test('every ref round-trips through its token', () => {
    for (const ref of refs) expect(parseDocToken(docTokenFor(ref))).toEqual(ref)
  })

  test('the shared regex finds every token in text', () => {
    const text = refs.map(docTokenFor).join(' and ')
    expect([...text.matchAll(docTokenRegex())].map((m) => m[0])).toEqual(refs.map(docTokenFor))
  })

  test('rejects malformed tokens and impossible dates', () => {
    expect(parseDocToken('<@u:>')).toBeNull()
    expect(parseDocToken('<!date:2026-02-30>')).toBeNull()
    expect(parseDocToken('<!date:2026-10-13T25:00Z>')).toBeNull()
    expect(parseDocToken('<#x:abc>')).toBeNull()
  })
})

describe('dates', () => {
  test('parses calendar dates and moments', () => {
    expect(parseDateValue('2026-10-13')).toEqual({ day: '2026-10-13', instant: null })
    expect(parseDateValue('2026-10-13T09:30Z')?.instant?.toISOString()).toBe('2026-10-13T09:30:00.000Z')
  })

  test('relative labels follow the viewer’s calendar day', () => {
    expect(relativeDateLabel('2026-10-13', NOW, 'Asia/Kolkata')).toBe('Today')
    expect(relativeDateLabel('2026-10-12', NOW, 'Asia/Kolkata')).toBe('Yesterday')
    expect(relativeDateLabel('2026-10-14', NOW, 'Asia/Kolkata')).toBe('Tomorrow')
    expect(relativeDateLabel('2026-10-09', NOW, 'Asia/Kolkata')).toBe('Friday')
    expect(relativeDateLabel('2026-10-19', NOW, 'Asia/Kolkata')).toBe('Monday')
    expect(relativeDateLabel('2026-10-30', NOW, 'Asia/Kolkata')).toBe('Oct 30')
    expect(relativeDateLabel('2025-10-30', NOW, 'Asia/Kolkata')).toBe('Oct 30, 2025')
  })

  test('just after midnight the same date reads differently by zone', () => {
    const lateUtc = new Date(Date.UTC(2026, 9, 13, 20, 0)) // 01:30 on the 14th in Kolkata
    expect(relativeDateLabel('2026-10-13', lateUtc, 'Asia/Kolkata')).toBe('Yesterday')
    expect(relativeDateLabel('2026-10-13', lateUtc, 'America/Los_Angeles')).toBe('Today')
  })

  test('moments show the local day and time', () => {
    const value = '2026-10-13T09:30Z'
    expect(relativeDateLabel(value, NOW, 'Asia/Kolkata')).toBe('Today, 3:00 PM')
    expect(relativeDateLabel(value, NOW, 'America/Los_Angeles')).toBe('Today, 2:30 AM')
    expect(fullDateLabel(value, NOW, 'Asia/Kolkata')).toBe('Tuesday, October 13th at 3:00 PM')
  })

  test('full labels use ordinals and add other years', () => {
    expect(fullDateLabel('2026-10-13', NOW, 'UTC')).toBe('Tuesday, October 13th')
    expect(fullDateLabel('2026-10-01', NOW, 'UTC')).toBe('Thursday, October 1st')
    expect(fullDateLabel('2026-10-22', NOW, 'UTC')).toBe('Thursday, October 22nd')
    expect(fullDateLabel('2026-10-11', NOW, 'UTC')).toBe('Sunday, October 11th')
    expect(fullDateLabel('2027-01-03', NOW, 'UTC')).toBe('Sunday, January 3rd, 2027')
  })

  test('wall times convert to UTC moments and back, across DST', () => {
    expect(dateValue('2026-10-13', '15:00', 'Asia/Kolkata')).toBe('2026-10-13T09:30Z')
    expect(dateValue('2026-10-13', null, 'Asia/Kolkata')).toBe('2026-10-13')
    expect(localPartsOf('2026-10-13T09:30Z', 'Asia/Kolkata')).toEqual({ day: '2026-10-13', time: '15:00' })
    // Los Angeles: PDT (-7) in October, PST (-8) in December.
    expect(dateValue('2026-10-13', '09:00', 'America/Los_Angeles')).toBe('2026-10-13T16:00Z')
    expect(dateValue('2026-12-13', '09:00', 'America/Los_Angeles')).toBe('2026-12-13T17:00Z')
    expect(localPartsOf(dateValue('2026-12-13', '23:30', 'America/Los_Angeles'), 'America/Los_Angeles')).toEqual({ day: '2026-12-13', time: '23:30' })
  })

  test('absolute text for agents and notifications', () => {
    expect(absoluteDateText('2026-10-13')).toBe('Tuesday, October 13, 2026')
    expect(absoluteDateText('2026-10-13T09:30Z')).toBe('Tuesday, October 13, 2026 09:30 UTC')
  })
})

describe('date quick picks', () => {
  const picks = (q: string) => parseDateQuickPicks(q, NOW, 'Asia/Kolkata').map((p) => p.value)

  test('an empty query offers today, tomorrow and yesterday', () => {
    expect(picks('')).toEqual(['2026-10-13', '2026-10-14', '2026-10-12'])
  })

  test('prefixes of relative words', () => {
    expect(picks('tom')).toEqual(['2026-10-14'])
    expect(picks('tod')).toEqual(['2026-10-13'])
    expect(picks('tmrw')).toEqual(['2026-10-14'])
  })

  test('weekdays are the coming one; "next" is a week later', () => {
    expect(picks('fri')).toEqual(['2026-10-16'])
    expect(picks('tue')).toEqual(['2026-10-20'])
    expect(picks('next mon')).toEqual(['2026-10-26'])
  })

  test('month and day in several spellings', () => {
    expect(picks('oct 19')).toEqual(['2026-10-19'])
    expect(picks('19 oct')).toEqual(['2026-10-19'])
    expect(picks('october 19th')).toEqual(['2026-10-19'])
    expect(picks('10/19')).toEqual(['2026-10-19'])
    expect(picks('2026-10-19')).toEqual(['2026-10-19'])
    expect(picks('jan 5')).toEqual(['2027-01-05'])
    expect(picks('oct 1')).toEqual(['2026-10-01'])
  })

  test('labels read naturally', () => {
    const [today] = parseDateQuickPicks('today', NOW, 'Asia/Kolkata')
    expect(today.label).toBe('Today · Oct 13')
    const [later] = parseDateQuickPicks('oct 30', NOW, 'Asia/Kolkata')
    expect(later.label).toBe('Friday, October 30th')
  })

  test('nonsense yields nothing', () => {
    expect(picks('sahil')).toEqual([])
    expect(picks('feb 30')).toEqual([])
  })
})
