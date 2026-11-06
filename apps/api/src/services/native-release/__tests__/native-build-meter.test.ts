// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The `native_build` meter, against a fake wallet and a fake database.
 *
 * The properties under test are the ones that cost money when they are wrong:
 * a redelivered webhook charges once, an unpriced class charges nothing (and
 * says so), a failed charge is retryable rather than lost, and the amount billed
 * is always `raw × MARKUP_MULTIPLIER`.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { prismaProxy, useFakePrisma } from './prisma-fixture'

interface FakeBuild {
  id: string
  releaseId: string
  easBuildId: string
  platform: string
  purpose: string
  resourceClass: string | null
  meteredAt: Date | null
  meterStatus: string | null
  status: string
  finishedAt: Date | null
  updatedAt?: Date
}

const builds = new Map<string, FakeBuild>()
const release = { id: 'rel_1', workspaceId: 'ws_1', projectId: 'proj_1', testMeteredAt: null as Date | null }
const consumeCalls: Record<string, unknown>[] = []
const alerts: string[] = []
let consumeResult: { success: boolean } = { success: true }

const fakePrisma = {
  nativeBuild: {
    async findUnique({ where }: any) {
      const build = builds.get(where.easBuildId)
      return build ? { ...build, release } : null
    },
    /** The sweep's two queries; the filters it relies on are honoured here. */
    async findMany({ where }: any) {
      const all = [...builds.values()]
      if (where.meterStatus === 'metering') {
        return all
          .filter((b) => b.meterStatus === 'metering' && b.meteredAt !== null)
          .map((b) => ({ id: b.id }))
      }
      const cutoff = where.finishedAt?.lt as Date | undefined
      // `OR: [{ meterStatus: null }, { meterStatus: 'unpriced' }]` — the sweep
      // re-walks both, because a price row added later is what makes an unpriced
      // build billable.
      const statuses: (string | null)[] = where.OR
        ? where.OR.map((clause: any) => clause.meterStatus)
        : [where.meterStatus]
      return all
        .filter((b) => b.status === 'finished' && !b.meteredAt && statuses.includes(b.meterStatus))
        .filter((b) => !cutoff || (b.finishedAt !== null && b.finishedAt < cutoff))
        .map((b) => ({ easBuildId: b.easBuildId, resourceClass: b.resourceClass, release }))
    },
    async count({ where }: any) {
      return [...builds.values()].filter((b) => b.meterStatus === where.meterStatus).length
    },
    async updateMany({ where, data }: any) {
      const build = builds.get(where.easBuildId ?? '')
      const target = build ?? [...builds.values()].find((b) => b.id === where.id)
      if (!target) return { count: 0 }
      if (where.meteredAt === null && target.meteredAt) return { count: 0 }
      Object.assign(target, data)
      return { count: 1 }
    },
    async update({ where, data }: any) {
      const target = builds.get(where.easBuildId ?? '') ?? [...builds.values()].find((b) => b.id === where.id)
      if (target) Object.assign(target, data)
      return target
    },
  },
  nativeRelease: {
    async findUnique({ where }: any) {
      return where.id === release.id ? { ...release } : null
    },
    async updateMany({ where, data }: any) {
      if (where.testMeteredAt === null && release.testMeteredAt) return { count: 0 }
      Object.assign(release, data)
      return { count: 1 }
    },
    async update({ where, data }: any) {
      if (where.id === release.id) Object.assign(release, data)
      return release
    },
    async count() {
      return 0
    },
  },
}

mock.module('../../../lib/prisma', () => ({ prisma: prismaProxy }))
useFakePrisma(fakePrisma)
const { meterBuild, meterTestRun, billedUsd, setNativeUsageWallet, sweepNativeMeters, easJsonResourceClass, TEST_BUILD_RESOURCE_CLASS } = await import('../usage.service')
const { setNativeAlertSink } = await import('../alerts')

function seedBuild(overrides: Partial<FakeBuild> = {}): FakeBuild {
  const build: FakeBuild = {
    id: 'nb_1',
    releaseId: release.id,
    easBuildId: 'build_1',
    platform: 'ios',
    purpose: 'store',
    resourceClass: 'IOS_MEDIUM',
    meteredAt: null,
    meterStatus: null,
    status: 'in_progress',
    finishedAt: null,
    ...overrides,
  }
  builds.set(build.easBuildId, build)
  return build
}

beforeEach(() => {
  builds.clear()
  consumeCalls.length = 0
  alerts.length = 0
  consumeResult = { success: true }
  release.testMeteredAt = null
  setNativeAlertSink(async (event) => {
    alerts.push(event)
  })
  // The wallet seam, not a module mock: `nativeWallet()` is the inject point the
  // monthly job uses too, so this exercises the real meter code paths.
  setNativeUsageWallet({
    consume: (async (params: Record<string, unknown>) => {
      consumeCalls.push(params)
      return consumeResult as any
    }) as any,
    checkBalance: (async () => ({ ok: true })) as any,
  })
})

afterEach(() => {
  setNativeAlertSink(null)
  setNativeUsageWallet(null)
})

describe('meterBuild', () => {
  it('charges a finished store build at raw × 1.2', async () => {
    seedBuild()
    expect(await meterBuild({ easBuildId: 'build_1', memberId: 'me', mode: 'cloud' })).toBe('metered')

    expect(consumeCalls).toHaveLength(1)
    expect(consumeCalls[0].actionType).toBe('native_build')
    expect(consumeCalls[0].rawUsd).toBe(2)
    expect(consumeCalls[0].billedUsd).toBe(billedUsd(2))
    expect(consumeCalls[0].billedUsd).toBe(2.4)
    expect(builds.get('build_1')!.meterStatus).toBe('metered')
  })

  it('charges once when Expo redelivers the webhook', async () => {
    seedBuild()
    await meterBuild({ easBuildId: 'build_1', memberId: 'me', mode: 'cloud' })
    expect(await meterBuild({ easBuildId: 'build_1', memberId: 'me', mode: 'cloud' })).toBe('skipped')
    expect(consumeCalls).toHaveLength(1)
  })

  it('never bills an unpriced class, and says which one', async () => {
    seedBuild({ resourceClass: 'IOS_M_MEDIUM' })
    expect(await meterBuild({ easBuildId: 'build_1', memberId: 'me', mode: 'cloud' })).toBe('unpriced')

    expect(consumeCalls).toHaveLength(0)
    expect(builds.get('build_1')!.meterStatus).toBe('unpriced')
    expect(alerts).toContain('native_build_unpriced')

    // …and a retry does not quietly bill it at the medium rate either.
    expect(await meterBuild({ easBuildId: 'build_1', memberId: 'me', mode: 'cloud' })).toBe('unpriced')
    expect(consumeCalls).toHaveLength(0)
  })

  it('reverts the claim when the wallet refuses, so the sweep can retry', async () => {
    seedBuild()
    consumeResult = { success: false }
    expect(await meterBuild({ easBuildId: 'build_1', memberId: 'me', mode: 'cloud' })).toBe('failed')
    expect(builds.get('build_1')!.meteredAt).toBeNull()

    consumeResult = { success: true }
    expect(await meterBuild({ easBuildId: 'build_1', memberId: 'me', mode: 'cloud' })).toBe('metered')
    expect(consumeCalls).toHaveLength(2)
  })

  it('alerts on a build it has no row for instead of dropping it', async () => {
    expect(await meterBuild({ easBuildId: 'unknown', memberId: 'me', mode: 'cloud' })).toBe('failed')
    expect(alerts).toContain('native_build_unknown')
    expect(consumeCalls).toHaveLength(0)
  })

  it('charges a test build too, because EAS ran a real worker for it', async () => {
    seedBuild({ purpose: 'test' })
    expect(await meterBuild({ easBuildId: 'build_1', memberId: 'me', mode: 'cloud' })).toBe('metered')
    expect(consumeCalls).toHaveLength(1)
    expect(consumeCalls[0].actionType).toBe('native_build')
    expect(consumeCalls[0].rawUsd).toBe(2)
  })

  it('charges nothing outside cloud mode', async () => {
    seedBuild()
    expect(await meterBuild({ easBuildId: 'build_1', memberId: 'me', mode: 'byok' })).toBe('skipped')
    expect(consumeCalls).toHaveLength(0)
  })
})

describe('meterTestRun', () => {
  it('charges one Maestro run plus CI minutes, once per release', async () => {
    expect(
      await meterTestRun({ releaseId: release.id, memberId: 'me', ciMinutes: 10, mode: 'cloud' }),
    ).toBe('metered')
    expect(consumeCalls[0].actionType).toBe('native_test_run')
    expect(consumeCalls[0].rawUsd).toBe(0.8)

    expect(
      await meterTestRun({ releaseId: release.id, memberId: 'me', ciMinutes: 10, mode: 'cloud' }),
    ).toBe('skipped')
    expect(consumeCalls).toHaveLength(1)
  })
})

describe('the meter sweep closes what the webhook dropped', () => {
  const longAgo = new Date(Date.now() - 60 * 60 * 1000)

  it('charges a finished build nobody billed', async () => {
    seedBuild({ status: 'finished', finishedAt: longAgo })
    const result = await sweepNativeMeters({ mode: 'cloud' })
    expect(result).toMatchObject({ retried: 1, metered: 1, failed: 0 })
    expect(consumeCalls).toHaveLength(1)
    expect(builds.get('build_1')!.meterStatus).toBe('metered')
  })

  it('leaves a build inside the grace window alone, because its webhook may still arrive', async () => {
    seedBuild({ status: 'finished', finishedAt: new Date() })
    const result = await sweepNativeMeters({ mode: 'cloud' })
    expect(result.retried).toBe(0)
    expect(consumeCalls).toHaveLength(0)
  })

  it('releases a claim held through a crash, so the charge is retried instead of lost', async () => {
    seedBuild({
      status: 'finished',
      meteredAt: longAgo,
      meterStatus: 'metering',
      finishedAt: longAgo,
    })
    const result = await sweepNativeMeters({ mode: 'cloud' })
    expect(result.recovered).toBe(1)
    // Recovered and charged in the same pass: resetting the claim is only worth
    // anything if the retry follows immediately.
    expect(result.metered).toBe(1)
    expect(consumeCalls).toHaveLength(1)
    expect(builds.get('build_1')!.meterStatus).toBe('metered')
  })

  it('counts unpriced rows and alerts once, charging nothing', async () => {
    const unpriced = seedBuild({
      resourceClass: 'IOS_M_MEDIUM',
      status: 'finished',
      finishedAt: longAgo,
    })
    await meterBuild({ easBuildId: unpriced.easBuildId, memberId: 'me', mode: 'cloud' })
    expect(consumeCalls).toHaveLength(0)

    const result = await sweepNativeMeters({ mode: 'cloud' })
    expect(result.unpriced).toBe(1)
    expect(consumeCalls).toHaveLength(0)
    expect(alerts).toContain('native_meter_sweep')
  })

  it('does nothing outside cloud mode', async () => {
    seedBuild({ status: 'finished', finishedAt: longAgo })
    const result = await sweepNativeMeters({ mode: 'byok' })
    expect(result.metered).toBe(0)
    expect(consumeCalls).toHaveLength(0)
  })

  it('does not re-alert an unpriced row on every pass', async () => {
    const build = seedBuild({
      resourceClass: 'IOS_M_MEDIUM',
      status: 'finished',
      finishedAt: longAgo,
      meterStatus: 'unpriced',
    })
    const before = alerts.length
    const result = await sweepNativeMeters({ mode: 'cloud' })

    expect(build.meterStatus).toBe('unpriced')
    expect(consumeCalls).toHaveLength(0)
    expect(result.unpriced).toBe(1)
    // One aggregate sweep alert, not another per-build `native_build_unpriced`.
    expect(alerts.slice(before).filter((a) => a === 'native_build_unpriced')).toHaveLength(0)
    expect(alerts).toContain('native_meter_sweep')
  })

  it('bills an unpriced row once a price exists for its class', async () => {
    // The row is unpriced today only because `IOS_M_MEDIUM` has no rate. The sweep
    // must pick it up the moment one is published — that is the promise the
    // "never bill at a guess" rule makes.
    const build = seedBuild({
      resourceClass: 'IOS_MEDIUM',
      status: 'finished',
      finishedAt: longAgo,
      meterStatus: 'unpriced',
    })
    const result = await sweepNativeMeters({ mode: 'cloud' })
    expect(result.metered).toBe(1)
    expect(build.meterStatus).toBe('metered')
    expect(consumeCalls).toHaveLength(1)
    expect(consumeCalls[0].actionType).toBe('native_build')
  })
})

describe('the class the generated eas.json pins is the class the meter prices', () => {
  it('maps the priced classes to eas.json short names, per profile', () => {
    expect(easJsonResourceClass()).toEqual({
      test: { ios: 'medium', android: 'medium' },
      store: { ios: 'medium', android: 'medium' },
    })
  })

  it('gives buildParams and the store profile one source, so they cannot disagree', () => {
    // `storeResourceClass` (what we send in `buildParams`) and the store profile
    // are separate code paths over the same table; a second literal is how they
    // drift and the quote stops matching the invoice.
    const { storeResourceClass, testResourceClass } = require('../release.service')
    const pins = easJsonResourceClass()
    expect(pins.store.ios).toBe(storeResourceClass('ios').toLowerCase().replace('ios_', ''))
    expect(pins.store.android).toBe(
      storeResourceClass('android').toLowerCase().replace('android_', ''),
    )
    expect(pins.test.ios).toBe(testResourceClass('ios').toLowerCase().replace('ios_', ''))
    expect(pins.test.android).toBe(
      testResourceClass('android').toLowerCase().replace('android_', ''),
    )
  })

  it('pins what is priced, so a profile default cannot diverge from the quote', () => {
    // IOS_M_MEDIUM is the unpriced class QA worried the default might resolve to.
    // Whatever the table says, the profile must pin exactly it — and it must be
    // one eas.json can express.
    for (const cls of Object.values(TEST_BUILD_RESOURCE_CLASS)) {
      expect(['IOS_MEDIUM', 'ANDROID_MEDIUM']).toContain(cls as string)
    }
  })
})
