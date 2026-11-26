// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The project list on the device (SHO-580): scoped like the other caches,
 * readable on the first frame, and never emptied by a failed load.
 */

import { resolve } from 'node:path'
import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'

const store = new Map<string, string>()
mock.module('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => store.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      store.set(key, value)
    },
    removeItem: async (key: string) => {
      store.delete(key)
    },
    getAllKeys: async () => [...store.keys()],
    multiRemove: async (keys: string[]) => {
      keys.forEach((key) => store.delete(key))
    },
  },
}))

let cache: typeof import('../projects-cache')
beforeAll(async () => {
  cache = await import('../projects-cache')
})

type Project = { id: string; name: string; createdAt: number }
type Folder = { id: string; name: string }

const PROJECTS: Project[] = [
  { id: 'p1', name: 'One', createdAt: 1 },
  { id: 'p2', name: 'Two', createdAt: 2 },
]
const FOLDERS: Folder[] = [{ id: 'f1', name: 'Folder' }]

afterEach(async () => {
  await cache.clearProjectsCache()
  cache.resetProjectsCacheState()
  store.clear()
})

const flush = () => new Promise((resolve) => setTimeout(resolve, 1_100))

describe('projects cache key', () => {
  test('is scoped by user, origin and workspace — and refuses to be unscoped', () => {
    expect(cache.projectsCacheKey('u1', 'cloud', 'w1')).toBe('u1:cloud:w1')
    expect(cache.projectsCacheKey('u1', 'machine-7', 'w1')).not.toBe(
      cache.projectsCacheKey('u1', 'cloud', 'w1'),
    )
    expect(cache.projectsCacheKey('u2', 'cloud', 'w1')).not.toBe(
      cache.projectsCacheKey('u1', 'cloud', 'w1'),
    )
    // Signed out, or a paired machine's own workspace: fetch without caching
    // rather than share one anonymous list.
    expect(cache.projectsCacheKey(null, 'cloud', 'w1')).toBeNull()
    expect(cache.projectsCacheKey('u1', 'cloud', null)).toBeNull()
  })
})

describe('projects cache storage', () => {
  test('a write paints on the next frame and survives a relaunch', async () => {
    const key = 'u1:cloud:w1'
    cache.writeCachedProjects(key, { projects: PROJECTS, folders: FOLDERS })
    expect(cache.peekCachedProjects<Project, Folder>(key)?.projects.map((p) => p.id)).toEqual([
      'p1',
      'p2',
    ])

    await flush()
    cache.resetProjectsCacheState()
    expect(cache.peekCachedProjects(key)).toBeNull()

    const read = await cache.readCachedProjects<Project, Folder>(key)
    expect(read?.projects.map((p) => p.id)).toEqual(['p1', 'p2'])
    expect(read?.folders.map((f) => f.id)).toEqual(['f1'])
  })

  test("one workspace's rows never answer for another's", async () => {
    cache.writeCachedProjects('u1:cloud:w1', { projects: PROJECTS, folders: [] })
    cache.writeCachedProjects('u1:cloud:w2', { projects: [{ id: 'p9', name: 'Nine', createdAt: 9 }], folders: [] })

    expect(cache.peekCachedProjects<Project, Folder>('u1:cloud:w1')?.projects.map((p) => p.id)).toEqual([
      'p1',
      'p2',
    ])
    expect(cache.peekCachedProjects<Project, Folder>('u1:cloud:w2')?.projects.map((p) => p.id)).toEqual(['p9'])
  })

  test('a failed or empty load does not erase what the person was looking at', async () => {
    const key = 'u1:cloud:w1'
    cache.writeCachedProjects(key, { projects: PROJECTS, folders: FOLDERS })

    // A load that came back empty is not written unless the caller says so.
    cache.writeCachedProjects(key, { projects: [], folders: [] })
    expect(cache.peekCachedProjects<Project, Folder>(key)?.projects).toHaveLength(2)

    // …but a workspace whose last project was deleted must not keep a ghost row.
    cache.writeCachedProjects(key, { projects: [], folders: [] }, { allowEmpty: true })
    expect(cache.peekCachedProjects<Project, Folder>(key)?.projects).toHaveLength(0)
  })

  test('clearing drops every environment and workspace', async () => {
    cache.writeCachedProjects('u1:cloud:w1', { projects: PROJECTS, folders: [] })
    await flush()
    expect(store.size).toBeGreaterThan(0)

    await cache.clearProjectsCache()
    expect(cache.peekCachedProjects('u1:cloud:w1')).toBeNull()
    expect(store.size).toBe(0)
  })

  test('a very large workspace is capped', async () => {
    const many: Project[] = Array.from({ length: cache.MAX_CACHED_PROJECTS + 25 }, (_, i) => ({
      id: `p${i}`,
      name: `P${i}`,
      createdAt: i,
    }))
    cache.writeCachedProjects('u1:cloud:w1', { projects: many, folders: [] })
    expect(cache.peekCachedProjects<Project, Folder>('u1:cloud:w1')?.projects).toHaveLength(
      cache.MAX_CACHED_PROJECTS,
    )
  })
})

/**
 * SHO-581 — the project open screen. It is routed to an id, so the row is kept
 * by project (not by workspace), and it paints before the network answers while
 * never outliving one, and never being erased by a failed load.
 */
describe('one project on the device', () => {
  const rowKey = 'u1:cloud:project:p1'

  test('the key is scoped by user, origin and project, and refused when unscoped', () => {
    expect(cache.cachedProjectKey('u1', 'cloud', 'p1')).toBe('u1:cloud:project:p1')
    expect(cache.cachedProjectKey('u2', 'cloud', 'p1')).not.toBe(
      cache.cachedProjectKey('u1', 'cloud', 'p1'),
    )
    expect(cache.cachedProjectKey('u1', 'cloud', 'p2')).not.toBe(
      cache.cachedProjectKey('u1', 'cloud', 'p1'),
    )
    expect(cache.cachedProjectKey(null, 'cloud', 'p1')).toBeNull()
    expect(cache.cachedProjectKey('u1', 'cloud', null)).toBeNull()
  })

  test('AC4: the cached row paints before the network answer, and the answer wins', () => {
    const cached: Project = { id: 'p1', name: 'Atlas', createdAt: 1 }
    const loaded: Project = { id: 'p1', name: 'Atlas (renamed)', createdAt: 1 }

    expect(cache.firstPaintProject(cached, null)).toBe(cached)
    expect(cache.firstPaintProject(cached, loaded)).toBe(loaded)
    expect(cache.firstPaintProject(null, null)).toBeNull()
  })

  test('AC1: the row is readable on the next frame and after a relaunch', async () => {
    const project: Project = { id: 'p1', name: 'Atlas', createdAt: 1 }
    cache.writeCachedProject(rowKey, project)

    expect(cache.peekCachedProject<Project>(rowKey)).toEqual(project)

    await flush()
    cache.resetProjectsCacheState()
    expect(cache.peekCachedProject(rowKey)).toBeNull()

    expect(await cache.readCachedProject<Project>(rowKey)).toEqual(project)
  })

  test('AC4: a failed or empty load never erases the cached row', async () => {
    const project: Project = { id: 'p1', name: 'Atlas', createdAt: 1 }
    cache.writeCachedProject(rowKey, project)

    cache.writeCachedProject(rowKey, null)
    cache.writeCachedProject(rowKey, undefined)
    expect(cache.peekCachedProject<Project>(rowKey)).toEqual(project)

    await flush()
    cache.resetProjectsCacheState()
    expect(await cache.readCachedProject<Project>(rowKey)).toEqual(project)
  })

  test('a row never answers for another project or user', () => {
    cache.writeCachedProject(rowKey, { id: 'p1', name: 'Atlas', createdAt: 1 })

    expect(cache.peekCachedProject(cache.cachedProjectKey('u1', 'cloud', 'p2'))).toBeNull()
    expect(cache.peekCachedProject(cache.cachedProjectKey('u2', 'cloud', 'p1'))).toBeNull()
  })

  test('clearing drops the rows with the lists', async () => {
    cache.writeCachedProjects('u1:cloud:w1', { projects: PROJECTS, folders: [] })
    cache.writeCachedProject(rowKey, PROJECTS[0])
    await flush()
    expect(store.size).toBeGreaterThan(0)

    await cache.clearProjectsCache()
    expect(cache.peekCachedProject(rowKey)).toBeNull()
    expect(store.size).toBe(0)
  })
})
