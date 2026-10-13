import { describe, expect, test } from 'bun:test'
import { backfillDates, digestRunTime } from '../backfill-analytics-digests'

describe('backfill-analytics-digests', () => {
  test('lists every UTC date in the inclusive range', () => {
    expect(backfillDates('2026-09-30', '2026-10-02')).toEqual(['2026-09-30', '2026-10-01', '2026-10-02'])
    expect(backfillDates('2026-10-12', '2026-10-12')).toEqual(['2026-10-12'])
  })

  test('rejects reversed or malformed ranges', () => {
    expect(() => backfillDates('2026-10-02', '2026-09-30')).toThrow('--from must be on or before --to')
    expect(() => backfillDates('yesterday', '2026-09-30')).toThrow('YYYY-MM-DD')
  })

  test('runs each date at the scheduled digest hour', () => {
    expect(digestRunTime('2026-10-01').toISOString()).toBe('2026-10-01T08:00:00.000Z')
  })
})
