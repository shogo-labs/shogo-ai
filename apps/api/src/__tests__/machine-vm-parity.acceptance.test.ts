// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-257 — a paired machine's workspace, opened from the cloud, works like a
 * cloud workspace.
 *
 * Real processes on both sides: the cloud API (`entry.ts` on Postgres + Redis)
 * and a desktop (`entry.ts` in local mode on its own data dir) paired to it the
 * way the desktop app pairs. The same content is seeded into a cloud workspace
 * (the VM baseline) and into the machine's workspace through the desktop's own
 * API. Then every surface a screen reads is asked three ways — cloud, desktop,
 * and the cloud app's machine view (the production interceptor routing to the
 * mirrored copy or the relay) — and the machine view must show what the desktop
 * shows. Last, a full agent turn is started from the cloud on the machine's
 * workspace: it has to run on the machine, against the machine's files.
 *
 * Needs `CHANNELS_TEST_PG_URL` (a server URL; a database is created per run)
 * and `TEST_REDIS_URL`/`REDIS_URL`. Skipped without them.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FakeLlmServer, marker, token } from '../../../desktop/e2e/streaming/fake-llm-server'
import {
  httpClient,
  machineViewClient,
  pairMachine,
  read,
  REPO_ROOT,
  sessionUserId,
  signUp,
  startCloud,
  waitFor,
  type CloudProcess,
  type PairedMachine,
} from './helpers/machine-vm-harness'
import { seedWorkspace, SURFACES, type Seeded } from './helpers/machine-vm-surfaces'

const PG_URL = process.env.CHANNELS_TEST_PG_URL
const REDIS_URL = process.env.TEST_REDIS_URL || process.env.REDIS_URL
const describeIfInfra = PG_URL && REDIS_URL ? describe : describe.skip

let cloud: CloudProcess
let machine: PairedMachine
let llm: FakeLlmServer
let seeds: { cloud: Seeded; machine: Seeded }
let cloudUserId: string
let localUserId: string

const clients = () => ({
  cloud: httpClient(cloud.base, machine.cookies),
  desktop: httpClient(machine.localApiBase, machine.localCookies),
  view: machineViewClient({ base: cloud.base, cookie: machine.cookies, userId: cloudUserId }, machine.machineId, machine.machineWorkspaceId),
})

/** Any request through a client, as `{ status, data }`, never throwing. */
async function send(client: ReturnType<typeof httpClient>, method: string, path: string, body?: unknown) {
  try {
    const res: any = await client.request(path, { method, body: body as any })
    return { status: (res.status ?? 200) as number, data: res.data }
  } catch (err: any) {
    return { status: (err?.status ?? 0) as number, data: err?.details ?? err?.message ?? null }
  }
}

async function channelTexts(client: ReturnType<typeof httpClient>, channelId: string): Promise<string[]> {
  const res = await read(client, `/api/conversations/${encodeURIComponent(channelId)}/messages?limit=100`)
  return (res.data?.messages ?? []).map((m: any) => m.text)
}

function logs(): string {
  return `--- cloud ---\n${cloud?.log.join('').slice(-3000)}\n--- desktop ---\n${machine?.log.join('').slice(-3000)}`
}

beforeAll(async () => {
  if (!PG_URL || !REDIS_URL) return
  llm = new FakeLlmServer()
  await llm.start(0)
  cloud = await startCloud({ pgServerUrl: PG_URL, redisUrl: REDIS_URL })
  machine = await pairMachine(cloud.base, {
    instanceName: `vm-${Math.random().toString(36).slice(2, 6)}`,
    repoRoot: REPO_ROOT,
    dir: mkdtempSync(join(tmpdir(), 'shogo-vm-desktop-')),
    // The agent turn runs on the machine; its model is the scripted one, called
    // from the machine itself rather than forwarded to the cloud's gateway.
    env: {
      AI_MODE: 'local-llm',
      LOCAL_LLM_BASE_URL: llm.url,
      LOCAL_LLM_BASIC_MODEL: 'fake-stream',
      LOCAL_LLM_ADVANCED_MODEL: 'fake-stream',
    },
  }).catch((err) => {
    console.log(cloud.log.join('').slice(-4000))
    throw err
  })
  cloudUserId = await sessionUserId(cloud.base, machine.cookies)
  localUserId = await sessionUserId(machine.localApiBase, machine.localCookies)
  const { cloud: c, desktop } = clients()
  seeds = {
    cloud: await seedWorkspace(c, machine.cloudWorkspaceId, 'Cloudy'),
    machine: await seedWorkspace(desktop, machine.machineWorkspaceId, 'Machy'),
  }
}, 300_000)

afterAll(async () => {
  await machine?.stop()
  await cloud?.stop()
  await llm?.stop()
})

describeIfInfra('machine workspace opened from the cloud (SHO-257)', () => {
  for (const surface of SURFACES) {
    test(surface.name, async () => {
      const { cloud: c, desktop, view } = clients()

      const base = await read(c, surface.path(seeds.cloud))
      expect(base.status, `cloud baseline: ${base.error}`).toBeLessThan(300)
      surface.shows(surface.view(base.data, seeds.cloud), seeds.cloud)

      const local = await read(desktop, surface.path(seeds.machine))
      expect(local.status, `desktop: ${local.error}`).toBeLessThan(300)
      const desktopView = surface.view(local.data, seeds.machine)
      surface.shows(desktopView, seeds.machine)
      // The machine view answers in the caller's cloud id; the desktop in its own.
      const expected = JSON.stringify(desktopView)?.split(localUserId).join(cloudUserId)

      // Reads of the copy follow the machine's sync, so allow it to catch up.
      let last: { status: number; data: any; error?: string } | null = null
      await waitFor(
        `${surface.name} through the machine view to match the desktop`,
        async () => {
          last = await read(view, surface.path(seeds.machine))
          return last.status < 300 && JSON.stringify(surface.view(last.data, seeds.machine)) === expected
        },
        60_000,
        1_000,
      ).catch((err) => {
        throw new Error(
          `${err.message}\n  desktop: ${expected?.slice(0, 600)}\n  machine view (${last?.status}): ${JSON.stringify(
            last && last.status < 300 ? surface.view(last.data, seeds.machine) : last?.data,
          )?.slice(0, 600)}\n${logs()}`,
        )
      })
    }, 90_000)
  }

  test('an agent turn started from the cloud runs on the machine, against its files', async () => {
    const relay = `${cloud.base}/api/machines/${machine.machineId}/w/${machine.machineWorkspaceId}`
    const ws = machine.machineWorkspaceId
    const headers = { cookie: machine.cookies, 'content-type': 'application/json', origin: cloud.base }
    const canary = `SHO257-CANARY-${Date.now()}`
    const path = '.tmp/sho257-canary.txt'

    // A file that exists only on the machine, written through the cloud.
    await waitFor('the machine workspace runtime to take a file', async () => {
      const res = await fetch(`${relay}/api/workspaces/${ws}/agent-proxy/agent/workspace/files/${path}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ content: canary }),
      })
      return res.status === 200
    }, 120_000, 2_000)
    const readBack = await fetch(`${relay}/api/workspaces/${ws}/agent-proxy/agent/workspace/files/${path}`, { headers })
    expect(readBack.status).toBe(200)
    expect((await readBack.json()).content).toBe(canary)

    // The model reads that file with a tool; the tool must run on the machine.
    const tag = `vm${Date.now() % 100_000}`
    const sessionId = seeds.machine.workspaceChatId
    const res = await fetch(`${relay}/api/workspaces/${ws}/chat`, {
      method: 'POST',
      headers: { ...headers, 'X-Chat-Session-Id': sessionId },
      body: JSON.stringify({
        id: sessionId,
        chatSessionId: sessionId,
        messages: [
          {
            id: `u-${tag}`,
            role: 'user',
            parts: [{ type: 'text', text: `Read it ${marker('tool', tag, 5, { ms: 5, rounds: 1, path })}` }],
          },
        ],
        trigger: 'submit-message',
      }),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const stream = await res.text()
    expect(stream, `turn stream:\n${stream.slice(-2000)}\n${logs()}`).toContain(token(tag, 1))
    expect(stream).not.toContain('"type":"error"')

    const requests = llm.requestsFor(tag)
    expect(requests.length).toBeGreaterThanOrEqual(2)
    expect(requests[0].toolCalled).toBe('read_file')
    expect(requests.some((r: any) => String(r.toolResults ?? '').includes(canary))).toBe(true)
  }, 240_000)

  test("writes go both ways: the cloud writes onto the machine, the machine's writes show in the cloud", async () => {
    const { desktop, view } = clients()
    const channelId = seeds.machine.channelId

    // From the cloud: the interceptor sends the write through the relay, so it
    // lands in the desktop's own database.
    const fromCloud = `from the cloud ${Date.now()}`
    const posted = await send(view, 'POST', `/api/conversations/${encodeURIComponent(channelId)}/messages`, { text: fromCloud })
    expect(posted.status, JSON.stringify(posted.data)).toBeLessThan(300)
    expect(await channelTexts(desktop, channelId)).toContain(fromCloud)
    await waitFor('the cloud write to read back through the machine view', async () =>
      (await channelTexts(view, channelId)).includes(fromCloud), 60_000, 1_000)

    // From the machine: written on the desktop, it reaches the cloud's view.
    const fromMachine = `from the machine ${Date.now()}`
    const local = await send(desktop, 'POST', `/api/conversations/${encodeURIComponent(channelId)}/messages`, { text: fromMachine })
    expect(local.status, JSON.stringify(local.data)).toBeLessThan(300)
    const projectName = `Machy Late ${Date.now() % 10_000}`
    const project = await send(desktop, 'POST', '/api/projects', { name: projectName, workspaceId: machine.machineWorkspaceId })
    expect(project.status, JSON.stringify(project.data)).toBeLessThan(300)
    await waitFor('the machine\'s message in the cloud view', async () =>
      (await channelTexts(view, channelId)).includes(fromMachine), 60_000, 1_000)
    await waitFor('the machine\'s new project in the cloud view', async () => {
      const res = await read(view, `/api/projects?workspaceId=${encodeURIComponent(machine.machineWorkspaceId)}`)
      return JSON.stringify(res.data).includes(projectName)
    }, 60_000, 1_000)
  }, 180_000)

  test('someone who does not own the machine gets nothing from it', async () => {
    const stranger = await signUp(cloud.base, 'stranger')
    const strangerView = machineViewClient(stranger, machine.machineId, machine.machineWorkspaceId)
    const strangerCloud = httpClient(cloud.base, stranger.cookie)

    const machineRow = await read(strangerCloud, `/api/machines/${machine.machineId}`)
    expect([403, 404]).toContain(machineRow.status)
    const relayed = await fetch(`${cloud.base}/api/machines/${machine.machineId}/w/${machine.machineWorkspaceId}/api/projects`, {
      headers: { cookie: stranger.cookie, origin: cloud.base },
    })
    expect([403, 404]).toContain(relayed.status)

    for (const surface of SURFACES) {
      const res = await read(strangerView, surface.path(seeds.machine))
      const leaked = JSON.stringify(res.data ?? '').includes(seeds.machine.tag)
      expect(leaked, `${surface.name} (${res.status}) leaked to a stranger: ${JSON.stringify(res.data).slice(0, 300)}`).toBe(false)
    }

    const text = `stranger ${Date.now()}`
    const write = await send(strangerView, 'POST', `/api/conversations/${encodeURIComponent(seeds.machine.channelId)}/messages`, { text })
    expect(write.status).toBeGreaterThanOrEqual(400)
    expect(await channelTexts(clients().desktop, seeds.machine.channelId)).not.toContain(text)
  }, 120_000)

  test('negative control: the checks tell one workspace from another', async () => {
    const { cloud: c, desktop } = clients()
    let distinguished = 0
    for (const surface of SURFACES) {
      const local = await read(desktop, surface.path(seeds.machine))
      const base = await read(c, surface.path(seeds.cloud))
      const localView = surface.view(local.data, seeds.machine)
      // The machine's answer must not pass for the cloud workspace's content…
      let passedForCloud = true
      try {
        surface.shows(localView, seeds.cloud)
      } catch {
        passedForCloud = false
      }
      if (!passedForCloud) distinguished++
      // …and two different workspaces never compare equal.
      // (an empty list is the same in every workspace, so it proves nothing)
      const empty = ['[]', '{}'].includes(JSON.stringify(localView))
      if (!empty && surface.name !== 'workspace agent profile') {
        expect(JSON.stringify(localView), surface.name).not.toBe(JSON.stringify(surface.view(base.data, seeds.cloud)))
      }
    }
    // Every surface with seeded content (all but activity and the profile).
    expect(distinguished).toBe(SURFACES.length - 2)
  }, 60_000)

  // Last: it switches the machine off.
  test('machine off: the copy stays readable and writes are refused; back on: writes land again', async () => {
    const { desktop, view } = clients()
    const channelId = seeds.machine.channelId
    await machine.kill()

    const projects = await read(view, `/api/projects?workspaceId=${encodeURIComponent(machine.machineWorkspaceId)}`)
    expect(projects.status).toBe(200)
    seeds.machine.projectNames.forEach((n) => expect(JSON.stringify(projects.data)).toContain(n))
    expect(await channelTexts(view, channelId)).toEqual(expect.arrayContaining(seeds.machine.messageTexts))

    const offlineText = `while off ${Date.now()}`
    const refused = await send(view, 'POST', `/api/conversations/${encodeURIComponent(channelId)}/messages`, { text: offlineText })
    expect([409, 503], JSON.stringify(refused.data)).toContain(refused.status)
    const code = (refused.data as any)?.error?.code
    expect(['machine_offline_readonly', 'machine_waking', 'waking', 'offline']).toContain(code)

    await machine.restart()
    const backText = `back on ${Date.now()}`
    await waitFor('a write through the machine view after the machine is back', async () => {
      const res = await send(view, 'POST', `/api/conversations/${encodeURIComponent(channelId)}/messages`, { text: backText })
      return res.status < 300
    }, 180_000, 2_000)
    const texts = await channelTexts(desktop, channelId)
    expect(texts).toContain(backText)
    expect(texts).not.toContain(offlineText)
  }, 360_000)
})
