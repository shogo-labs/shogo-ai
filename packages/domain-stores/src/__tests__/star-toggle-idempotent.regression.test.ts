// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Regression test for Sentry SHOGO-ANDROID-S: `ShogoError: Project is already
 * starred` (5 users).
 *
 * Root cause: a double tap on the star fired two `toggleStarProject` calls
 * before the first write settled. The first added an optimistic row; the second
 * saw that row and deleted it, so the project ended up unstarred while the
 * first POST was still in flight — and a later tap re-POSTed a star the server
 * already had, which the API answers with `already_starred`.
 *
 * The fix makes the toggle idempotent: a second call while one is in flight
 * reports the state the first is heading for and sends nothing, and a star the
 * server already has resolves as success instead of throwing.
 */
import { test, expect } from 'bun:test'
import { createDomainActions } from '../domain-actions'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

function makeStore(createImpl: (input: any) => Promise<unknown>) {
  const rows: any[] = []
  const calls = { create: 0, delete: 0, loadAll: 0 }
  const store = {
    starredProjectCollection: {
      get all() {
        return rows
      },
      create: async (input: any) => {
        calls.create++
        return createImpl(input)
      },
      delete: async (id: string) => {
        calls.delete++
        const index = rows.findIndex((row) => row.id === id)
        if (index >= 0) rows.splice(index, 1)
      },
      loadAll: async () => {
        calls.loadAll++
        return rows
      },
    },
    projectCollection: { all: [{ id: 'p1', workspaceId: 'w1' }] },
  }
  return { store, calls, rows }
}

test('a double tap sends one create and reports starred twice', async () => {
  const post = deferred<unknown>()
  const { store, calls } = makeStore(() => post.promise)
  const actions = createDomainActions(store as never)

  const first = actions.toggleStarProject('p1', 'u1')
  const second = actions.toggleStarProject('p1', 'u1')

  // The second tap must not delete the first tap's optimistic row.
  expect(await second).toBe(true)
  expect(calls.create).toBe(1)
  expect(calls.delete).toBe(0)

  post.resolve({})
  expect(await first).toBe(true)
})

test('a star the server already has is success, not an error', async () => {
  const { store, calls } = makeStore(async () => {
    throw Object.assign(new Error('Project is already starred'), {
      name: 'ShogoError',
      status: 400,
      details: { error: { code: 'already_starred', message: 'Project is already starred' } },
    })
  })
  const actions = createDomainActions(store as never)

  expect(await actions.toggleStarProject('p1', 'u1')).toBe(true)
  // The local collection was stale; it is refreshed so the UI shows the row.
  expect(calls.loadAll).toBe(1)
})

test('a genuine failure still rejects', async () => {
  const { store } = makeStore(async () => {
    throw Object.assign(new Error('Request failed with status 500'), {
      name: 'ShogoError',
      status: 500,
    })
  })
  const actions = createDomainActions(store as never)

  await expect(actions.toggleStarProject('p1', 'u1')).rejects.toThrow('500')
})

test('unstar still works, and a double tap on it sends one delete', async () => {
  const remove = deferred<unknown>()
  const { store, calls, rows } = makeStore(async () => ({}))
  rows.push({ id: 's1', projectId: 'p1', userId: 'u1' })
  store.starredProjectCollection.delete = async (id: string) => {
    calls.delete++
    await remove.promise
    const index = rows.findIndex((row) => row.id === id)
    if (index >= 0) rows.splice(index, 1)
  }
  const actions = createDomainActions(store as never)

  const first = actions.toggleStarProject('p1', 'u1')
  const second = actions.toggleStarProject('p1', 'u1')

  expect(await second).toBe(false)
  expect(calls.delete).toBe(1)
  expect(calls.create).toBe(0)

  remove.resolve({})
  expect(await first).toBe(false)
})
