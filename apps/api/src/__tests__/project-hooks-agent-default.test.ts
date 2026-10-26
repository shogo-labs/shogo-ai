// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// The create hook seeds an AgentConfig for every new project. With no template
// the model must be `auto` (Auto routing), not a pinned concrete model.

import { describe, expect, mock, test } from 'bun:test'
import { withPrismaExports } from './helpers/prisma-mock-exports'

const agentConfigCreates: Array<Record<string, unknown>> = []

const prisma = {
  user: { findUnique: async () => ({ role: 'super_admin' }) },
  member: { findMany: async () => [] },
  agentConfig: {
    findUnique: async () => null,
    create: async ({ data }: { data: Record<string, unknown> }) => {
      agentConfigCreates.push(data)
      return data
    },
  },
}

mock.module('../lib/prisma', () => withPrismaExports({ prisma }))

const { projectHooks } = await import('../generated/project.hooks')

function makeCtx() {
  return { userId: 'user-1', prisma } as any
}

describe('projectHooks.afterCreate — default agent model', () => {
  test('a project created without a template gets auto', async () => {
    agentConfigCreates.length = 0
    // No workspaceId: the billing downgrade does not run, so the default is what is tested.
    await projectHooks.afterCreate!({ id: 'proj-plain', workspaceId: null, templateId: null } as any, makeCtx())
    expect(agentConfigCreates).toHaveLength(1)
    expect(agentConfigCreates[0].projectId).toBe('proj-plain')
    expect(agentConfigCreates[0].modelName).toBe('auto')
  })

  test('a project created from a bundled template also gets auto', async () => {
    agentConfigCreates.length = 0
    await projectHooks.afterCreate!({ id: 'proj-tpl', workspaceId: null, templateId: 'eng-pod' } as any, makeCtx())
    expect(agentConfigCreates).toHaveLength(1)
    expect(agentConfigCreates[0].modelName).toBe('auto')
  })
})
