// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, it } from 'bun:test'

import { runBootMarketplaceMigrations } from '../boot-marketplace-migrations'

interface CallLog {
  events: string[]
  migrateStarted?: number
  migrateFinished?: number
  backfillStarted?: number
  backfillFinished?: number
}

function makeLoaders(log: CallLog, migrateBehavior: 'ok' | 'throw' = 'ok', backfillBehavior: 'ok' | 'throw' = 'ok') {
  return {
    loadRunMigration: async () => async (opts: { quiet: boolean }) => {
      log.migrateStarted = log.events.length
      log.events.push(`migrate:start quiet=${opts.quiet}`)
      // Yield to the microtask queue so a concurrent caller would have
      // had a chance to interleave; sequential callers will not.
      await new Promise((r) => setTimeout(r, 5))
      if (migrateBehavior === 'throw') {
        log.events.push('migrate:throw')
        throw new Error('migrate boom')
      }
      log.migrateFinished = log.events.length
      log.events.push('migrate:finish')
    },
    loadRunSnapshotBackfill: async () => async (opts: { quiet: boolean }) => {
      log.backfillStarted = log.events.length
      log.events.push(`backfill:start quiet=${opts.quiet}`)
      await new Promise((r) => setTimeout(r, 5))
      if (backfillBehavior === 'throw') {
        log.events.push('backfill:throw')
        throw new Error('backfill boom')
      }
      log.backfillFinished = log.events.length
      log.events.push('backfill:finish')
    },
  }
}

describe('runBootMarketplaceMigrations', () => {
  it('runs migrate then backfill SEQUENTIALLY (backfill never starts before migrate finishes)', async () => {
    const log: CallLog = { events: [] }
    const loaders = makeLoaders(log)

    await runBootMarketplaceMigrations({
      ...loaders,
      env: {},
      onError: () => {},
    })

    expect(log.events).toEqual([
      'migrate:start quiet=true',
      'migrate:finish',
      'backfill:start quiet=true',
      'backfill:finish',
    ])
    // The exact ordering invariant: backfill must start AFTER migrate
    // finishes. Pre-fix the two ran concurrently so this would fail.
    expect(log.backfillStarted!).toBeGreaterThan(log.migrateFinished!)
  })

  it('still runs backfill even when migrate throws (per-step error swallow)', async () => {
    const log: CallLog = { events: [] }
    const errors: Array<{ label: string; message: string }> = []

    await runBootMarketplaceMigrations({
      ...makeLoaders(log, 'throw', 'ok'),
      env: {},
      onError: (label, err) => errors.push({ label, message: err.message }),
    })

    expect(log.events).toContain('migrate:throw')
    expect(log.events).toContain('backfill:start quiet=true')
    expect(log.events).toContain('backfill:finish')
    expect(errors).toHaveLength(1)
    expect(errors[0].message).toBe('migrate boom')
    expect(errors[0].label).toBe('templates → marketplace migration failed')
  })

  it('swallows backfill errors so they never reach the caller', async () => {
    const log: CallLog = { events: [] }
    const errors: Array<{ label: string; message: string }> = []

    await runBootMarketplaceMigrations({
      ...makeLoaders(log, 'ok', 'throw'),
      env: {},
      onError: (label, err) => errors.push({ label, message: err.message }),
    })

    expect(log.events).toContain('migrate:finish')
    expect(log.events).toContain('backfill:throw')
    expect(errors).toHaveLength(1)
    expect(errors[0].message).toBe('backfill boom')
    expect(errors[0].label).toBe('snapshot S3 backfill failed')
  })

  it('skips migrate when SHOGO_SKIP_TEMPLATE_MIGRATION=true but still runs backfill', async () => {
    const log: CallLog = { events: [] }

    await runBootMarketplaceMigrations({
      ...makeLoaders(log),
      env: { SHOGO_SKIP_TEMPLATE_MIGRATION: 'true' },
      onError: () => {},
    })

    expect(log.events.some((e) => e.startsWith('migrate:'))).toBe(false)
    expect(log.events).toContain('backfill:start quiet=true')
    expect(log.events).toContain('backfill:finish')
  })

  it('skips backfill when SHOGO_SKIP_SNAPSHOT_BACKFILL=true but still runs migrate', async () => {
    const log: CallLog = { events: [] }

    await runBootMarketplaceMigrations({
      ...makeLoaders(log),
      env: { SHOGO_SKIP_SNAPSHOT_BACKFILL: 'true' },
      onError: () => {},
    })

    expect(log.events).toContain('migrate:start quiet=true')
    expect(log.events).toContain('migrate:finish')
    expect(log.events.some((e) => e.startsWith('backfill:'))).toBe(false)
  })

  it('skips both when both kill-switches are set', async () => {
    const log: CallLog = { events: [] }

    await runBootMarketplaceMigrations({
      ...makeLoaders(log),
      env: {
        SHOGO_SKIP_TEMPLATE_MIGRATION: 'true',
        SHOGO_SKIP_SNAPSHOT_BACKFILL: 'true',
      },
      onError: () => {},
    })

    expect(log.events).toEqual([])
  })

  it('treats SHOGO_SKIP_* values other than literal "true" as not-set (still runs)', async () => {
    const log: CallLog = { events: [] }

    await runBootMarketplaceMigrations({
      ...makeLoaders(log),
      env: {
        SHOGO_SKIP_TEMPLATE_MIGRATION: '1',
        SHOGO_SKIP_SNAPSHOT_BACKFILL: 'yes',
      },
      onError: () => {},
    })

    expect(log.events).toContain('migrate:finish')
    expect(log.events).toContain('backfill:finish')
  })
})
