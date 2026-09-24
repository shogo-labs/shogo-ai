// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, it } from 'bun:test'
import {
  isWorkspaceRuntimeMode,
  workspaceKind,
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
  resolveRuntimeIdentity,
  parseWorkspaceMounts,
  workspaceExternalProjectIds,
  shouldAutoStartAnchorPreview,
  userOwnedTrustGroups,
  type WorkspaceMount,
} from '../workspace-runtime-mode'

const MOUNTS: WorkspaceMount[] = [
  { mount: 'anchor', path: '/home/u/repo', projectId: 'anchor', kind: 'external', runtimeEnabled: false },
  { mount: 'lib', path: '/home/u/lib', projectId: 'anchor', kind: 'folder' },
  { mount: 'managed-1', path: '/data/workspaces/managed-1', projectId: 'managed-1', kind: 'managed' },
]
const WS_ENV = { WORKSPACE_RUNTIME: 'true', WORKSPACE_MOUNTS: JSON.stringify(MOUNTS) } as any

describe('workspace mounts', () => {
  it('parses WORKSPACE_MOUNTS on workspace runtimes only', () => {
    expect(parseWorkspaceMounts(WS_ENV)).toEqual(MOUNTS)
    expect(parseWorkspaceMounts({ WORKSPACE_MOUNTS: JSON.stringify(MOUNTS) } as any)).toEqual([])
  })

  it('drops malformed entries and malformed JSON', () => {
    const env = {
      WORKSPACE_RUNTIME: 'true',
      WORKSPACE_MOUNTS: JSON.stringify([...MOUNTS, { mount: '', path: '/x', projectId: 'p', kind: 'managed' }, { kind: 'bogus' }]),
    } as any
    expect(parseWorkspaceMounts(env)).toEqual(MOUNTS)
    expect(parseWorkspaceMounts({ WORKSPACE_RUNTIME: 'true', WORKSPACE_MOUNTS: '{nope' } as any)).toEqual([])
  })

  it('identifies folder-linked members', () => {
    expect([...workspaceExternalProjectIds(WS_ENV)]).toEqual(['anchor'])
  })

  it('does not auto-start preview for a folder-linked anchor unless runtime is enabled', () => {
    expect(shouldAutoStartAnchorPreview('anchor', WS_ENV)).toBe(false)
    expect(shouldAutoStartAnchorPreview('anchor', { ...WS_ENV, RUNTIME_ENABLED: 'true' })).toBe(true)
    expect(shouldAutoStartAnchorPreview('managed-1', WS_ENV)).toBe(true)
    expect(shouldAutoStartAnchorPreview(undefined, WS_ENV)).toBe(false)
  })

  it('groups user-owned mounts by the project whose trust governs them', () => {
    expect(userOwnedTrustGroups(MOUNTS)).toEqual([
      { projectId: 'anchor', external: true, roots: ['/home/u/repo', '/home/u/lib'] },
    ])
  })
})

describe('renderWorkspaceManifestMarkdown with mounts', () => {
  it("marks the folder-linked project as the user's own folder and lists linked folders", () => {
    const md = renderWorkspaceManifestMarkdown(
      'ws-1',
      [{ id: 'anchor', name: 'alignment-project-server' }, { id: 'managed-1', name: 'App' }],
      MOUNTS,
    )
    expect(md).toContain("- `anchor/` — **alignment-project-server** (the user's own folder `/home/u/repo`)")
    expect(md).toContain('- `managed-1/` — **App**\n')
    expect(md).toContain('## Linked folders')
    expect(md).toContain('- `lib/` — `/home/u/lib`')
  })

  it('renders no mount sections without user-owned mounts', () => {
    const md = renderWorkspaceManifestMarkdown('ws-1', [{ id: 'managed-1', name: 'App' }], [MOUNTS[2]!])
    expect(md).not.toContain('## Linked folders')
    expect(md).not.toContain("user's own folder")
  })
})

describe('resolveRuntimeIdentity', () => {
  it('resolves a workspace-mode personal identity', () => {
    expect(
      resolveRuntimeIdentity({
        WORKSPACE_RUNTIME: 'true',
        WORKSPACE_ID: 'ws-1',
        WORKSPACE_KIND: 'personal',
      } as any),
    ).toEqual({ mode: 'workspace', workspaceId: 'ws-1', projectId: null, kind: 'personal' })
  })

  it('resolves a single-project team identity', () => {
    expect(resolveRuntimeIdentity({ PROJECT_ID: 'proj-1' } as any)).toEqual({
      mode: 'project',
      workspaceId: null,
      projectId: 'proj-1',
      kind: 'team',
    })
  })

  it('workspaceId is populated whenever WORKSPACE_ID is set, even outside workspace mode', () => {
    // Mirrors the historical `process.env.WORKSPACE_ID || ctx.workspaceId`
    // precedence in gateway-tools.ts's resolveWorkspaceId, which never
    // gated on WORKSPACE_RUNTIME.
    expect(resolveRuntimeIdentity({ WORKSPACE_ID: 'ws-2' } as any).workspaceId).toBe('ws-2')
  })
})

describe('workspaceKind', () => {
  it('recognizes personal mode and defaults safely to team', () => {
    expect(workspaceKind({ WORKSPACE_KIND: 'personal' } as any)).toBe('personal')
    expect(workspaceKind({ WORKSPACE_KIND: 'team' } as any)).toBe('team')
    expect(workspaceKind({} as any)).toBe('team')
  })
})

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
  it('names the open project folder so relative paths land in it', () => {
    const md = renderWorkspaceManifestMarkdown('ws-1', [{ id: 'p1', name: 'alpha-api' }], [], 'p1')
    expect(md).toContain('## Current project')
    expect(md).toContain('`p1/` (**alpha-api**) open')
    expect(md).toContain('`p1/src/App.tsx`')
    expect(renderWorkspaceManifestMarkdown('ws-1', [{ id: 'p1', name: 'alpha-api' }])).not.toContain('## Current project')
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
