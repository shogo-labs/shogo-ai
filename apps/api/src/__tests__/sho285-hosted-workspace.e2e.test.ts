// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-285 — a workspace hosted on a paired desktop is a cloud workspace whose
 * compute is the desktop (the metal model).
 *
 * Real processes on both sides: the cloud API (`entry.ts` on Postgres + Redis)
 * and a desktop (`entry.ts` in local mode on its own data dir) paired to it the
 * way the desktop app pairs. Nothing is stubbed but the model (a scripted
 * OpenAI-compatible server), so every claim below is made against the product's
 * own routes, tunnel and sync:
 *
 *   AC1  the hosted workspace is a normal `GET /workspaces` row with
 *        `hostInstanceId`, and its projects, channels, chats and boards are
 *        visible from the cloud
 *   AC2  a message sent from the cloud runs on the desktop and reads a file
 *        that exists only on the desktop's disk; the reply streams in the cloud
 *   AC3  a message sent from the desktop window shows up in the cloud
 *   AC4  a card created in the cloud shows up on the desktop and the reverse;
 *        edited on both sides, the later edit wins
 *   AC5  with the desktop off the cloud still shows everything and a send is
 *        queued (`202 host_offline`); when it comes back it catches up
 *
 * Needs `CHANNELS_TEST_PG_URL` (a server URL; a database is created per run)
 * and `TEST_REDIS_URL`/`REDIS_URL`. Skipped without them.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FakeLlmServer, marker, token } from '../../../desktop/e2e/streaming/fake-llm-server'
import { writeMachineCanary } from '../../../../e2e/staging/machine-pairing'
import {
  httpClient,
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

/**
 * Open the desktop's tunnel the way the Studio does when a person opens the
 * workspace (`POST /instances/:id/request-connect`, then the desktop's own
 * heartbeat picks the request up and connects). A send before this queues as
 * `host_offline` by design; the streaming ACs need the tunnel up.
 */
async function warmHostTunnel(): Promise<void> {
  const { cloud: c } = clients()
  const path = `/api/instances/${encodeURIComponent(machine.machineId)}`
  await send(c, 'POST', `${path}/request-connect`)
  await waitForSync(
    'the desktop tunnel',
    async () => {
      const res = await read(c, path)
      return res.status < 300 && res.data?.status === 'online'
    },
    120_000,
    2_000,
  )
}

function logs(): string {
  return `--- cloud ---\n${cloud?.log.join('').slice(-3000)}\n--- desktop ---\n${machine?.log.join('').slice(-3000)}`
}

/**
 * The desktop's own view of its machine copy (SHO-301): whether the pusher and
 * the puller are moving, why not, and until when. A stalled sync used to leave
 * no trace at all — the only symptom was "the other side never got it".
 */
async function syncStatus(): Promise<string> {
  try {
    const res = await read(clients().desktop, '/api/local/instance-info')
    const sync = res.data?.sync ?? null
    return JSON.stringify(sync ?? `no sync status (HTTP ${res.status})`, null, 2)
  } catch (err) {
    return `unavailable: ${(err as Error)?.message ?? err}`
  }
}

/**
 * `waitFor`, but a timeout says *why*: both processes' logs and the desktop's
 * sync status (pusher `lastError`/`authBlockedUntil`/`stalledUntil`, puller
 * `lastError`/`blockedUntil`). Every wait in this suite goes through here so a
 * flake is diagnosable from the CI log instead of a bare "last: false".
 */
async function waitForSync<T>(
  what: string,
  fn: () => Promise<T | null | undefined | false>,
  timeoutMs = 30_000,
  intervalMs = 250,
): Promise<T> {
  try {
    return await waitFor(what, fn, timeoutMs, intervalMs)
  } catch (err) {
    throw new Error(`${(err as Error).message}\n--- desktop sync ---\n${await syncStatus()}\n${logs()}`)
  }
}

beforeAll(async () => {
  if (!PG_URL || !REDIS_URL) return
  llm = new FakeLlmServer()
  await llm.start(0)
  cloud = await startCloud({ pgServerUrl: PG_URL, redisUrl: REDIS_URL })
  machine = await pairMachine(cloud.base, {
    instanceName: `vm-${Math.random().toString(36).slice(2, 6)}`,
    repoRoot: REPO_ROOT,
    dir: mkdtempSync(join(tmpdir(), 'sho285-desktop-')),
    // The agent turn runs on the desktop; its model is the scripted one, called
    // from the desktop itself rather than forwarded to the cloud's gateway.
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
    // The account's personal workspace is the negative control: a different
    // workspace, on cloud compute. It is not seeded with the full surface set
    // (a personal workspace has no channels or boards) — the control only needs
    // one project of its own.
    cloud: { workspaceId: machine.cloudWorkspaceId } as Seeded,
    machine: await seedWorkspace(desktop, machine.machineWorkspaceId, 'Machy'),
  }
  await c.post('/api/projects', { name: 'Cloudy Only', workspaceId: machine.cloudWorkspaceId })
}, 300_000)

afterAll(async () => {
  await machine?.stop()
  await cloud?.stop()
  await llm?.stop()
})

describeIfInfra('a workspace hosted on a paired desktop (SHO-285)', () => {
  test('AC1 · it is a normal cloud workspace with a host, and everything in it is visible from the cloud', async () => {
    const { cloud: c } = clients()

    // One id, one row: the desktop's workspace is listed by the cloud's own
    // `GET /workspaces`, carrying the instance that hosts it.
    const listed = await read(c, '/api/workspaces')
    const rows: any[] = listed.data?.items ?? listed.data?.workspaces ?? []
    const row = rows.find((w) => w.id === machine.machineWorkspaceId)
    expect(row, `GET /workspaces should list ${machine.machineWorkspaceId}: ${JSON.stringify(listed.data).slice(0, 400)}`).toBeTruthy()
    expect(row.hostInstanceId).toBe(machine.machineId)
    expect(row.name).toBe(machine.machineWorkspaceName)

    // Every surface a screen reads answers from the cloud, with the desktop's
    // content — the rows synced up, they are not a read-only copy. The sync is
    // asynchronous, so wait for it to settle rather than race the pusher.
    let pending = SURFACES.map((surface) => surface.name)
    await waitForSync(
      `every surface to show the desktop's content (still waiting on: ${pending.join(', ')})`,
      async () => {
        pending = []
        for (const surface of SURFACES) {
          const res = await read(c, surface.path(seeds.machine))
          if (res.status >= 300) {
            pending.push(`${surface.name} (${res.status})`)
            continue
          }
          try {
            surface.shows(surface.view(res.data, seeds.machine), seeds.machine)
          } catch {
            pending.push(surface.name)
          }
        }
        return pending.length === 0
      },
      120_000,
      2_000,
    )

    for (const surface of SURFACES) {
      const res = await read(c, surface.path(seeds.machine))
      expect(res.status, `${surface.name}: ${res.error}`).toBeLessThan(300)
      surface.shows(surface.view(res.data, seeds.machine), seeds.machine)
    }
  }, 120_000)

  test('AC2 · a message sent from the cloud runs on the desktop, against a file only the desktop has', async () => {
    const ws = machine.machineWorkspaceId
    const canary = `SHO285-CANARY-${Date.now()}`
    const path = '.tmp/sho285-canary.txt'

    // A file that exists only on the desktop's disk, written through the
    // desktop's own API (never through the cloud).
    await waitForSync('the desktop runtime to take a file', async () => {
      const status = await writeMachineCanary(machine, path, canary)
      return status === 200
    }, 120_000, 2_000)

    await warmHostTunnel()

    // The model reads that file with a tool; the tool must run on the desktop.
    const tag = `h${Date.now() % 100_000}`
    const sessionId = seeds.machine.workspaceChatId
    const res = await fetch(`${cloud.base}/api/workspaces/${ws}/chat`, {
      method: 'POST',
      headers: {
        cookie: machine.cookies,
        'content-type': 'application/json',
        origin: cloud.base,
        'X-Chat-Session-Id': sessionId,
      },
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
    expect(res.status, `cloud send: ${res.status} ${(await res.clone().text()).slice(0, 500)}\n${logs()}`).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const stream = await res.text()
    expect(stream, `turn stream:\n${stream.slice(-2000)}\n${logs()}`).toContain(token(tag, 1))
    expect(stream).not.toContain('"type":"error"')

    // The turn ran on the desktop: the scripted model there saw the tool call
    // and the canary's contents, which the cloud cannot read.
    const requests = llm.requestsFor(tag)
    expect(requests.length).toBeGreaterThanOrEqual(2)
    expect(requests[0].toolCalled).toBe('read_file')
    expect(requests.some((r: any) => String(r.toolResults ?? '').includes(canary))).toBe(true)
  }, 240_000)

  test('AC3 · a message sent from the desktop window shows up in the cloud', async () => {
    const { cloud: c, desktop } = clients()
    const channelId = seeds.machine.channelId
    const text = `from the desktop ${Date.now()}`

    const local = await send(desktop, 'POST', `/api/conversations/${encodeURIComponent(channelId)}/messages`, { text })
    expect(local.status, JSON.stringify(local.data)).toBeLessThan(300)

    await waitForSync('the desktop message in the cloud', async () =>
      (await channelTexts(c, channelId)).includes(text), 60_000, 1_000)
  }, 120_000)

  test('AC4 · a card syncs both ways, and the later edit wins', async () => {
    const { cloud: c, desktop } = clients()
    const boardId = seeds.machine.boardId

    // Cloud → desktop.
    const title = `From the cloud ${Date.now()}`
    const created = await send(c, 'POST', `/api/boards/${encodeURIComponent(boardId)}/items`, { title })
    expect(created.status, JSON.stringify(created.data)).toBeLessThan(300)
    const itemId = created.data?.item?.id
    expect(itemId).toBeTruthy()
    await waitForSync('the cloud card on the desktop', async () => {
      const res = await read(desktop, `/api/work-items/${encodeURIComponent(itemId)}`)
      return res.status < 300 && res.data?.item?.title === title
    }, 60_000, 1_000)

    // Desktop → cloud.
    const localTitle = `From the desktop ${Date.now()}`
    const local = await send(desktop, 'POST', `/api/boards/${encodeURIComponent(boardId)}/items`, { title: localTitle })
    expect(local.status, JSON.stringify(local.data)).toBeLessThan(300)
    const localId = local.data?.item?.id
    await waitForSync('the desktop card in the cloud', async () => {
      const res = await read(c, `/api/work-items/${encodeURIComponent(localId)}`)
      return res.status < 300 && res.data?.item?.title === localTitle
    }, 60_000, 1_000)

    // The same card edited on both sides: the later edit wins everywhere.
    const desktopEdit = `desktop edit ${Date.now()}`
    const cloudEdit = `cloud edit ${Date.now() + 1}`
    expect((await send(desktop, 'PATCH', `/api/work-items/${encodeURIComponent(itemId)}`, { title: desktopEdit })).status).toBeLessThan(300)
    await new Promise((r) => setTimeout(r, 1_100))
    expect((await send(c, 'PATCH', `/api/work-items/${encodeURIComponent(itemId)}`, { title: cloudEdit })).status).toBeLessThan(300)

    await waitForSync('the later edit on the desktop', async () => {
      const res = await read(desktop, `/api/work-items/${encodeURIComponent(itemId)}`)
      return res.status < 300 && res.data?.item?.title === cloudEdit
    }, 60_000, 1_000)
    const inCloud = await read(c, `/api/work-items/${encodeURIComponent(itemId)}`)
    expect(inCloud.data?.item?.title).toBe(cloudEdit)
  }, 180_000)

  // Last: it switches the desktop off.
  test('AC5 · desktop off: the cloud still shows everything and a send is queued; back on: it catches up', async () => {
    const { cloud: c, desktop } = clients()
    const channelId = seeds.machine.channelId
    await machine.kill()

    // Reads come from Postgres, so everything is still there.
    const projects = await read(c, `/api/projects?workspaceId=${encodeURIComponent(machine.machineWorkspaceId)}`)
    expect(projects.status).toBe(200)
    seeds.machine.projectNames.forEach((n) => expect(JSON.stringify(projects.data)).toContain(n))
    expect(await channelTexts(c, channelId)).toEqual(expect.arrayContaining(seeds.machine.messageTexts))

    // A chat send is queued, not refused: the person's message is saved on the
    // session's queue and runs when the desktop is back (the turn runs there).
    const queuedText = `while off ${Date.now()}`
    const queued = await send(c, 'POST', `/api/workspaces/${encodeURIComponent(machine.machineWorkspaceId)}/chat`, {
      chatSessionId: seeds.machine.workspaceChatId,
      messages: [{ id: `u-off-${Date.now()}`, role: 'user', parts: [{ type: 'text', text: queuedText }] }],
    })
    expect(queued.status, JSON.stringify(queued.data)).toBe(202)
    expect((queued.data as any)?.error?.code).toBe('host_offline')

    // A channel message is a durable row, not an agent turn of its own: it is
    // saved and readable while the desktop is off, so the team chat keeps
    // working from the cloud.
    const offChannelText = `saved while off ${Date.now()}`
    const offChannel = await send(c, 'POST', `/api/conversations/${encodeURIComponent(channelId)}/messages`, { text: offChannelText })
    expect(offChannel.status, JSON.stringify(offChannel.data)).toBeLessThan(300)
    await waitForSync('the channel message saved on the cloud', async () =>
      (await channelTexts(c, channelId)).includes(offChannelText), 30_000, 1_000)

    await machine.restart()

    // The cloud's writes reach the desktop again.
    await waitForSync('the channel message on the desktop', async () =>
      (await channelTexts(desktop, channelId)).includes(offChannelText), 180_000, 2_000)

    // And the queued turn runs there, once, as the person's own message.
    await waitForSync('the queued turn on the desktop', async () => {
      const res = await read(desktop, `/api/chat-messages?sessionId=${encodeURIComponent(seeds.machine.workspaceChatId)}&limit=50&offset=0`)
      return JSON.stringify(res.data ?? '').includes(queuedText)
    }, 180_000, 3_000)
  }, 360_000)

  test('someone who does not own the desktop gets nothing from it', async () => {
    const stranger = await signUp(cloud.base, 'stranger')
    const strangerCloud = httpClient(cloud.base, stranger.cookie)

    // The hosted workspace is not in a stranger's list, and its rows are not
    // readable through the cloud.
    const listed = await read(strangerCloud, '/api/workspaces')
    expect(JSON.stringify(listed.data ?? '')).not.toContain(machine.machineWorkspaceId)
    for (const surface of SURFACES) {
      const res = await read(strangerCloud, surface.path(seeds.machine))
      const leaked = JSON.stringify(res.data ?? '').includes(seeds.machine.tag)
      expect(leaked, `${surface.name} (${res.status}) leaked to a stranger: ${JSON.stringify(res.data).slice(0, 300)}`).toBe(false)
    }
  }, 120_000)

  test('negative control: the checks tell one workspace from another', async () => {
    const { cloud: c } = clients()
    // The personal workspace's own project is not in the hosted workspace, and
    // the hosted workspace's projects are not in the personal one.
    const personal = await read(c, `/api/projects?workspaceId=${encodeURIComponent(machine.cloudWorkspaceId)}`)
    expect(personal.status).toBeLessThan(300)
    expect(JSON.stringify(personal.data)).toContain('Cloudy Only')
    seeds.machine.projectNames.forEach((name) => expect(JSON.stringify(personal.data)).not.toContain(name))

    const hosted = await read(c, `/api/projects?workspaceId=${encodeURIComponent(machine.machineWorkspaceId)}`)
    expect(hosted.status).toBeLessThan(300)
    seeds.machine.projectNames.forEach((name) => expect(JSON.stringify(hosted.data)).toContain(name))
    expect(JSON.stringify(hosted.data)).not.toContain('Cloudy Only')
  }, 60_000)
})
