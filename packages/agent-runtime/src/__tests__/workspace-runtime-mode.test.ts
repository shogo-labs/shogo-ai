// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, it } from 'bun:test'
import {
  isWorkspaceRuntimeMode,
  workspaceRuntimeId,
  workspaceAttachedProjectIds,
  shouldSkipManagedSeeding,
  shouldEnforceProjectIdSanity,
} from '../workspace-runtime-mode'

describe('isWorkspaceRuntimeMode', () => {
  it('is true only when WORKSPACE_RUNTIME=true', () => {
    expect(isWorkspaceRuntimeMode({ WORKSPACE_RUNTIME: 'true' } as any)).toBe(true)
    expect(isWorkspaceRuntimeMode({ WORKSPACE_RUNTIME: 'false' } as any)).toBe(false)
    expect(isWorkspaceRuntimeMode({} as any)).toBe(false)
  })
})

describe('workspaceRuntimeId', () => {
  it('returns WORKSPACE_ID in workspace mode', () => {
    expect(workspaceRuntimeId({ WORKSPACE_RUNTIME: 'true', WORKSPACE_ID: 'ws-1' } as any)).toBe('ws-1')
  })
  it('returns null outside workspace mode', () => {
    expect(workspaceRuntimeId({ WORKSPACE_ID: 'ws-1' } as any)).toBeNull()
  })
})

describe('workspaceAttachedProjectIds', () => {
  it('parses and trims the comma list', () => {
    expect(
      workspaceAttachedProjectIds({ WORKSPACE_RUNTIME: 'true', WORKSPACE_PROJECT_IDS: 'p1, p2 ,p3' } as any),
    ).toEqual(['p1', 'p2', 'p3'])
  })
  it('returns [] when unset or not in workspace mode', () => {
    expect(workspaceAttachedProjectIds({ WORKSPACE_RUNTIME: 'true' } as any)).toEqual([])
    expect(workspaceAttachedProjectIds({ WORKSPACE_PROJECT_IDS: 'p1' } as any)).toEqual([])
  })
})

describe('shouldSkipManagedSeeding', () => {
  it('skips for external folder projects', () => {
    expect(shouldSkipManagedSeeding({ workingMode: 'external', isWorkspaceRuntime: false })).toBe(true)
  })
  it('skips for workspace runtimes', () => {
    expect(shouldSkipManagedSeeding({ workingMode: 'managed', isWorkspaceRuntime: true })).toBe(true)
  })
  it('seeds for a normal managed single-project runtime', () => {
    expect(shouldSkipManagedSeeding({ workingMode: 'managed', isWorkspaceRuntime: false })).toBe(false)
  })
})

describe('shouldEnforceProjectIdSanity', () => {
  it('enforces only for managed single-project runtimes', () => {
    expect(shouldEnforceProjectIdSanity({ workingMode: 'managed', isWorkspaceRuntime: false })).toBe(true)
    expect(shouldEnforceProjectIdSanity({ workingMode: 'external', isWorkspaceRuntime: false })).toBe(false)
    expect(shouldEnforceProjectIdSanity({ workingMode: 'managed', isWorkspaceRuntime: true })).toBe(false)
  })
})
