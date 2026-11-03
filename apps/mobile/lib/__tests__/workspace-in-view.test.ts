// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import { workspaceInView } from '../workspace-in-view'

describe('workspaceInView (SHO-285)', () => {
  test('a cloud workspace is in view as itself', () => {
    expect(workspaceInView({ id: 'ws-1', name: 'Acme', kind: 'team' })).toEqual({
      id: 'ws-1',
      name: 'Acme',
      kind: 'team',
      host: 'cloud',
    })
  })

  test('a hosted workspace keeps its own id and names its host', () => {
    expect(workspaceInView({ id: 'ws-2', name: 'Samsara', kind: 'personal', hostInstanceId: 'inst-odin' })).toEqual({
      id: 'ws-2',
      name: 'Samsara',
      kind: 'personal',
      host: 'machine',
      instanceId: 'inst-odin',
    })
  })

  test('nothing selected is nothing in view', () => {
    expect(workspaceInView(null)).toBeNull()
    expect(workspaceInView({ id: null })).toBeNull()
  })
})
