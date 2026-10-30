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
})
