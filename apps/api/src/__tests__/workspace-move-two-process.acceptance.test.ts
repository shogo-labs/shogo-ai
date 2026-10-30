// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A workspace move between two REAL processes.
 *
 * Every other test in this package runs both ends in one process, where the
 * driver's local database and filesystem *are* the source's. That makes a whole
 * family of bugs invisible, and three of them shipped: a cloud→desktop move
 * planned from the desktop's empty database (0 projects, 0 files, "done" with
 * an empty workspace), a foreign-key violation as soon as the workspace had
 * more than one member, and a 403 on the push direction because the receiving
 * instance was asked to authorise a workspace it had never seen.
 *
 * So this spawns two API processes — separate SQLite files, separate
 * WORKSPACES_DIRs, real TCP — and checks the result by sha256, not by "the
 * directory exists". The workload is deliberately production-shaped: 127 files
 * across 4 projects (one empty), nested directories, a 2 MB binary, a unicode
 * filename, ignored `out/`/`.tmp/`/`node_modules/`, 3 members, 3 channels,
 * 60 messages, 2 boards, 24 work items, a schedule and a trigger.
 */
import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { deriveMoveId } from '../services/workspace-move/ids'

const API_DIR = resolve(import.meta.dir, '../..')
const SERVER = join(import.meta.dir, 'helpers/workspace-move-two-process-server.ts')
const API_KEY = 'shogo_sk_two_process_test'
const OWNER = 'u-owner-246'

interface Proc {
  child: ReturnType<typeof Bun.spawn>
  port: number
}
interface FileEntry {
  path: string
  sha: string
  bytes: number
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

const expectSameFiles = (label: string, actual: FileEntry[], expected: FileEntry[]) => {
  const byPath = new Map(actual.map((file) => [file.path, file.sha]))
  const missing = expected.filter((file) => !byPath.has(file.path))
  const mismatched = expected.filter((file) => byPath.has(file.path) && byPath.get(file.path) !== file.sha)
  const extra = actual.filter((file) => !expected.some((entry) => entry.path === file.path))
  expect({ label, missing: missing.map((f) => f.path), mismatched: mismatched.map((f) => f.path) }).toEqual({
    label,
    missing: [],
    mismatched: [],
  })
  expect({ label, extra: extra.map((f) => f.path) }).toEqual({ label, extra: [] })
}

afterAll(() => {
  for (const proc of procs) proc.child.kill()
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

test(
  'a workspace moves between two processes, both directions, byte for byte',
  async () => {
    const cloudRoot = mkdtempSync(join(tmpdir(), 'move-cloud-'))
    const desktopRoot = mkdtempSync(join(tmpdir(), 'move-desktop-'))
    roots.push(cloudRoot, desktopRoot)
    const cloudDirs = { data: join(cloudRoot, 'data'), files: join(cloudRoot, 'files') }
    const desktopDirs = { data: join(desktopRoot, 'data'), files: join(desktopRoot, 'files') }
    mkdirSync(cloudDirs.data, { recursive: true })
    mkdirSync(desktopDirs.data, { recursive: true })

    const cloud = await startServer({ QA_DATA_DIR: cloudDirs.data, QA_FILES_DIR: cloudDirs.files })
    const seeded = await call(cloud.port, '/__qa/seed', { method: 'POST', body: '{}' })
    expect(seeded.status).toBe(200)
    const { workspaceId, expected } = seeded.json as {
      workspaceId: string
      expected: { projectDir: string; path: string; sha: string; bytes: number }[]
    }
    expect(expected.length).toBe(127)

    // The desktop is a *signed-in app*, which means its env looks like this:
    // its own local API addresses itself (`SHOGO_API_URL`), and the cloud is a
    // different address on a different variable. Pointing `SHOGO_API_URL` at
    // the other process — as this test used to — is not a shape the product
    // ever has, and it hid a real defect: every "remote" call went back to the
    // driver itself, so a cloud→desktop move planned from the desktop's own
    // empty database, moved nothing, and reported `done`.
    const desktopPort = await freePort()
    const desktop = await startServer({
      QA_DATA_DIR: desktopDirs.data,
      QA_FILES_DIR: desktopDirs.files,
      QA_PORT: String(desktopPort),
      SHOGO_API_URL: `http://127.0.0.1:${desktopPort}`,
      SHOGO_CLOUD_URL: `http://127.0.0.1:${cloud.port}`,
      SHOGO_API_KEY: API_KEY,
    })
    // The desktop knows the cloud workspace before it offers to move it: an
    // account and a membership grant, with none of the content.
    expect((await call(desktop.port, '/__qa/seed-remote', { method: 'POST', body: JSON.stringify({ workspaceId }) })).status).toBe(200)

    const cloudBefore = await stateOf(cloud)
    const expectedByProject = new Map<string, FileEntry[]>()
    for (const entry of expected) {
      const list = expectedByProject.get(entry.projectDir) ?? []
      list.push({ path: entry.path, sha: entry.sha, bytes: entry.bytes })
      expectedByProject.set(entry.projectDir, list)
    }

    // ─── cloud → desktop ─────────────────────────────────────────────
    const started = await call(desktop.port, '/api/workspace-moves', {
      method: 'POST',
      body: JSON.stringify({ workspaceId, direction: 'cloud_to_desktop', selection: { mode: 'all' } }),
    })
    expect(started.status).toBe(201)
    // The plan must describe the *cloud's* content, not the empty desktop.
    expect(started.json.plan.projects.length).toBe(4)
    expect(started.json.plan.totals.files).toBe(127)
    expect(started.json.plan.totals.bytes).toBeGreaterThan(4_000_000)

    const down = await waitForMove(desktop.port, started.json.move.id)
    expect(down.status).toBe('done')

    const desktopAfter = await stateOf(desktop)
    for (const [sourceProject, files] of expectedByProject) {
      const targetDir = deriveMoveId(started.json.move.id, sourceProject)
      const actual = desktopAfter.dirs.find((dir: any) => dir.dir === targetDir)?.files ?? []
      expectSameFiles(`cloud→desktop ${sourceProject}`, actual, files)
    }
    expect(
      desktopAfter.dirs.some((dir: any) =>
        dir.files.some((file: any) => /^(out|\.tmp|node_modules)\//.test(file.path)),
      ),
    ).toBe(false)

    // Rows: everything the source had, including every member — the foreign key
    // that used to fail the move and silently drop one.
    expect(desktopAfter.counts.messages).toBe(cloudBefore.counts.messages)
    expect(desktopAfter.counts.workItems).toBe(cloudBefore.counts.workItems)
    expect(desktopAfter.counts.boards).toBe(cloudBefore.counts.boards)
    expect(desktopAfter.counts.conversations).toBe(cloudBefore.counts.conversations)
    expect(desktopAfter.counts.projects).toBe(cloudBefore.counts.projects)
    expect(desktopAfter.counts.schedules).toBe(cloudBefore.counts.schedules)
    expect(desktopAfter.counts.triggers).toBe(cloudBefore.counts.triggers)
    expect(desktopAfter.counts.members).toBeGreaterThanOrEqual(cloudBefore.counts.members)
    // Someone in a channel but not in the workspace. Their `User` row is not in
    // the export manifest and no `Member` mentions them, so a move that only
    // carries member accounts dies here with a foreign-key violation.
    expect(desktopAfter.userIds).toContain('u-guest-246')
    expect(desktopAfter.counts.conversationMembers).toBe(cloudBefore.counts.conversationMembers)

    // The source is untouched until someone switches over.
    expect((await stateOf(cloud)).dirs).toEqual(cloudBefore.dirs)

    // ─── desktop → cloud, from the moved workspace ────────────────────
    const targetWorkspaceId = down.targetWorkspaceId
    const upStarted = await call(desktop.port, '/api/workspace-moves', {
      method: 'POST',
      body: JSON.stringify({ workspaceId: targetWorkspaceId, direction: 'desktop_to_cloud', selection: { mode: 'all' } }),
    })
    expect(upStarted.status).toBe(201)
    expect(upStarted.json.plan.totals.files).toBe(127)

    const up = await waitForMove(desktop.port, upStarted.json.move.id)
    expect(up.status).toBe('done')

    const cloudAfter = await stateOf(cloud)
    expect(cloudAfter.workspaces.some((workspace: any) => workspace.id === up.targetWorkspaceId)).toBe(true)
    const pushedProjects = cloudAfter.projects.filter((project: any) => project.workspaceId === up.targetWorkspaceId)
    expect(pushedProjects.length).toBe(4)

    // The desktop's project ids are already derived from the first leg, so the
    // cloud's copy is keyed off those.
    const desktopProjectIds = desktopAfter.projects
      .filter((project: any) => project.workspaceId === targetWorkspaceId)
      .map((project: any) => project.id)
    const firstSourceProject = [...expectedByProject.keys()][0]
    const pushedDir = cloudAfter.dirs.find(
      (dir: any) => dir.dir === deriveMoveId(upStarted.json.move.id, desktopProjectIds[0]),
    )
    expectSameFiles('desktop→cloud first project', pushedDir?.files ?? [], expectedByProject.get(firstSourceProject) ?? [])
  },
  { timeout: 300_000 },
)
