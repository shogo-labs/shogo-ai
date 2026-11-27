// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import { WorkspaceActivityCache } from '../workspace-activity'

/** A load that resolves when the test says so, so two asks can overlap. */
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

describe('WorkspaceActivityCache', () => {
  test('concurrent asks join the one request in the window', async () => {
    const cache = new WorkspaceActivityCache()
    const pending = deferred<string[]>()
    let loads = 0
    const load = () => {
      loads += 1
      return pending.promise
    }

    const a = cache.read('k', load)
    const b = cache.read('k', load)
    pending.resolve(['running'])

    expect(await a).toEqual(['running'])
    expect(await b).toEqual(['running'])
    expect(loads).toBe(1)
  })

  test('a fresh ask does not join a request that started before it', async () => {
    const cache = new WorkspaceActivityCache()
    const pending = deferred<string[]>()
    let loads = 0
    const load = () => {
      loads += 1
      return loads === 1 ? pending.promise : Promise.resolve(['after'])
    }

    // Someone else's ask is already in flight when a turn edge arrives.
    const stale = cache.read('k', load)
    const fresh = cache.read('k', load, { fresh: true })
    pending.resolve(['before'])

    expect(await stale).toEqual(['before'])
    // The old answer cannot answer "what is true now": a turn that ended after
    // that request was sent would still look like it is running.
    expect(await fresh).toEqual(['after'])
    expect(loads).toBe(2)
  })
})
