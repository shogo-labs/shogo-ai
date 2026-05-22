// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { beforeEach, describe, expect, mock, test } from 'bun:test'

let projectResult: any = null
let projectFindError: Error | null = null
let localConfigResult: any = null
let localConfigError: Error | null = null
const findUniqueMock = mock(async () => {
  if (projectFindError) throw projectFindError
  return projectResult
})
const localConfigFindUniqueMock = mock(async () => {
  if (localConfigError) throw localConfigError
  return localConfigResult
})

mock.module('../lib/prisma', () => ({
  prisma: {
    localConfig: {
      findUnique: localConfigFindUniqueMock,
    },
    project: {
      findUnique: findUniqueMock,
    },
  },
}))

mock.module('@shogo/agent-runtime/src/agent-templates', () => ({
  getAgentTemplateById: (id: string) =>
    id === 'template-with-stack' ? { techStack: 'expo-app' } : null,
}))

const { RuntimeManager } = await import('../lib/runtime/manager')

beforeEach(() => {
  projectResult = null
  projectFindError = null
  localConfigResult = null
  localConfigError = null
  findUniqueMock.mockClear()
  localConfigFindUniqueMock.mockClear()
})

function managerWithPrivateGetInfo() {
  return new RuntimeManager() as unknown as {
    getProjectInfo: (projectId: string) => Promise<{
      name?: string
      techStackId?: string
      workingMode?: 'managed' | 'external'
      runtimeEnabled?: boolean
      trustLevel?: 'trusted' | 'restricted'
      folders?: { path: string; isPrimary: boolean }[]
    }>
  }
}

describe('RuntimeManager.getProjectInfo', () => {
  test('reads explicit tech stack, external mode fields, and project folders', async () => {
    projectResult = {
      // `templateId` is no longer selected/surfaced by getProjectInfo
      // after the marketplace consolidation (manager.ts:891–942) — leave
      // it on the row so we also prove it doesn't leak into the result.
      templateId: 'template-1',
      name: 'Project One',
      settings: { techStackId: 'python-data' },
      workingMode: 'external',
      runtimeEnabled: false,
      trustLevel: 'restricted',
      projectFolders: [
        { path: '/workspace/a', isPrimary: true },
        { path: '/workspace/b', isPrimary: false },
      ],
    }

    const info = await managerWithPrivateGetInfo().getProjectInfo('project-1')

    expect(info).toEqual({
      name: 'Project One',
      techStackId: 'python-data',
      workingMode: 'external',
      runtimeEnabled: false,
      trustLevel: 'restricted',
      folders: [
        { path: '/workspace/a', isPrimary: true },
        { path: '/workspace/b', isPrimary: false },
      ],
    })
  })

  test('omits techStackId (no template fallback) and defaults managed runtime fields when settings is empty', async () => {
    // Pre-marketplace builds had a `templateId → template.techStack`
    // fallback here. That path was deliberately removed (manager.ts:920)
    // — techStackId now comes exclusively from `settings.techStackId`,
    // populated by the marketplace install flow. With `settings: null`
    // the field is undefined and the consumer is expected to treat the
    // workspace as stackless.
    projectResult = {
      templateId: 'template-with-stack',
      name: 'Template Project',
      settings: null,
      workingMode: null,
      runtimeEnabled: null,
      trustLevel: null,
      projectFolders: null,
    }

    const info = await managerWithPrivateGetInfo().getProjectInfo('project-2')

    expect(info).toEqual({
      name: 'Template Project',
      techStackId: undefined,
      workingMode: 'managed',
      runtimeEnabled: true,
      trustLevel: 'trusted',
      folders: [],
    })
  })

  test('external projects default runtimeEnabled to false when the column is absent', async () => {
    projectResult = {
      templateId: null,
      name: 'External Project',
      settings: {},
      workingMode: 'external',
      runtimeEnabled: undefined,
      trustLevel: undefined,
      projectFolders: [],
    }

    const info = await managerWithPrivateGetInfo().getProjectInfo('project-3')

    expect(info.runtimeEnabled).toBe(false)
    expect(info.workingMode).toBe('external')
    expect(info.trustLevel).toBe('trusted')
  })

  test('returns an empty object when Prisma lookup fails', async () => {
    projectFindError = new Error('schema not migrated')

    await expect(managerWithPrivateGetInfo().getProjectInfo('project-4')).resolves.toEqual({})
  })
})

describe('RuntimeManager private project runtime metadata helpers', () => {
  function managerWithPrivateHelpers() {
    return new RuntimeManager() as unknown as {
      getProjectComposioScope: (projectId: string) => Promise<'workspace' | 'project'>
      buildSecurityPolicy: (projectId: string) => Promise<string | null>
    }
  }

  function decodePolicy(encoded: string | null) {
    expect(encoded).toBeTruthy()
    return JSON.parse(Buffer.from(encoded!, 'base64').toString('utf8'))
  }

  test('getProjectComposioScope accepts valid scopes and defaults invalid or failed reads', async () => {
    const manager = managerWithPrivateHelpers()

    projectResult = { workspace: { composioScope: 'project' } }
    await expect(manager.getProjectComposioScope('p1')).resolves.toBe('project')

    projectResult = { workspace: { composioScope: 'team' } }
    await expect(manager.getProjectComposioScope('p2')).resolves.toBe('workspace')

    projectFindError = new Error('missing workspace relation')
    await expect(manager.getProjectComposioScope('p3')).resolves.toBe('workspace')
  })

  test('buildSecurityPolicy merges user prefs with non-escalating project overrides', async () => {
    localConfigResult = {
      value: JSON.stringify({
        mode: 'balanced',
        approvalTimeoutSeconds: 30,
        overrides: { shellCommands: { deny: ['rm -rf /'] } },
      }),
    }
    projectResult = {
      settings: {
        security: {
          mode: 'strict',
          overrides: { shellCommands: { deny: ['curl evil.example'] } },
        },
      },
    }

    const policy = decodePolicy(await managerWithPrivateHelpers().buildSecurityPolicy('p1'))

    expect(policy).toMatchObject({ mode: 'strict', approvalTimeoutSeconds: 30 })
    expect(policy.overrides.shellCommands.deny).toEqual(['rm -rf /', 'curl evil.example'])
  })

  test('buildSecurityPolicy blocks project-level escalation and tolerates malformed reads', async () => {
    localConfigResult = {
      value: JSON.stringify({ mode: 'strict', approvalTimeoutSeconds: 10 }),
    }
    projectResult = {
      settings: JSON.stringify({ security: { mode: 'full_autonomy' } }),
    }

    let policy = decodePolicy(await managerWithPrivateHelpers().buildSecurityPolicy('p2'))
    expect(policy.mode).toBe('strict')

    localConfigError = new Error('no local config')
    projectFindError = new Error('project settings unavailable')
    policy = decodePolicy(await managerWithPrivateHelpers().buildSecurityPolicy('p3'))
    expect(policy).toMatchObject({ mode: 'full_autonomy', approvalTimeoutSeconds: 60 })
  })
})
