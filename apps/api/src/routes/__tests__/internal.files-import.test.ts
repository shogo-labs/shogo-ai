// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * POST /api/internal/projects/:projectId/files/import — `copy_to_project`
 * unpacking another project's archive inside the target's own runtime. Real
 * runtime-token auth, requester tickets and RBAC over the seeded sqlite
 * world; only the target runtime is faked.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { rmSync } from 'fs'
import { setupChannelsTestDb } from '../../__tests__/helpers/channels-test-db'

const { dir } = setupChannelsTestDb()
process.env.BETTER_AUTH_SECRET ||= 'rbac-files-import-secret'

const { seedRbacWorld, db, _setRbacModeForTests } = await import('../../__tests__/helpers/rbac-world')
const { runtimeInternalRoutes } = await import('../internal-runtime-routes')
const { authenticateRuntimeToken } = await import('../internal-runtime-auth')
const { deriveWorkspaceRuntimeToken } = await import('../../lib/workspace-runtime-token')
const { signRequesterTicket, workspaceTicketKey } = await import('../../lib/requester-ticket')
const { setProjectRuntimeUrlResolver } = await import('../../services/agent-call.service')
const { REMOTE_IMPORT_MAX_BASE64_CHARS } = await import('../../lib/remote-tool-policy')

type World = Awaited<ReturnType<typeof seedRbacWorld>>

const app = runtimeInternalRoutes({
  authenticate: authenticateRuntimeToken,
  loadAgentCall: () => import('../../services/agent-call.service'),
})

const MANIFEST = { ok: true, dest: 'public/assets', fileCount: 1, totalBytes: 2, files: [{ path: 'public/assets/a.json', bytes: 2, sha256: 'x' }] }

let w: World
let tokenA: string
const realFetch = globalThis.fetch
let runtimeResponse: { status: number; body: unknown }
let forwarded: Array<{ url: string; token: string | null; body: any }>

function ticketFor(userId: string, workspaceId = w.workspaceA): string {
  return signRequesterTicket({ projectId: workspaceTicketKey(workspaceId), userId })
}

async function importFiles(
  target: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
  const res = await app.request(`/projects/${target}/files/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}

beforeAll(async () => {
  _setRbacModeForTests('on')
  w = await seedRbacWorld()
  tokenA = deriveWorkspaceRuntimeToken(w.workspaceA)
})

afterAll(async () => {
  _setRbacModeForTests(null)
  await db.$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => {
  runtimeResponse = { status: 200, body: MANIFEST }
  forwarded = []
  setProjectRuntimeUrlResolver(async () => 'http://target-runtime:8080')
  globalThis.fetch = (async (url: string, init: any) => {
    forwarded.push({
      url: String(url),
      token: new Headers(init?.headers).get('x-runtime-token'),
      body: init?.body ? JSON.parse(init.body) : null,
    })
    return new Response(JSON.stringify(runtimeResponse.body), { status: runtimeResponse.status })
  }) as unknown as typeof fetch
})

afterEach(() => {
  globalThis.fetch = realFetch
  setProjectRuntimeUrlResolver(null)
})

describe('POST /projects/:projectId/files/import', () => {
  test('forwards the archive to the target runtime with its token and the caller id', async () => {
    const res = await importFiles(
      w.projects.open,
      { archive: 'aGk=', dest: 'public/assets', overwrite: true, callerProjectId: w.projects.restricted },
      { 'x-runtime-token': tokenA, 'X-Requester-Ticket': ticketFor(w.users.member) },
    )
    expect(res.status).toBe(200)
    expect(res.body).toEqual(MANIFEST)
    expect(forwarded).toEqual([
      {
        url: 'http://target-runtime:8080/agent/remote/import',
        token: deriveWorkspaceRuntimeToken(w.workspaceA),
        body: { archive: 'aGk=', dest: 'public/assets', overwrite: true, callerProjectId: w.projects.restricted },
      },
    ])
  })

  test('overwrite defaults off and dest is optional', async () => {
    await importFiles(
      w.projects.open,
      { archive: 'aGk=' },
      { 'x-runtime-token': tokenA, 'X-Requester-Ticket': ticketFor(w.users.member) },
    )
    expect(forwarded[0]!.body).toEqual({ archive: 'aGk=' })
  })

  test('403 cross_workspace when the target lives in another workspace', async () => {
    const res = await importFiles(
      w.projects.foreign,
      { archive: 'aGk=' },
      { 'x-runtime-token': tokenA, 'X-Requester-Ticket': ticketFor(w.users.member) },
    )
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('cross_workspace')
    expect(forwarded).toEqual([])
  })

  test('a read-only requester is refused: import always needs project:update', async () => {
    const res = await importFiles(
      w.projects.open,
      { archive: 'aGk=' },
      { 'x-runtime-token': tokenA, 'X-Requester-Ticket': ticketFor(w.users.viewer) },
    )
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('forbidden')
    expect(forwarded).toEqual([])
  })

  test('401 without a runtime token or with an invalid ticket; 403 without a requester', async () => {
    const noToken = await importFiles(w.projects.open, { archive: 'aGk=' }, { 'X-Requester-Ticket': ticketFor(w.users.member) })
    expect(noToken.status).toBe(401)
    const garbage = await importFiles(
      w.projects.open,
      { archive: 'aGk=' },
      { 'x-runtime-token': tokenA, 'X-Requester-Ticket': 'not-a-ticket' },
    )
    expect(garbage.status).toBe(401)
    expect(garbage.body.error.code).toBe('invalid_requester_ticket')
    const noRequester = await importFiles(w.projects.open, { archive: 'aGk=' }, { 'x-runtime-token': tokenA })
    expect(noRequester.status).toBe(403)
    expect(noRequester.body.error.code).toBe('requester_required')
    expect(forwarded).toEqual([])
  })

  test('400 without an archive or with a non-string dest; 413 over the size cap', async () => {
    const auth = { 'x-runtime-token': tokenA, 'X-Requester-Ticket': ticketFor(w.users.member) }
    expect((await importFiles(w.projects.open, {}, auth)).status).toBe(400)
    expect((await importFiles(w.projects.open, { archive: 'aGk=', dest: 3 }, auth)).status).toBe(400)
    const huge = await importFiles(w.projects.open, { archive: 'A'.repeat(REMOTE_IMPORT_MAX_BASE64_CHARS + 1) }, auth)
    expect(huge.status).toBe(413)
    expect(huge.body.error.code).toBe('too_large')
    expect(forwarded).toEqual([])
  })

  test('502 target_unavailable when the target runtime cannot be resolved', async () => {
    setProjectRuntimeUrlResolver(async () => {
      throw new Error('no live metal host available')
    })
    const res = await importFiles(
      w.projects.open,
      { archive: 'aGk=' },
      { 'x-runtime-token': tokenA, 'X-Requester-Ticket': ticketFor(w.users.member) },
    )
    expect(res.status).toBe(502)
    expect(res.body.error.code).toBe('target_unavailable')
  })

  test('passes the runtime status and body through (409 conflict)', async () => {
    runtimeResponse = { status: 409, body: { ok: false, error: { code: 'conflict', message: '1 file(s) already exist' }, conflicts: ['a.json'] } }
    const res = await importFiles(
      w.projects.open,
      { archive: 'aGk=' },
      { 'x-runtime-token': tokenA, 'X-Requester-Ticket': ticketFor(w.users.member) },
    )
    expect(res.status).toBe(409)
    expect(res.body.conflicts).toEqual(['a.json'])
  })
})
