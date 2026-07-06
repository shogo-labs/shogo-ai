// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

// @ts-ignore Bun resolves this module at test runtime; app tsconfig does not include Bun ambient types.
import { expect, test } from 'bun:test'
import { ProjectCollection } from '@shogo/domain-stores'
import { startProjectNameRefinement } from '../home-project-rename'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const baseProject = {
  id: 'p1',
  name: 'New Project',
  workspaceId: 'w1',
  updatedAt: 1,
}

test('ProjectCollection reproduces the Sentry race by rejecting overlapping updates for the same project', async () => {
  const firstPatch = deferred<{ data: { ok: boolean; data: typeof baseProject } }>()
  let patchCount = 0
  const collection = ProjectCollection.create(
    { items: { p1: baseProject } },
    {
      http: {
        get: async () => ({ data: { ok: true } }),
        post: async () => ({ data: { ok: true } }),
        patch: async (_url: string, changes: Partial<typeof baseProject>) => {
          patchCount += 1
          if (patchCount === 1) return firstPatch.promise
          return {
            data: {
              ok: true,
              data: { ...baseProject, ...changes, updatedAt: Date.now() },
            },
          }
        },
        delete: async () => ({ data: { ok: true } }),
      },
    } as never,
  )

  const firstUpdate = collection.update('p1', { name: 'Counter Strike Game' })
  await expect(collection.update('p1', { name: 'Counter Strike Mobile' })).rejects.toThrow(
    'Update already in progress',
  )

  firstPatch.resolve({
    data: {
      ok: true,
      data: { ...baseProject, name: 'Counter Strike Game', updatedAt: 2 },
    },
  })
  await firstUpdate
})

test('home project name refinement waits for the heuristic rename before applying the AI rename', async () => {
  const firstPatch = deferred<{ data: { ok: boolean; data: typeof baseProject } }>()
  const patchChanges: Array<Partial<typeof baseProject> & { description?: string }> = []
  const collection = ProjectCollection.create(
    { items: { p1: baseProject } },
    {
      http: {
        get: async () => ({ data: { ok: true } }),
        post: async () => ({ data: { ok: true } }),
        patch: async (_url: string, changes: Partial<typeof baseProject> & { description?: string }) => {
          patchChanges.push(changes)
          if (patchChanges.length === 1) return firstPatch.promise
          return {
            data: {
              ok: true,
              data: { ...baseProject, ...changes, updatedAt: Date.now() },
            },
          }
        },
        delete: async () => ({ data: { ok: true } }),
      },
    } as never,
  )
  const chatSessionUpdates: Array<{ inferredName?: string }> = []
  const errors: unknown[] = []

  const { heuristicRename, generatedRename } = startProjectNameRefinement({
    actions: {
      updateProject: (projectId, changes) => collection.update(projectId, changes as never),
      updateChatSession: async (_chatSessionId, changes) => {
        chatSessionUpdates.push(changes)
      },
    },
    projectId: 'p1',
    chatSessionId: 's1',
    chatScope: 'project',
    text: 'Create a shooting mobile game like counter strike',
    heuristicName: 'Counter Strike Game',
    generateProjectName: async () => ({
      name: 'Counter Strike Mobile',
      description: 'A premium tactical shooter',
    }),
    onError: (_message, error) => errors.push(error),
  })

  await Promise.resolve()
  await Promise.resolve()
  expect(patchChanges).toEqual([{ name: 'Counter Strike Game' }])

  firstPatch.resolve({
    data: {
      ok: true,
      data: { ...baseProject, name: 'Counter Strike Game', updatedAt: 2 },
    },
  })

  await heuristicRename
  await generatedRename

  expect(errors).toEqual([])
  expect(patchChanges).toEqual([
    { name: 'Counter Strike Game' },
    { name: 'Counter Strike Mobile', description: 'A premium tactical shooter' },
  ])
  expect(chatSessionUpdates).toEqual([{ inferredName: 'Counter Strike Mobile' }])
})
