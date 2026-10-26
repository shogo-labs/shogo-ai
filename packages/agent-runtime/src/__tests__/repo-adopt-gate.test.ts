// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { RepoAdoptGate, isWorkspaceNeutralRequest } from '../repo-adopt-gate'

describe('RepoAdoptGate', () => {
  test('adopts while nobody has used the workspace', async () => {
    const gate = new RepoAdoptGate()
    expect(await gate.adoptIfIdle(async () => 'swapped')).toBe('swapped')
  })

  test('declines once a workspace-writing request has entered', async () => {
    const gate = new RepoAdoptGate()
    await gate.enter()
    let ran = false
    expect(
      await gate.adoptIfIdle(async () => {
        ran = true
        return 'swapped'
      }),
    ).toBeNull()
    expect(ran).toBe(false)
  })

  test('declines while work is in flight even if no request entered', async () => {
    const gate = new RepoAdoptGate()
    expect(await gate.adoptIfIdle(async () => 'swapped', () => true)).toBeNull()
  })

  test('a request arriving mid-adopt waits for the swap to finish', async () => {
    const gate = new RepoAdoptGate()
    const order: string[] = []
    let release!: () => void
    const adopting = gate.adoptIfIdle(
      () =>
        new Promise<string>((resolve) => {
          release = () => {
            order.push('swap done')
            resolve('swapped')
          }
        }),
    )
    const entering = gate.enter().then(() => order.push('request runs'))
    await Bun.sleep(5)
    expect(order).toEqual([])
    release()
    await Promise.all([adopting, entering])
    expect(order).toEqual(['swap done', 'request runs'])
    expect(gate.inUse).toBe(true)
  })

  test('a request that enters first wins in the same tick', async () => {
    const gate = new RepoAdoptGate()
    void gate.enter()
    expect(await gate.adoptIfIdle(async () => 'swapped')).toBeNull()
  })

  test('a failed swap releases waiting requests', async () => {
    const gate = new RepoAdoptGate()
    const adopting = gate.adoptIfIdle(async () => {
      await Bun.sleep(5)
      throw new Error('reset failed')
    })
    const entering = gate.enter()
    await expect(adopting).rejects.toThrow('reset failed')
    await entering
    expect(gate.inUse).toBe(true)
  })

  test('reset makes a reassigned runtime idle again', async () => {
    const gate = new RepoAdoptGate()
    await gate.enter()
    gate.reset()
    expect(await gate.adoptIfIdle(async () => 1)).toBe(1)
  })
})

describe('isWorkspaceNeutralRequest', () => {
  test('reads and host control calls never count as use', () => {
    expect(isWorkspaceNeutralRequest('GET', '/agent/chat/history')).toBe(true)
    expect(isWorkspaceNeutralRequest('POST', '/pool/repo-hydrated')).toBe(true)
    expect(isWorkspaceNeutralRequest('POST', '/health')).toBe(true)
  })

  test('writes to the agent count as use', () => {
    expect(isWorkspaceNeutralRequest('POST', '/agent/chat')).toBe(false)
    expect(isWorkspaceNeutralRequest('PUT', '/agent/files/src/App.tsx')).toBe(false)
    expect(isWorkspaceNeutralRequest('POST', '/agent/heartbeat/trigger')).toBe(false)
  })
})
