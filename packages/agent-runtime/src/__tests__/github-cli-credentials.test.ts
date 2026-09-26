// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { beforeEach, describe, expect, mock, test } from 'bun:test'

const calls: string[] = []
let response: {
  ok: boolean
  status: number
  data?: { token?: string; expiresAt?: string; name?: string; email?: string }
  error?: string
} = { ok: false, status: 409, error: 'none' }

mock.module('../internal-api', () => ({
  projectScopedId: (projectId: string | null | undefined) => {
    if (!projectId || projectId === '__POOL__' || projectId.startsWith('ws:')) return undefined
    return projectId
  },
  getGitHubCliCredentials: async (projectId: string) => {
    calls.push(projectId)
    return response
  },
}))

const { githubCliEnvForProject, githubCliEnvFromCredentials, clearGitHubCliEnvCache } = await import(
  '../github-cli-credentials'
)

describe('githubCliEnvFromCredentials', () => {
  test('sets GH_TOKEN and the bot git identity', () => {
    const built = githubCliEnvFromCredentials({
      token: 'ghs_test',
      expiresAt: '2099-01-01T00:00:00Z',
      name: 'shogo-ai[bot]',
      email: '1+shogo-ai[bot]@users.noreply.github.com',
    })
    expect(built?.env).toEqual({
      GH_TOKEN: 'ghs_test',
      GIT_AUTHOR_NAME: 'shogo-ai[bot]',
      GIT_AUTHOR_EMAIL: '1+shogo-ai[bot]@users.noreply.github.com',
      GIT_COMMITTER_NAME: 'shogo-ai[bot]',
      GIT_COMMITTER_EMAIL: '1+shogo-ai[bot]@users.noreply.github.com',
    })
  })

  test('returns null without a token', () => {
    expect(githubCliEnvFromCredentials({})).toBeNull()
  })
})

describe('githubCliEnvForProject', () => {
  beforeEach(() => {
    calls.length = 0
    clearGitHubCliEnvCache()
    response = {
      ok: true,
      status: 200,
      data: {
        token: 'ghs_test',
        expiresAt: '2099-01-01T00:00:00Z',
        name: 'shogo-ai[bot]',
        email: '1+shogo-ai[bot]@users.noreply.github.com',
      },
    }
  })

  test('caches a live token and skips a second mint', async () => {
    const first = await githubCliEnvForProject('proj_1')
    const second = await githubCliEnvForProject('proj_1')
    expect(first.GH_TOKEN).toBe('ghs_test')
    expect(second).toEqual(first)
    expect(calls).toEqual(['proj_1'])
  })

  test('returns nothing for a pool or workspace runtime', async () => {
    expect(await githubCliEnvForProject('__POOL__')).toEqual({})
    expect(await githubCliEnvForProject('ws:abc')).toEqual({})
    expect(calls).toEqual([])
  })

  test('returns nothing when the project has no GitHub App', async () => {
    response = { ok: false, status: 409, error: 'no connection' }
    expect(await githubCliEnvForProject('proj_1')).toEqual({})
    expect(calls).toEqual(['proj_1'])
  })
})
