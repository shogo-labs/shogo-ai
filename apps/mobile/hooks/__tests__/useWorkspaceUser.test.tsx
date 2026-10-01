// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * In a cloud team workspace on desktop, "me" is the Shogo Cloud account, so
 * own-message, reaction and presence checks match cloud author ids.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { act, cleanup, renderHook } from '@testing-library/react'

mock.module('../../contexts/auth', () => ({
  useAuth: () => ({ user: { id: 'local-user', name: 'Local Me', email: null } }),
}))

const { useWorkspaceUser } = await import('../useWorkspaceUser')
const { _resetWorkspaceRouteForTests, setCloudWorkspacesState } = await import('../../lib/workspace-route')
const { clearActiveWorkspaceId, setActiveWorkspaceId } = await import('../../lib/workspace-store')

beforeEach(() => {
  localStorage.clear()
  _resetWorkspaceRouteForTests()
  clearActiveWorkspaceId()
  setCloudWorkspacesState({
    signedIn: true,
    cloudUrl: null,
    reachable: true,
    user: { id: 'cloud-user', name: 'Russ', email: 'russ@example.com' },
    workspaces: [{ id: 'ws-acme', name: 'Acme', slug: 'acme', kind: 'team' }],
  })
})

afterEach(() => {
  cleanup()
  localStorage.clear()
})

describe('useWorkspaceUser', () => {
  test('is the local user in a local workspace and the cloud user in a cloud one', async () => {
    setActiveWorkspaceId('local-ws')
    const { result } = renderHook(() => useWorkspaceUser())
    await act(async () => {})
    expect(result.current).toEqual({ id: 'local-user', name: 'Local Me', email: null, source: 'local' })

    await act(async () => {
      setActiveWorkspaceId('ws-acme')
      await Promise.resolve()
    })
    // The desktop API maps cloud-user <-> local-user, so the id stays local.
    expect(result.current).toEqual({ id: 'local-user', name: 'Russ', email: 'russ@example.com', source: 'cloud' })
  })

  test('an explicit workspace wins over the active one', () => {
    setActiveWorkspaceId('local-ws')
    const { result } = renderHook(() => useWorkspaceUser('ws-acme'))
    expect(result.current?.source).toBe('cloud')
  })
})
