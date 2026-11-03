// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `hostOfWorkspace` answers "where does this workspace run", and every runtime
 * resolve asks it. A lookup that cannot be answered must read as "no host" —
 * the same path a workspace with no host takes — never as a failed resolve:
 * that turned every route in a database-free process into a 500 (SHO-285 QA).
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test'

const state: { row: { hostInstanceId: string | null } | null; throws: boolean } = {
  row: null,
  throws: false,
}

mock.module('../prisma', () => ({
  prisma: {
    workspace: {
      findUnique: async () => {
        if (state.throws) throw new Error('User was denied access on the database')
        return state.row
      },
    },
  },
}))

const { hostOfWorkspace, _resetHostCacheForTests } = await import('../host-tunnel')

describe('hostOfWorkspace', () => {
  beforeEach(() => {
    _resetHostCacheForTests()
    state.row = null
    state.throws = false
    delete process.env.SHOGO_LOCAL_MODE
  })

  test('a workspace with no host is not hosted', async () => {
    state.row = { hostInstanceId: null }
    expect(await hostOfWorkspace('ws-plain')).toBeNull()
  })

  test('a hosted workspace names its host', async () => {
    state.row = { hostInstanceId: 'inst-1' }
    expect(await hostOfWorkspace('ws-hosted')).toBe('inst-1')
  })

  test('a lookup that cannot be answered is not a failure', async () => {
    state.throws = true
    expect(await hostOfWorkspace('ws-unknown')).toBeNull()
  })

  test('a failed lookup is not cached, so the next resolve asks again', async () => {
    state.throws = true
    expect(await hostOfWorkspace('ws-retry')).toBeNull()
    state.throws = false
    state.row = { hostInstanceId: 'inst-2' }
    expect(await hostOfWorkspace('ws-retry')).toBe('inst-2')
  })

  test('the desktop never asks: it has no cluster to host a workspace', async () => {
    process.env.SHOGO_LOCAL_MODE = 'true'
    state.throws = true
    expect(await hostOfWorkspace('ws-local')).toBeNull()
  })
})
