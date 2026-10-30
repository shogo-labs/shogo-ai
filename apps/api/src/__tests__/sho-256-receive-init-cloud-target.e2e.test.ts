// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-256 end to end, over real TCP: a desktop push into a cloud target that is
 * not allowed to create the workspace.
 *
 * The route-level acceptance test proves `/receive/init` applies the create rule
 * in one process. This proves the thing a user actually hits: the desktop starts
 * a `desktop_to_cloud` move, the *cloud* refuses to create the target workspace,
 * the job fails with the create flow's own message, and the cloud is left with
 * no workspace, no membership and no rows. The second test is the other half of
 * the rule — with the free team allowance unspent the same move lands, at the
 * create default size and not the source's.
 *
 * Both processes are the real API (`helpers/workspace-move-two-process-server`),
 * separate SQLite files, separate WORKSPACES_DIRs. The target is spawned with
 * `QA_SURFACE=cloud` so `/receive/init` answers as the cloud does.
 */
import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const API_DIR = resolve(import.meta.dir, '../..')
const SERVER = join(import.meta.dir, 'helpers/workspace-move-two-process-server.ts')
const API_KEY = 'shogo_sk_two_process_test'
const OWNER = 'u-owner-246'

interface Proc {
  child: ReturnType<typeof Bun.spawn>
  port: number
}

const roots: string[] = []
const procs: Proc[] = []

/** A port the desktop can name in its own env before it starts. */
const freePort = async (): Promise<number> => {
  const probe = Bun.serve({ port: 0, fetch: () => new Response('') })
  const port = probe.port
  await probe.stop(true)
  return port
}

const startServer = async (env: Record<string, string>): Promise<Proc> => {
  const child = Bun.spawn([process.execPath, SERVER], {
    cwd: API_DIR,
    env: { ...process.env, ...env, QA_USER_ID: OWNER },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const reader = child.stdout.getReader()
  let buf = ''
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    const { value, done } = await reader.read()
    if (done) break
    buf += new TextDecoder().decode(value)
    const match = buf.match(/QA_SERVER_READY (\d+)/)
    if (match) {
      reader.releaseLock()
      const proc = { child, port: Number(match[1]) }
      procs.push(proc)
      return proc
    }
  }
  throw new Error(`server failed to start.\nSTDOUT: ${buf}\nSTDERR: ${await new Response(child.stderr).text()}`)
}

const call = async (port: number, path: string, init: RequestInit = {}) => {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
  })
  const text = await res.text()
  let json: any
  try {
    json = JSON.parse(text)
  } catch {
    json = text
  }
  return { status: res.status, json }
}

const waitForMove = async (port: number, moveId: string, timeoutMs = 300_000) => {
  const deadline = Date.now() + timeoutMs
  let last: any = null
  while (Date.now() < deadline) {
    const { json } = await call(port, `/api/workspace-moves/${moveId}`, { method: 'GET' })
    last = json?.move ?? json
    if (last?.status === 'done' || last?.status === 'failed') return last
    await Bun.sleep(400)
  }
  throw new Error(`move ${moveId} did not settle: ${JSON.stringify(last)}`)
}

const stateOf = async (proc: Proc) => (await call(proc.port, '/__qa/state')).json

/** A cloud target (real API, cloud surface) plus a desktop that holds content. */
const pair = async (targetSetup: { kind?: 'team' | 'personal'; instanceSize?: string } | null, sourceSize?: string) => {
  const cloudRoot = mkdtempSync(join(tmpdir(), 'sho256-cloud-'))
  const desktopRoot = mkdtempSync(join(tmpdir(), 'sho256-desktop-'))
  roots.push(cloudRoot, desktopRoot)
  const cloudDirs = { data: join(cloudRoot, 'data'), files: join(cloudRoot, 'files') }
  const desktopDirs = { data: join(desktopRoot, 'data'), files: join(desktopRoot, 'files') }
  mkdirSync(cloudDirs.data, { recursive: true })
  mkdirSync(desktopDirs.data, { recursive: true })

  const cloud = await startServer({ QA_DATA_DIR: cloudDirs.data, QA_FILES_DIR: cloudDirs.files, QA_SURFACE: 'cloud' })
  if (targetSetup) {
    const owned = await call(cloud.port, '/__qa/own-workspace', { method: 'POST', body: JSON.stringify(targetSetup) })
    expect(owned.status).toBe(200)
  }

  // The desktop is a signed-in app: it addresses *itself* on `SHOGO_API_URL`
  // and the cloud on `SHOGO_CLOUD_URL` (that is the pair #1822 fixed the move to
  // read). Pointing `SHOGO_API_URL` at the target instead is not a shape the
  // product has.
  const desktopPort = await freePort()
  const desktop = await startServer({
    QA_DATA_DIR: desktopDirs.data,
    QA_FILES_DIR: desktopDirs.files,
    QA_PORT: String(desktopPort),
    SHOGO_API_URL: `http://127.0.0.1:${desktopPort}`,
    SHOGO_CLOUD_URL: `http://127.0.0.1:${cloud.port}`,
    SHOGO_API_KEY: API_KEY,
  })
  const seeded = await call(desktop.port, '/__qa/seed', {
    method: 'POST',
    body: JSON.stringify(sourceSize ? { instanceSize: sourceSize } : {}),
  })
  expect(seeded.status).toBe(200)
  return { cloud, desktop }
}

const startPush = async (desktop: Proc) =>
  call(desktop.port, '/api/workspace-moves', {
    method: 'POST',
    body: JSON.stringify({ workspaceId: 'ws-246', direction: 'desktop_to_cloud', selection: { mode: 'all' } }),
  })

afterAll(() => {
  for (const proc of procs) proc.child.kill()
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

test(
  'the cloud refuses the workspace a push would create, and writes nothing',
  async () => {
    // The account already owns its one free `team` workspace on the cloud.
    const { cloud, desktop } = await pair({ kind: 'team' })
    const before = await stateOf(cloud)
    expect(before.workspaces.length).toBe(1)

    const started = await startPush(desktop)
    expect(started.status).toBe(201)
    // A move no longer carries a size to impose on the target (SHO-256).
    expect(started.json.plan.target.instanceSize).toBeUndefined()

    const failed = await waitForMove(desktop.port, started.json.move.id)
    expect(failed.status).toBe('failed')
    // The create flow's own message, not a generic "the other side refused".
    expect(failed.error).toMatch(/Additional workspaces require a paid subscription/)
    expect(failed.targetWorkspaceId).toBeNull()

    const after = await stateOf(cloud)
    expect(after.workspaces).toEqual(before.workspaces)
    expect(after.counts).toEqual(before.counts)
    expect(after.projects).toEqual(before.projects)
    expect(after.moves.length).toBe(0)
  },
  { timeout: 300_000 },
)

test(
  'with the free team allowance unspent the push lands, at the create default size and not the source’s',
  async () => {
    // Owns a `personal` workspace: the `team` allowance is still there.
    const { cloud, desktop } = await pair({ kind: 'personal' }, 'small')
    // The target is a cloud instance where the source's other users are real
    // accounts — otherwise SEC-18's stranger check refuses their `User` rows
    // long before this card's rule is reached.
    await call(cloud.port, '/__qa/ensure-users', { method: 'POST', body: JSON.stringify({ ids: ['u-admin-246', 'u-viewer-246', 'u-guest-246'] }) })
    const before = await stateOf(cloud)
    const sourceState = await stateOf(desktop)
    const source = sourceState.workspaces.find((w: any) => w.id === 'ws-246')
    expect(source.instanceSize).toBe('small')

    const started = await startPush(desktop)
    expect(started.status).toBe(201)

    const done = await waitForMove(desktop.port, started.json.move.id)
    expect({ status: done.status, error: done.error }).toEqual({ status: 'done', error: null })

    const after = await stateOf(cloud)
    const created = after.workspaces.find((w: any) => w.id === done.targetWorkspaceId)
    expect(created).toBeDefined()
    expect(created.kind).toBe('team')
    // The row a normal create produces — not the source's `small`.
    expect(created.instanceSize).toBe('micro')

    // The content really arrived: every row the source had, no more and no less.
    expect(after.projects.filter((p: any) => p.workspaceId === done.targetWorkspaceId).length).toBe(4)
    expect({
      messages: after.counts.messages,
      workItems: after.counts.workItems,
      conversationMembers: after.counts.conversationMembers,
      boards: after.counts.boards,
      conversations: after.counts.conversations,
    }).toEqual({
      messages: sourceState.counts.messages,
      workItems: sourceState.counts.workItems,
      conversationMembers: sourceState.counts.conversationMembers,
      boards: sourceState.counts.boards,
      conversations: sourceState.counts.conversations,
    })
    // SEC-18: the receiving instance decides membership. `Member` is in
    // `NEVER_FROM_THE_WIRE` (receive.ts) because it was the model that let a
    // move write `Member{userId: me, workspaceId: victim, role: 'owner'}` into
    // someone else's tenant, so a push carries no membership at all: the
    // source's admin and member do not land, and `/receive/init` writes exactly
    // one row — the caller, as owner of the new workspace.
    const membershipOf = (state: any, workspaceId: string) =>
      state.members
        .filter((m: any) => m.workspaceId === workspaceId)
        .map((m: any) => `${m.userId}:${m.role}`)
        .sort()
    const landed = membershipOf(after, done.targetWorkspaceId)
    expect(landed).toEqual([`${OWNER}:owner`])
  },
  { timeout: 300_000 },
)
