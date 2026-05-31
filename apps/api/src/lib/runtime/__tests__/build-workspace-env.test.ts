// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, it } from 'bun:test'
import { buildWorkspaceEnv } from '../build-workspace-env'

const seams = {
  _loadWorkspace: async () => ({ name: 'My WS', composioScope: 'workspace' }),
  _getProjectOwnerUserId: async () => 'owner-1',
  _generateProxyToken: async (projectId: string) => `tok-${projectId}`,
  _loadProjects: async (ids: string[]) =>
    ids.map((id) => ({ id, name: id === 'p1' ? 'alpha-api' : id === 'p2' ? 'beta-web' : null })),
}

describe('buildWorkspaceEnv', () => {
  it('emits the workspace markers and project catalog', async () => {
    const env = await buildWorkspaceEnv('ws-1', ['p1', 'p2'], seams as any)
    expect(env.WORKSPACE_ID).toBe('ws-1')
    expect(env.WORKSPACE_RUNTIME).toBe('true')
    expect(env.WORKSPACE_PROJECT_IDS).toBe('p1,p2')
    expect(env.AGENT_NAME).toBe('My WS')

    const catalog = JSON.parse(env.WORKSPACE_PROJECTS)
    expect(catalog).toEqual([
      { id: 'p1', name: 'alpha-api' },
      { id: 'p2', name: 'beta-web' },
    ])
  })

  it('mints a per-project token map and a back-compat default token', async () => {
    const env = await buildWorkspaceEnv('ws-1', ['p1', 'p2'], seams as any)
    const tokens = JSON.parse(env.AI_PROXY_TOKENS)
    expect(tokens).toEqual({ p1: 'tok-p1', p2: 'tok-p2' })
    expect(env.AI_PROXY_TOKEN).toBe('tok-p1') // first attached project
  })

  it('falls back to the id when a project has no name', async () => {
    const env = await buildWorkspaceEnv('ws-1', ['p3'], seams as any)
    expect(JSON.parse(env.WORKSPACE_PROJECTS)).toEqual([{ id: 'p3', name: 'p3' }])
  })

  it('handles a workspace with no attached projects', async () => {
    const env = await buildWorkspaceEnv('ws-1', [], seams as any)
    expect(env.WORKSPACE_PROJECT_IDS).toBe('')
    expect(JSON.parse(env.WORKSPACE_PROJECTS)).toEqual([])
    expect(env.AI_PROXY_TOKENS).toBe('{}')
  })

  it('requires a workspaceId', async () => {
    await expect(buildWorkspaceEnv('', [], seams as any)).rejects.toThrow(/workspaceId is required/)
  })
})
