// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Project code hooks: a trigger targeting a project in `hook` mode is
 * delivered by the worker to a real agent runtime (spawned here, or the one
 * at AGENT_URL when AGENT_WORKSPACE_DIR is also set), whose
 * `hooks/<name>/HOOK.md` with `events: [workspace:member.joined]` runs as
 * plain code with no LLM turn.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildEventsApp, caller, freezeBackoff, runWorkerTick, seedWorkspace, setupEventsDb, waitFor, waitForDelivery, type SeededEventsWorkspace } from './helpers'

const { dir } = setupEventsDb()

const { prisma } = await import('../../apps/api/src/lib/prisma')
const { setProjectRuntimeUrlResolver } = await import('../../apps/api/src/services/agent-call.service')
const { deriveProjectRuntimeToken } = await import('../../apps/api/src/lib/project-runtime-token')
const { onWorkspaceMemberJoined } = await import('../../apps/api/src/services/workspace-events')

const db = prisma as any
const app = await buildEventsApp()
const call = caller(app)

let seed: SeededEventsWorkspace
let runtimeUrl: string
let runtimeToken: string
let workspaceDir: string
let runtime: ReturnType<typeof Bun.spawn> | null = null
let triggerId: string

function freePort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() })
  const port = probe.port
  probe.stop(true)
  return port
}

function writeHook(name: string, events: string[], handlerBody: string): void {
  const hookDir = join(workspaceDir, 'hooks', name)
  mkdirSync(hookDir, { recursive: true })
  writeFileSync(join(hookDir, 'HOOK.md'), `---\nname: ${name}\ndescription: e2e ${name}\nevents: [${events.join(', ')}]\n---\n`)
  writeFileSync(join(hookDir, 'handler.ts'), handlerBody)
}

async function postEvents(body: unknown, token?: string) {
  const res = await fetch(`${runtimeUrl}/agent/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { 'x-runtime-token': token } : {}) },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: await res.json().catch(() => null) as any }
}

async function joinMember(name: string) {
  const user = await db.user.create({ data: { name, email: `${name.toLowerCase()}-${Date.now()}@example.com` } })
  const member = await db.member.create({ data: { userId: user.id, workspaceId: seed.workspaceId, role: 'member' } })
  await onWorkspaceMemberJoined({ workspaceId: seed.workspaceId, userId: user.id, memberId: member.id, role: 'member', source: 'invitation' })
  return user
}

beforeAll(async () => {
  seed = await seedWorkspace(db)
  runtimeToken = await deriveProjectRuntimeToken(seed.projectId, { workspaceId: seed.workspaceId })

  if (process.env.AGENT_URL && process.env.AGENT_WORKSPACE_DIR) {
    runtimeUrl = process.env.AGENT_URL.replace(/\/$/, '')
    workspaceDir = process.env.AGENT_WORKSPACE_DIR
    runtimeToken = process.env.AGENT_RUNTIME_TOKEN ?? runtimeToken
  } else {
    workspaceDir = mkdtempSync(join(tmpdir(), 'shogo-events-hook-'))
    const port = freePort()
    runtimeUrl = `http://127.0.0.1:${port}`
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
    delete env.DATABASE_URL
    runtime = Bun.spawn(['bun', '--no-env-file', join(import.meta.dir, '../../packages/agent-runtime/src/server.ts')], {
      env: {
        ...env,
        PORT: String(port),
        HOST: '127.0.0.1',
        WORKSPACE_DIR: workspaceDir,
        RUNTIME_AUTH_SECRET: runtimeToken,
        PROJECT_ID: seed.projectId,
        WORKSPACE_ID: seed.workspaceId,
        NODE_ENV: 'test',
      },
      stdout: process.env.E2E_RUNTIME_LOGS ? 'inherit' : 'ignore',
      stderr: process.env.E2E_RUNTIME_LOGS ? 'inherit' : 'ignore',
    })
  }
  setProjectRuntimeUrlResolver((projectId) => (projectId === seed.projectId ? runtimeUrl : null))

  await waitFor(async () => {
    const res = await postEvents({ envelope: { id: 'probe', type: 'probe' } }, runtimeToken).catch(() => null)
    return res && res.status === 200 ? res : null
  }, 90_000)
}, 120_000)

afterAll(async () => {
  setProjectRuntimeUrlResolver(null)
  runtime?.kill()
  await runtime?.exited
  if (runtime) rmSync(workspaceDir, { recursive: true, force: true })
  await db.$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

describe('project code hooks', () => {
  test('/agent/events requires the runtime token', async () => {
    const anonymous = await postEvents({ envelope: { id: 'x', type: 'member.joined' } })
    expect(anonymous.status).toBe(401)
    const wrong = await postEvents({ envelope: { id: 'x', type: 'member.joined' } }, 'wrt_v1_nope')
    expect(wrong.status).toBe(401)
    const malformed = await postEvents({ nope: true }, runtimeToken)
    expect(malformed.status).toBe(400)
  })

  test('a hook-mode trigger needs no prompt and reports "no hook" until one exists', async () => {
    const created = await call(seed.owner, 'POST', `/workspaces/${seed.workspaceId}/triggers`, {
      name: 'Welcome hook',
      eventType: 'member.joined',
      target: 'project',
      targetProjectId: seed.projectId,
      targetMode: 'hook',
    })
    expect(created.status).toBe(201)
    expect(created.json.trigger).toMatchObject({ target: 'project', targetProjectId: seed.projectId, targetMode: 'hook' })
    triggerId = created.json.trigger.id

    await joinMember('Early')
    const delivery = await waitForDelivery(db, triggerId, 'ok', 15_000)
    expect(delivery.summary).toContain('No hook')
  })

  test('a hook the agent writes later runs on the next join, as code', async () => {
    writeHook('welcome', ['workspace:member.joined'], `
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
export default async (event: any) => {
  appendFileSync(join(process.env.WORKSPACE_DIR!, 'joined.log'), JSON.stringify({
    action: event.action,
    userId: event.context.payload.member.userId,
    subscriptionId: event.context.subscriptionId,
    eventId: event.context.envelope.id,
  }) + '\\n')
}
`)
    const user = await joinMember('Hooked')
    const delivery = await waitFor(async () => {
      await runWorkerTick()
      return db.eventDelivery.findFirst({ where: { subscriptionId: triggerId, status: 'ok', summary: { contains: '1 hook' } } })
    }, 15_000)
    expect(delivery.attempts).toBe(1)
    expect(delivery.responseStatus).toBe(200)

    const log = join(workspaceDir, 'joined.log')
    expect(existsSync(log)).toBe(true)
    const lines = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    expect(lines).toEqual([{ action: 'member.joined', userId: user.id, subscriptionId: triggerId, eventId: delivery.eventId }])
  })

  test('prefix wildcards match, and a throwing hook makes the delivery retry until dead', async () => {
    await freezeBackoff()
    writeHook('flaky', ['workspace:member.*'], `export default async () => { throw new Error('flaky hook exploded') }`)
    await joinMember('Unlucky')
    const dead = await waitForDelivery(db, triggerId, 'dead', 30_000)
    expect(dead.attempts).toBe(5)
    expect(dead.error).toContain('flaky hook exploded')
    const trigger = await db.eventSubscription.findUnique({ where: { id: triggerId } })
    expect(trigger.consecutiveFailures).toBeGreaterThanOrEqual(1)
    // The welcome hook still ran on every attempt: hooks are isolated from each other.
    const lines = readFileSync(join(workspaceDir, 'joined.log'), 'utf8').trim().split('\n')
    expect(lines.length).toBe(1 + 5)
  })
})
