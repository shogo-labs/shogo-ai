// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Coverage for `settings` encoding on the project write path. Clients build the
// column with JSON.stringify(...) and send the string; Postgres then stores a
// jsonb string scalar rather than an object, so every server-side
// `settings?.x` read comes back undefined. The hooks normalize to an object
// before the value reaches Prisma. Uses an in-memory prisma double so the real
// branch logic runs.

import { describe, expect, test } from 'bun:test'
import { projectHooks } from '../generated/project.hooks'

const USER_ID = 'user-1'
const WORKSPACE_ID = 'ws-1'
const PROJECT_ID = 'proj-1'

function makeCtx(body: any = {}) {
  const prisma = {
    user: {
      findUnique: async () => ({ role: 'super_admin' }),
    },
    member: {
      findFirst: async () => ({ userId: USER_ID, workspaceId: WORKSPACE_ID, role: 'owner' }),
    },
    project: {
      findUnique: async () => ({
        id: PROJECT_ID,
        workspace: { members: [{ userId: USER_ID, role: 'owner' }] },
      }),
    },
  }
  return { body, params: {}, query: {}, userId: USER_ID, prisma } as any
}

describe('projectHooks.beforeCreate — settings encoding', () => {
  test('decodes a stringified settings payload into an object', async () => {
    const input: any = {
      name: 'Composer Project',
      workspaceId: WORKSPACE_ID,
      settings: JSON.stringify({ activeMode: 'canvas', techStackId: 'expo-app' }),
    }

    const result = await projectHooks.beforeCreate!(input, makeCtx(input))

    expect(result).toBeTruthy()
    expect((result as any).ok).toBe(true)
    expect((result as any).data.settings).toEqual({
      activeMode: 'canvas',
      techStackId: 'expo-app',
    })
  })

  test('writes the default settings as an object, not a string', async () => {
    const input: any = { name: 'Bare Project', workspaceId: WORKSPACE_ID }

    const result = await projectHooks.beforeCreate!(input, makeCtx(input))

    expect((result as any).data.settings).toEqual({
      activeMode: 'none',
      canvasEnabled: false,
    })
  })

  test('leaves an already-decoded object untouched', async () => {
    const settings = { activeMode: 'canvas', techStackId: 'react-app' }
    const input: any = { name: 'Marketplace Project', workspaceId: WORKSPACE_ID, settings }

    const result = await projectHooks.beforeCreate!(input, makeCtx(input))

    expect((result as any).data.settings).toBe(settings)
  })
})

describe('projectHooks.beforeUpdate — settings encoding', () => {
  test('normalizes in place, since the access-control branches return no data', async () => {
    const input: any = {
      settings: JSON.stringify({ activeMode: 'canvas', techStackId: 'expo-app' }),
    }

    const result = await projectHooks.beforeUpdate!(PROJECT_ID, input, makeCtx(input))

    expect((result as any).ok).toBe(true)
    // The route reuses its own `body` reference when the hook returns no
    // `data`, so the mutation has to land on the object we passed in.
    expect(input.settings).toEqual({ activeMode: 'canvas', techStackId: 'expo-app' })
  })

  test('ignores updates that do not touch settings', async () => {
    const input: any = { name: 'Renamed' }

    await projectHooks.beforeUpdate!(PROJECT_ID, input, makeCtx(input))

    expect('settings' in input).toBe(false)
  })
})
