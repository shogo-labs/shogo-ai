// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 *   bun test apps/api/src/lib/__tests__/runtime-home-region-guard.test.ts
 */

import { afterEach, describe, expect, test } from 'bun:test'
import {
  assertRuntimeInHomeRegion,
  RuntimeNotInHomeRegionError,
} from '../runtime-home-region-guard'

const homes: Record<string, string | null> = {
  ws_us: 'us-ashburn-1',
  ws_eu: 'eu-frankfurt-1',
  ws_legacy: null,
  ws_foreign: 'ap-tokyo-1',
}

const lookups: string[] = []
const lookupHomeRegion = async (id: string) => {
  lookups.push(id)
  return homes[id] ?? null
}

const EU = { region: 'eu-frankfurt-1', peerIds: ['us-ashburn-1'], lookupHomeRegion }

const SAVED = process.env.RUNTIME_HOME_REGION_GUARD
afterEach(() => {
  lookups.length = 0
  if (SAVED === undefined) delete process.env.RUNTIME_HOME_REGION_GUARD
  else process.env.RUNTIME_HOME_REGION_GUARD = SAVED
})

describe('assertRuntimeInHomeRegion', () => {
  test('refuses to start a runtime whose workspace is homed in a peer region', async () => {
    const err = await assertRuntimeInHomeRegion('ws_us', EU).catch((e) => e)
    expect(err).toBeInstanceOf(RuntimeNotInHomeRegionError)
    expect(err).toMatchObject({
      code: 'runtime_not_in_home_region',
      workspaceId: 'ws_us',
      homeRegion: 'us-ashburn-1',
      region: 'eu-frankfurt-1',
    })
  })

  test('allows the home region', async () => {
    await expect(assertRuntimeInHomeRegion('ws_eu', EU)).resolves.toBeUndefined()
  })

  test('allows legacy null-homeRegion workspaces (the request pin serves them locally too)', async () => {
    await expect(assertRuntimeInHomeRegion('ws_legacy', EU)).resolves.toBeUndefined()
  })

  test('allows a home region that is not a configured peer (nowhere to defer to)', async () => {
    await expect(assertRuntimeInHomeRegion('ws_foreign', EU)).resolves.toBeUndefined()
  })

  test('fails open when the lookup throws', async () => {
    await expect(
      assertRuntimeInHomeRegion('ws_us', {
        ...EU,
        lookupHomeRegion: async () => {
          throw new Error('db down')
        },
      }),
    ).resolves.toBeUndefined()
  })

  test('is inert in single-region / local mode without touching the database', async () => {
    await assertRuntimeInHomeRegion('ws_us', { ...EU, region: null })
    await assertRuntimeInHomeRegion('ws_us', { ...EU, peerIds: [] })
    expect(lookups).toEqual([])
  })

  test('RUNTIME_HOME_REGION_GUARD=off disables the guard', async () => {
    process.env.RUNTIME_HOME_REGION_GUARD = 'off'
    await expect(assertRuntimeInHomeRegion('ws_us', EU)).resolves.toBeUndefined()
    expect(lookups).toEqual([])
  })
})
