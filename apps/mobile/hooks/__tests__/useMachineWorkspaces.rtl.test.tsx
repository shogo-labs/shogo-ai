// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// AC3 of SHO-54: quitting the desktop must flip its row to offline within one
// heartbeat window. The row reads its presence from `useMachineWorkspaces`,
// so that hook has to re-read `/api/machines` on its own — the sidebar stays
// mounted for the whole session, so a mount-time fetch means the dot is frozen
// at whatever was true when the app loaded.

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, renderHook, waitFor } from '@testing-library/react'

const ONLINE = {
  machines: [
    {
      id: 'inst-1',
      name: 'Russell’s Mac',
      hostname: 'mac',
      status: 'online',
      lastSeenAt: '2026-10-19T18:00:00.000Z',
      snapshot: { workspaces: [{ id: 'lw-1', name: 'Personal', projectCount: 2 }] },
    },
  ],
}

const OFFLINE = {
  machines: [
    {
      ...ONLINE.machines[0],
      status: 'offline',
      lastSeenAt: '2026-10-19T18:01:00.000Z',
    },
  ],
}

describe('useMachineWorkspaces presence', () => {
  let machineReads = 0

  beforeEach(() => {
    machineReads = 0
    mock.module('../../lib/api', () => ({ API_URL: 'https://studio.test' }))
    globalThis.fetch = (async (input: any) => {
      const url = String(input)
      if (url.endsWith('/api/machines')) {
        machineReads += 1
        // First read: online. Afterwards the desktop has quit.
        const body = machineReads === 1 ? ONLINE : OFFLINE
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      const id = url.split('/api/machines/')[1]?.split('/')[0]
      return new Response(
        JSON.stringify({
          machine: { id },
          status: machineReads === 1 ? 'online' : 'offline',
          stale: machineReads !== 1,
          workspaces: [{ id: 'lw-1', name: 'Personal', projectCount: 2 }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as any
  })

  afterEach(() => {
    mock.restore()
  })

  it('re-reads presence so the row flips to offline inside a heartbeat window', async () => {
    const { useMachineWorkspaces } = await import('../useMachineWorkspaces')
    const { result } = renderHook(() => useMachineWorkspaces())

    await waitFor(() => expect(result.current.machines[0]?.status).toBe('online'))

    const readsAtMount = machineReads
    // One heartbeat window later, with no user action and no remount.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 61_000))
    })

    expect(machineReads).toBeGreaterThan(readsAtMount)
    expect(result.current.machines[0]?.status).toBe('offline')
  }, 70_000)
})
