// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Tests for useActiveWorkspace.
 *
 * The hook's core logic is: find stored workspace by id, or fall back to
 * the first workspace, or return null. We test this by mocking the two
 * dependencies (useWorkspaceCollection and getActiveWorkspaceId) and
 * rendering the hook via RTL's renderHook.
 */

import { describe, test, expect, mock, beforeEach } from 'bun:test'
import { renderHook } from '@testing-library/react'

let mockWorkspaces: { id: string; name: string }[] = []
let mockStoredId: string | null = null

mock.module('../../contexts/domain', () => ({
  useWorkspaceCollection: () => ({
    all: mockWorkspaces,
  }),
}))

mock.module('../../lib/workspace-store', () => ({
  getActiveWorkspaceId: () => mockStoredId,
}))

const { useActiveWorkspace } = await import('../useActiveWorkspace')

describe('useActiveWorkspace', () => {
  beforeEach(() => {
    mockWorkspaces = []
    mockStoredId = null
  })

  test('returns null when no workspaces exist', () => {
    const { result } = renderHook(() => useActiveWorkspace())
    expect(result.current).toBeNull()
  })

  test('returns first workspace when no stored id', () => {
    mockWorkspaces = [
      { id: 'ws-1', name: 'First' },
      { id: 'ws-2', name: 'Second' },
    ]
    const { result } = renderHook(() => useActiveWorkspace())
    expect(result.current).toEqual({ id: 'ws-1', name: 'First' })
  })

  test('returns stored workspace when id matches', () => {
    mockWorkspaces = [
      { id: 'ws-1', name: 'First' },
      { id: 'ws-2', name: 'Second' },
    ]
    mockStoredId = 'ws-2'
    const { result } = renderHook(() => useActiveWorkspace())
    expect(result.current).toEqual({ id: 'ws-2', name: 'Second' })
  })

  test('falls back to first workspace when stored id does not match any', () => {
    mockWorkspaces = [
      { id: 'ws-1', name: 'First' },
      { id: 'ws-2', name: 'Second' },
    ]
    mockStoredId = 'ws-deleted'
    const { result } = renderHook(() => useActiveWorkspace())
    expect(result.current).toEqual({ id: 'ws-1', name: 'First' })
  })

  test('returns null when workspaces collection has empty array', () => {
    mockWorkspaces = []
    mockStoredId = 'ws-1'
    const { result } = renderHook(() => useActiveWorkspace())
    expect(result.current).toBeNull()
  })
})
