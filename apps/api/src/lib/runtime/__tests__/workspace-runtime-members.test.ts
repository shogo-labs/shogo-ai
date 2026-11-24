// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-560: a workspace runtime must be able to rotate its AI proxy token.
 *
 * The runtime names itself `ws:<workspaceId>` (or `ws:proj:<anchor>`), and its
 * ~12 h refresh asks `/pod-config/<that key>` for a fresh token. These tests pin
 * the two things that make that refresh correct:
 *   - the member set it mints tokens for is the set the runtime booted with
 *     (metal: the anchor alone; Knative: the Service's baked ids), so a rotated
 *     token is never minted for a project the runtime is not serving; and
 *   - the response is `AI_PROXY_*` only — a refresh is applied additively and
 *     never unsets, so shipping topology keys would rewrite a live runtime's
 *     `WORKSPACE_PROJECT_IDS` / DB urls from a stale boot.
 */

process.env.AI_PROXY_SECRET = process.env.AI_PROXY_SECRET || 'test-secret-sho-560'
process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET || 'test-better-auth-sho-560'

import { describe, expect, it, mock } from 'bun:test'

// buildWorkspaceEnv resolves agent model defaults through the billing service,
// which has no seam and would otherwise reach a live Postgres (see
// build-workspace-env.test.ts).
mock.module('../../../services/billing.service', () => ({
  hasAdvancedModelAccess: async () => true,
}))

import { generateProxyToken, verifyProxyToken } from '../../ai-proxy-token'
import { workspaceRuntimeMembers, workspaceRuntimeRefreshMembers } from '../workspace-runtime-members'
import { buildWorkspaceRuntimeRefreshEnv } from '../workspace-runtime-refresh-env'

const envSeams = {
  _loadWorkspace: async () => ({ name: 'Odin', composioScope: 'workspace' }),
  _getProjectOwnerUserId: async () => 'owner-1',
  _getWorkspaceOwnerUserId: async () => 'ws-owner-1',
  _generateProxyToken: (projectId: string, workspaceId: string, userId: string | undefined, ttl: number) =>
    generateProxyToken(projectId, workspaceId, userId, ttl),
  _loadProjects: async (ids: string[]) => ids.map((id) => ({ id, name: id })),
  _loadAvailableProjects: async (_workspaceId: string) => [
    { id: 'p1', name: 'p1', description: null },
    { id: 'p2', name: 'p2', description: null },
  ],
}

describe('workspaceRuntimeMembers', () => {
  it('mounts the anchor alone on metal, and nothing for a workspace session', () => {
    expect(workspaceRuntimeMembers({ anchorProjectId: 'p1', forMetal: true })).toEqual(['p1'])
    expect(workspaceRuntimeMembers({ forMetal: true })).toEqual([])
    // A metal runtime never mounts a session's attachments — it reaches them
    // over the remote-tool channel.
    expect(workspaceRuntimeMembers({ forMetal: true, attachedProjectIds: ['p2', 'p3'] })).toEqual([])
  })

  it('prepends the anchor and dedupes on the session/cloud path', () => {
    expect(workspaceRuntimeMembers({ anchorProjectId: 'p1', attachedProjectIds: ['p1', 'p2'] })).toEqual([
      'p1',
      'p2',
    ])
    expect(workspaceRuntimeMembers({ attachedProjectIds: ['p2', 'p3'] })).toEqual(['p2', 'p3'])
    expect(workspaceRuntimeMembers({})).toEqual([])
  })
})

describe('workspaceRuntimeRefreshMembers', () => {
  it('reproduces the metal boot args and never reads a baked Service', async () => {
    let readBaked = 0
    const result = await workspaceRuntimeRefreshMembers(
      { workspaceId: 'W', anchorProjectId: 'p1' },
      {
        useMetal: () => true,
        bootedMembers: async () => {
          readBaked++
          return ['p2']
        },
      },
    )
    expect(result).toEqual({ members: ['p1'], forMetal: true })
    expect(readBaked).toBe(0)
    expect(await workspaceRuntimeRefreshMembers({ workspaceId: 'W' }, { useMetal: () => true })).toEqual({
      members: [],
      forMetal: true,
    })
  })

  it('uses the member set baked into the Knative Service', async () => {
    const result = await workspaceRuntimeRefreshMembers(
      { workspaceId: 'W', anchorProjectId: 'p1' },
      { useMetal: () => false, bootedMembers: async () => ['p1', 'p2'] },
    )
    expect(result).toEqual({ members: ['p1', 'p2'], forMetal: false })
  })

  it('falls back to the anchor when the baked members cannot be read', async () => {
    expect(
      await workspaceRuntimeRefreshMembers(
        { workspaceId: 'W', anchorProjectId: 'p1' },
        { useMetal: () => false, bootedMembers: async () => null },
      ),
    ).toEqual({ members: ['p1'], forMetal: false })
    expect(
      await workspaceRuntimeRefreshMembers(
        { workspaceId: 'W' },
        {
          useMetal: () => false,
          bootedMembers: async () => {
            throw new Error('k8s API down')
          },
        },
      ),
    ).toEqual({ members: [], forMetal: false })
  })
})

describe('buildWorkspaceRuntimeRefreshEnv', () => {
  it('mints a fresh token for a metal canvas runtime and ships only AI_PROXY_* keys', async () => {
    const oldToken = await generateProxyToken('p1', 'W', 'owner-1', 1000)
    const oldPayload = (await verifyProxyToken(oldToken))!

    const { members, forMetal, env } = await buildWorkspaceRuntimeRefreshEnv(
      { workspaceId: 'W', anchorProjectId: 'p1' },
      { useMetal: () => true, envSeams: envSeams as any },
    )

    expect(members).toEqual(['p1'])
    expect(forMetal).toBe(true)
    // Only AI proxy credentials: a refresh must never rewrite the live runtime's
    // topology from a stale boot env.
    expect(Object.keys(env).sort()).toEqual(['AI_PROXY_TOKEN', 'AI_PROXY_TOKENS', 'AI_PROXY_URL'])
    expect(env.AI_PROXY_URL).toContain('/api/ai/v1')

    const token = env.AI_PROXY_TOKEN
    expect(token).not.toBe(oldToken)
    const payload = (await verifyProxyToken(token))!
    expect(payload.projectId).toBe('p1')
    expect(payload.workspaceId).toBe('W')
    expect(payload.exp).toBeGreaterThan(oldPayload.exp)
    expect(JSON.parse(env.AI_PROXY_TOKENS)).toEqual({ p1: token })
  })

  it('mints the `workspace` sentinel token for a workspace runtime with no members', async () => {
    const { members, env } = await buildWorkspaceRuntimeRefreshEnv(
      { workspaceId: 'W' },
      { useMetal: () => true, envSeams: envSeams as any },
    )
    expect(members).toEqual([])
    expect(JSON.parse(env.AI_PROXY_TOKENS)).toEqual({})
    const payload = (await verifyProxyToken(env.AI_PROXY_TOKEN))!
    expect(payload.projectId).toBe('workspace')
    expect(payload.workspaceId).toBe('W')
  })

  it('mints the anchor token for a Knative canvas runtime with attachments', async () => {
    const { members, forMetal, env } = await buildWorkspaceRuntimeRefreshEnv(
      { workspaceId: 'W', anchorProjectId: 'p1' },
      { useMetal: () => false, bootedMembers: async () => ['p1', 'p2'], envSeams: envSeams as any },
    )
    expect(members).toEqual(['p1', 'p2'])
    expect(forMetal).toBe(false)
    const tokens = JSON.parse(env.AI_PROXY_TOKENS)
    expect(Object.keys(tokens)).toEqual(['p1', 'p2'])
    expect(env.AI_PROXY_TOKEN).toBe(tokens.p1)
    expect((await verifyProxyToken(env.AI_PROXY_TOKEN))!.projectId).toBe('p1')
  })
})
