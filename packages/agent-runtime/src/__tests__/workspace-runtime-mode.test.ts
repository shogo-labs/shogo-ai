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
  shouldRunGitWorkspaceSync,
  parseWorkspacePreviewPath,
  buildWorkspacePreviewPath,
  isAttachedProjectId,
  parseWorkspacePreviewUrls,
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
    // Ownership clarification: keeps the agent from treating the sibling
    // folders as other users' projects and refusing them on privacy grounds.
    expect(md).toContain('belong to the current user')
    expect(md).toContain("NOT other users' projects")
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

describe('parseWorkspacePreviewPath', () => {
describe('shouldRunGitWorkspaceSync', () => {
  it('runs for managed projects when git sync is wanted and no worker owns sync', () => {
    expect(
      shouldRunGitWorkspaceSync({ workingMode: 'managed', workerOwnsSync: false, wantGitSync: true }),
    ).toBe(true)
  })

  it('NEVER runs for external projects — the user owns their repo/git workflow', () => {
    // This is the regression guard: cloudSyncMode defaults to git_only
    // (incl. on desktop), so without the external check, opening a folder
    // would auto-commit `auto: <ts>` into the user's working tree.
    expect(
      shouldRunGitWorkspaceSync({ workingMode: 'external', workerOwnsSync: false, wantGitSync: true }),
    ).toBe(false)
  })

  it('does not run when a paired worker owns sync (SHOGO_CLOUD_SYNC=1)', () => {
    expect(
      shouldRunGitWorkspaceSync({ workingMode: 'managed', workerOwnsSync: true, wantGitSync: true }),
    ).toBe(false)
  })

  it('does not run in non-git sync modes (wantGitSync=false, e.g. plain s3)', () => {
    expect(
      shouldRunGitWorkspaceSync({ workingMode: 'managed', workerOwnsSync: false, wantGitSync: false }),
    ).toBe(false)
  })
})

  it('parses the project root with no trailing slash', () => {
    expect(parseWorkspacePreviewPath('/p/abc')).toEqual({ projectId: 'abc', rest: '/' })
  })
  it('treats a trailing slash as root', () => {
    expect(parseWorkspacePreviewPath('/p/abc/')).toEqual({ projectId: 'abc', rest: '/' })
  })
  it('captures the remainder including nested asset paths', () => {
    expect(parseWorkspacePreviewPath('/p/abc/assets/app.js')).toEqual({
      projectId: 'abc',
      rest: '/assets/app.js',
    })
  })
  it('parses uuid-style project ids', () => {
    const uuid = 'c4cf1ca6-19d9-48ac-99d8-dab9e1b75b22'
    expect(parseWorkspacePreviewPath(`/p/${uuid}/index.html`)).toEqual({
      projectId: uuid,
      rest: '/index.html',
    })
  })
  it('returns null for non-preview paths', () => {
    expect(parseWorkspacePreviewPath('/agent/chat')).toBeNull()
    expect(parseWorkspacePreviewPath('/')).toBeNull()
    expect(parseWorkspacePreviewPath('/p/')).toBeNull()
    expect(parseWorkspacePreviewPath('/p')).toBeNull()
  })
  it('rejects path traversal and unsafe ids', () => {
    expect(parseWorkspacePreviewPath('/p/../etc/passwd')).toBeNull()
    expect(parseWorkspacePreviewPath('/p/.hidden')).toBeNull()
  })
})

describe('buildWorkspacePreviewPath', () => {
  it('round-trips with parse', () => {
    expect(buildWorkspacePreviewPath('abc')).toBe('/p/abc/')
    expect(buildWorkspacePreviewPath('abc', '/assets/app.js')).toBe('/p/abc/assets/app.js')
    expect(buildWorkspacePreviewPath('abc', 'assets/app.js')).toBe('/p/abc/assets/app.js')
  })
})

describe('isAttachedProjectId', () => {
  it('is a membership check', () => {
    expect(isAttachedProjectId('p1', ['p1', 'p2'])).toBe(true)
    expect(isAttachedProjectId('p3', ['p1', 'p2'])).toBe(false)
  })
})

describe('parseWorkspacePreviewUrls', () => {
  it('parses a per-project url map in workspace mode', () => {
    const env = {
      WORKSPACE_RUNTIME: 'true',
      WORKSPACE_PREVIEW_URLS: JSON.stringify({ p1: 'https://a.example', p2: 'https://b.example' }),
    } as any
    expect(parseWorkspacePreviewUrls(env)).toEqual({ p1: 'https://a.example', p2: 'https://b.example' })
  })
  it('drops non-string / empty values', () => {
    const env = {
      WORKSPACE_RUNTIME: 'true',
      WORKSPACE_PREVIEW_URLS: JSON.stringify({ p1: 'https://a.example', p2: '', p3: 5 }),
    } as any
    expect(parseWorkspacePreviewUrls(env)).toEqual({ p1: 'https://a.example' })
  })
  it('returns {} outside workspace mode or when malformed', () => {
    expect(parseWorkspacePreviewUrls({ WORKSPACE_PREVIEW_URLS: '{}' } as any)).toEqual({})
    expect(parseWorkspacePreviewUrls({ WORKSPACE_RUNTIME: 'true', WORKSPACE_PREVIEW_URLS: '{bad' } as any)).toEqual({})
    expect(parseWorkspacePreviewUrls({ WORKSPACE_RUNTIME: 'true' } as any)).toEqual({})
  })
})
