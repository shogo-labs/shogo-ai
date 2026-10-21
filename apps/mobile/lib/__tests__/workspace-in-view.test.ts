// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-130: a paired computer's own workspace is the workspace *in view*.
 *
 * `useActiveWorkspace()` answers the cloud workspace — identity, billing and
 * membership stay the cloud account's — so every surface that shows or scopes
 * workspace data reads `workspaceInView` instead. These tests pin the one rule
 * the whole switch depends on: while a machine workspace is open it wins, and
 * the cloud workspace comes back the moment the overlay is dropped.
 */
import { describe, expect, test } from 'bun:test'
import { machineWorkspaceInView, workspaceInView } from '../workspace-in-view'
import type { ActiveInstance } from '../../contexts/active-instance'

const cloud = { id: 'cloud-personal', name: 'Local User Personal', kind: 'personal' }

function machine(overrides: Partial<ActiveInstance> = {}): ActiveInstance {
  return {
    instanceId: 'machine-1',
    name: 'Studio Mac',
    hostname: 'studio-mac',
    workspaceId: 'cloud-personal',
    kind: 'desktop',
    source: 'machine',
    localWorkspaceId: 'machine-team',
    localWorkspaceName: 'Studio Mac Team',
    localWorkspaceKind: 'team',
    ...overrides,
  }
}

describe('machineWorkspaceInView', () => {
  test('is null unless a machine workspace is open', () => {
    expect(machineWorkspaceInView(null)).toBeNull()
    expect(machineWorkspaceInView(undefined)).toBeNull()
    // A legacy remote-control instance points at a *cloud* workspace's device:
    // there is no machine workspace in view.
    expect(machineWorkspaceInView({ ...machine(), source: undefined })).toBeNull()
    expect(machineWorkspaceInView(machine({ localWorkspaceId: undefined }))).toBeNull()
  })

  test('carries the machine’s own id, name and kind', () => {
    expect(machineWorkspaceInView(machine())).toEqual({
      id: 'machine-team',
      name: 'Studio Mac Team',
      kind: 'team',
      host: 'machine',
      instanceId: 'machine-1',
    })
  })

  test('treats an older record with no kind as a team workspace', () => {
    // The same fail-safe `workspaceExperience()` uses for an unknown kind: a
    // machine workspace must never silently get the personal shell.
    expect(machineWorkspaceInView(machine({ localWorkspaceKind: undefined }))?.kind).toBe('team')
  })

  test('falls back to the machine name when the workspace name was never stored', () => {
    expect(machineWorkspaceInView(machine({ localWorkspaceName: undefined }))?.name).toBe('Studio Mac')
  })
})

describe('workspaceInView', () => {
  test('is the machine workspace while one is open, whatever the cloud selection is', () => {
    expect(workspaceInView(cloud, machine())?.id).toBe('machine-team')
    // …and it stays the machine's when the cloud list has not loaded yet.
    expect(workspaceInView(null, machine())?.id).toBe('machine-team')
  })

  test('is the cloud workspace once the machine overlay is dropped', () => {
    expect(workspaceInView(cloud, null)).toEqual({
      id: 'cloud-personal',
      name: 'Local User Personal',
      kind: 'personal',
      host: 'cloud',
    })
  })

  test('is null before either is known', () => {
    expect(workspaceInView(null, null)).toBeNull()
    expect(workspaceInView({ id: null }, null)).toBeNull()
  })
})
