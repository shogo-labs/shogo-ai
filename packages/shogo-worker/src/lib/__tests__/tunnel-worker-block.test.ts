// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The tunnel's socket survives a busy main thread (SHO-185 §5).
 *
 * This is the test the whole Worker move exists for. The fake cloud lives in its
 * own process (`helpers/fake-cloud.ts`) because the point of the test is to block
 * *this* thread: an observer here would be blocked too and could not see the
 * pings it is supposed to be policing.
 *
 * Two cases, same cloud, same block:
 *   • on its own thread — pongs keep flowing, the socket stays open, and a
 *     tunneled request still round-trips afterwards;
 *   • on the API's thread — the deadline passes unanswered and the cloud closes
 *     the socket (1006). That is the bug, and without it the first case would
 *     only prove that a socket somewhere stayed open.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { startTunnelInWorker } from '../tunnel-host'
import { WorkerTunnel, type RuntimeResolver } from '../tunnel'

const BLOCK_MS = 400

interface FakeCloud {
  cloudUrl: string
  pongs: number
  kills: number
  closeCodes: number[]
  requests: { status: number; body: string }[]
  sendRequest: (requestId: string, path: string) => void
  stop: () => void
}

/**
 * Spawn the fake cloud and read its stdout, one JSON event per line.
 *
 * The child is `bun --no-env-file` so the workspace's `.env` cannot point it at a
 * real cloud, and it prints `ready` with the port it bound before anything else.
 */
async function startFakeCloud(): Promise<FakeCloud> {
  // `pathname` stays percent-encoded, and this checkout's path has a space in it.
  const entry = fileURLToPath(new URL('./helpers/fake-cloud.ts', import.meta.url))
  const child = Bun.spawn(['bun', '--no-env-file', entry], {
    stdout: 'pipe',
    stdin: 'pipe',
    stderr: 'inherit',
    env: { ...process.env, FAKE_CLOUD_PING_MS: '40', FAKE_CLOUD_DEADLINE_MS: '120' },
  })

  const state = {
    pongs: 0,
    kills: 0,
    closeCodes: [] as number[],
    requests: [] as { status: number; body: string }[],
  }

  let port = 0
  let buffer = ''
  let settleReady: (port: number) => void = () => {}
  const ready = new Promise<number>((resolve) => {
    settleReady = resolve
  })

  const drain = (async () => {
    const stream = child.stdout as ReadableStream<Uint8Array>
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
        if (!line) continue
        let event: any
        try {
          event = JSON.parse(line)
        } catch {
          continue
        }
        if (event.event === 'ready') {
          port = Number(event.port)
          settleReady(port)
        } else if (event.event === 'pong') state.pongs += 1
        else if (event.event === 'kill') state.kills += 1
        else if (event.event === 'close') state.closeCodes.push(Number(event.code))
        else if (event.event === 'request') {
          state.requests.push({ status: Number(event.status), body: String(event.body ?? '') })
        }
      }
    }
  })().catch(() => {})

  await ready

  return {
    cloudUrl: `http://127.0.0.1:${port}`,
    get pongs() {
      return state.pongs
    },
    get kills() {
      return state.kills
    },
    get closeCodes() {
      return state.closeCodes
    },
    get requests() {
      return state.requests
    },
    sendRequest(requestId: string, path: string) {
      child.stdin?.write(`${JSON.stringify({ type: 'request', requestId, path })}\n`)
    },
    stop() {
      try {
        child.kill()
      } catch {
        // already gone
      }
      void drain
    },
  }
}

let localApi: Server
let localPort = 0

const resolver: RuntimeResolver = {
  async resolveLocalUrl(pathWithQuery: string) {
    return `http://127.0.0.1:${localPort}${pathWithQuery}`
  },
  async deriveRuntimeToken() {
    return 'runtime-token'
  },
  getActiveProjects() {
    return ['proj-1']
  },
  status() {
    return { status: 'running', agentPort: 1234 }
  },
}

beforeAll(async () => {
  localApi = createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ answeredBy: 'local-api', path: req.url }))
  })
  await new Promise<void>((resolve) => localApi.listen(0, '127.0.0.1', () => resolve()))
  localPort = (localApi.address() as AddressInfo).port
})

afterAll(async () => {
  await new Promise<void>((resolve) => localApi.close(() => resolve()))
})

/** Burn this thread — the local API's thread — past the cloud's deadline. */
function blockMainThread(ms: number): void {
  const until = Date.now() + ms
  while (Date.now() < until) {
    // A busy loop is the honest stand-in for a `lsof` or a big write.
  }
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

async function waitFor(predicate: () => boolean, timeoutMs = 8_000): Promise<void> {
  const started = Date.now()
  while (Date.now() < started + timeoutMs) {
    if (predicate()) return
    await wait(20)
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for a condition that never held`)
}

describe('a tunnel on its own thread', () => {
  test('keeps its socket through a main thread blocked for 4× the ping interval', async () => {
    const cloud = await startFakeCloud()
    const host = startTunnelInWorker({
      apiKey: 'test-key',
      cloudUrl: cloud.cloudUrl,
      name: 'worker-test',
      kind: 'desktop',
      resolver,
      logger: { log: () => {}, warn: () => {}, error: () => {} },
    })

    try {
      await host.ready()
      // The socket only opens once the cloud asks for it on a heartbeat.
      await waitFor(() => cloud.pongs > 0)
      const before = cloud.pongs

      blockMainThread(BLOCK_MS)

      // The cloud never reached for the close code, and the pongs never stopped.
      expect(cloud.kills).toBe(0)
      expect(cloud.closeCodes).toEqual([])
      await waitFor(() => cloud.pongs > before, 3_000)

      // And the tunnel still forwards afterwards: a request pushed down the
      // socket comes back from the local API.
      cloud.sendRequest('req-after-block', '/api/projects')
      await waitFor(() => cloud.requests.some((entry) => entry.status === 200), 8_000)
      expect(cloud.requests.find((entry) => entry.status === 200)?.body).toContain('local-api')
    } finally {
      host.stop()
      cloud.stop()
    }
  }, 40_000)

  test('the same block kills an in-process tunnel — the bug §5 fixes', async () => {
    const cloud = await startFakeCloud()
    const tunnel = new WorkerTunnel({
      apiKey: 'test-key',
      cloudUrl: cloud.cloudUrl,
      name: 'in-process',
      kind: 'desktop',
      resolver,
      logger: { log: () => {}, warn: () => {}, error: () => {} },
    })

    try {
      tunnel.start()
      await waitFor(() => cloud.pongs > 0)

      blockMainThread(BLOCK_MS)

      // The cloud's deadline passed with the pong stuck behind the block, so it
      // closed the socket: this is the 1006 the person sees as "machine offline".
      await waitFor(() => cloud.kills > 0)
      expect(cloud.kills).toBeGreaterThan(0)
    } finally {
      tunnel.stop()
      cloud.stop()
    }
  }, 40_000)
})
