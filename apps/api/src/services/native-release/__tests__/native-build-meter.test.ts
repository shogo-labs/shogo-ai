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

interface FakeBuild {
  id: string
  releaseId: string
  easBuildId: string
  platform: string
  purpose: string
  resourceClass: string | null
  meteredAt: Date | null
  meterStatus: string | null
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
  },
}

mock.module('../../../lib/prisma', () => ({ prisma: fakePrisma }))
const { meterBuild, meterTestRun, billedUsd, setNativeUsageWallet } = await import('../usage.service')
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

  it('does not charge a test build as a store build', async () => {
    seedBuild({ purpose: 'test' })
    expect(await meterBuild({ easBuildId: 'build_1', memberId: 'me', mode: 'cloud' })).toBe('skipped')
    expect(consumeCalls).toHaveLength(0)
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
