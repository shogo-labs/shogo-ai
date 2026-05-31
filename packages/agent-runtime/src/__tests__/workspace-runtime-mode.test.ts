// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, it } from 'bun:test'
import {
  isWorkspaceRuntimeMode,
  workspaceRuntimeId,
  workspaceAttachedProjectIds,
  workspaceProjectsManifest,
  renderWorkspaceManifestMarkdown,
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

describe('workspaceProjectsManifest', () => {
  it('parses and sanitises the catalog, defaulting name to id', () => {
    const env = {
      WORKSPACE_RUNTIME: 'true',
      WORKSPACE_PROJECTS: JSON.stringify([
        { id: 'p1', name: 'alpha-api' },
        { id: 'p2' },
        { name: 'no-id' },
        'garbage',
      ]),
    } as any
    expect(workspaceProjectsManifest(env)).toEqual([
      { id: 'p1', name: 'alpha-api' },
      { id: 'p2', name: 'p2' },
    ])
  })
  it('returns [] when not in workspace mode or malformed', () => {
    expect(workspaceProjectsManifest({ WORKSPACE_PROJECTS: '[]' } as any)).toEqual([])
    expect(workspaceProjectsManifest({ WORKSPACE_RUNTIME: 'true', WORKSPACE_PROJECTS: '{not json' } as any)).toEqual([])
    expect(workspaceProjectsManifest({ WORKSPACE_RUNTIME: 'true' } as any)).toEqual([])
  })
})

describe('renderWorkspaceManifestMarkdown', () => {
  it('lists each project folder with its name', () => {
    const md = renderWorkspaceManifestMarkdown('ws-1', [
      { id: 'p1', name: 'alpha-api' },
      { id: 'p2', name: 'beta-web' },
    ])
    expect(md).toContain('workspace `ws-1`')
    expect(md).toContain('`p1/` — **alpha-api**')
    expect(md).toContain('`p2/` — **beta-web**')
  })
  it('handles the empty case', () => {
    expect(renderWorkspaceManifestMarkdown('ws-1', [])).toContain('_No projects attached._')
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
