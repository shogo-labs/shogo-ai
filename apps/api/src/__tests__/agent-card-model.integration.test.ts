// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-16 through the real route: `GET /api/workspaces/:ws/agent-card` always
 * carries `model: { id, label }`, and the label is the app's own name for it —
 * never a raw id — for both a project agent and the workspace agent.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'fs'
import { Hono } from 'hono'
import { seedWorkspace, setupChannelsTestDb, type SeededWorkspace } from './helpers/channels-test-db'

process.env.SECRETS_ENCRYPTION_KEY ||= Buffer.alloc(32, 7).toString('base64')
const { dir } = setupChannelsTestDb()

const { prisma } = await import('../lib/prisma')
const { conversationRoutes } = await import('../routes/conversations')
const { setAgentDefaultModel } = await import('../services/workspace-agent.service')

const db = prisma as any
let seed: SeededWorkspace

const app = new Hono()
app.route('/api', conversationRoutes({ resolveUserId: async (c) => c.req.header('x-user') ?? null }))

async function agentCard(user: string, projectId: string | null) {
  const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''
  const res = await app.request(`/api/workspaces/${seed.workspaceId}/agent-card${query}`, {
    headers: { 'x-user': user },
  })
  const body = (await res.json()) as any
  return { status: res.status, body }
}

beforeAll(async () => {
  seed = await seedWorkspace(db)
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('agent card model', () => {
  test('a project agent that was given a model names it the way the app does', async () => {
    await db.agentConfig.upsert({
      where: { projectId: seed.projectId },
      create: { projectId: seed.projectId, modelName: 'claude-sonnet-4-6' },
      update: { modelName: 'claude-sonnet-4-6' },
    })
    const { status, body } = await agentCard(seed.member, seed.projectId)
    expect(status).toBe(200)
    expect(body.card.model).toEqual({ id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' })
    // The payload names the model in words; the id must not leak into the label.
    expect(body.card.model.label).not.toContain('claude-sonnet-4-6')
    expect(body.card.model.label).not.toBe(body.card.model.id)
  })

  test('an untouched project agent and the workspace agent both say Auto', async () => {
    await db.agentConfig.deleteMany({ where: { projectId: seed.projectId } })
    const project = await agentCard(seed.member, seed.projectId)
    expect(project.status).toBe(200)
    expect(project.body.card.model).toEqual({ id: 'auto', label: 'Auto' })

    const workspace = await agentCard(seed.member, null)
    expect(workspace.status).toBe(200)
    expect(workspace.body.card.model).toEqual({ id: 'auto', label: 'Auto' })
  })

  test('the workspace agent shows the admin-set default until it is cleared', async () => {
    await setAgentDefaultModel(seed.workspaceId, 'claude-sonnet-4-6')
    const picked = await agentCard(seed.member, null)
    expect(picked.body.card.model).toEqual({ id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' })

    await setAgentDefaultModel(seed.workspaceId, null)
    const cleared = await agentCard(seed.member, null)
    expect(cleared.body.card.model).toEqual({ id: 'auto', label: 'Auto' })
  })

  test('model is always present, and an unknown project still 404s', async () => {
    for (const projectId of [seed.projectId, null] as const) {
      const { body } = await agentCard(seed.member, projectId)
      expect(body.card.model).toBeDefined()
      expect(typeof body.card.model.label).toBe('string')
      expect(body.card.model.label.length).toBeGreaterThan(0)
    }
    const missing = await agentCard(seed.member, 'no-such-project')
    expect(missing.status).toBe(404)
  })
})
