// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Browser terminal → studio PTY bridge → runtime pod, all real, over real
 * sockets:
 *
 *   PtyClient (apps/mobile)  ──ws──▶  gateway: createPtyPodBridgeHandlers
 *                                       ──ws──▶  pod: handlePtyUpgrade +
 *                                                runtimeTerminalRoutes +
 *                                                PtySessionManager (real shell)
 *
 * 2026-10-17 production: a session the runtime no longer had (VM restarted)
 * was retried by one browser tab ~500 times in 53 minutes. The pod refuses the
 * upgrade with a plain 404, the WS client only sees "Expected 101", and the
 * bridge reported 1011 'pod-unreachable' — which PtyClient retries forever.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { PtySessionManager } from '@shogo/agent-runtime/src/pty-session-manager'
import { createPtyWsHandlers, handlePtyUpgrade } from '@shogo/agent-runtime/src/pty-ws-handler'
import { runtimeTerminalRoutes } from '@shogo/agent-runtime/src/runtime-terminal-routes'
import { PtyClient, type PtyClientState } from '../../../mobile/components/project/panels/ide/terminal/pty-client'
import { buildPtyPodBridgeData, createPtyPodBridgeHandlers, type PtyPodBridgeData } from '../lib/pty-pod-bridge'

const TOKEN = 'runtime-token-test'

let workspaceDir: string
let manager: PtySessionManager
let pod: ReturnType<typeof Bun.serve>
let gateway: ReturnType<typeof Bun.serve>

beforeAll(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), 'pty-dead-session-'))
  manager = new PtySessionManager({ workspaceDir, sweepIntervalMs: 0 })
  const { router } = runtimeTerminalRoutes({ workspaceDir, manager })
  const ptyWs = createPtyWsHandlers()

  pod = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req, server) {
      if (req.headers.get('x-runtime-token') !== TOKEN) return new Response('Unauthorized', { status: 401 })
      const upgraded = handlePtyUpgrade(req, server as any, manager)
      if (upgraded !== null) return upgraded
      return router.fetch(req)
    },
    websocket: {
      open: (ws: any) => ptyWs.open(ws),
      message: (ws: any, msg: any) => ptyWs.message(ws, msg),
      close: (ws: any, code?: number, reason?: string) => ptyWs.close(ws, code, reason),
    },
  })

  const bridge = createPtyPodBridgeHandlers({ logger: { error: () => {} } })
  gateway = Bun.serve<PtyPodBridgeData, never>({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req, server) {
      const url = new URL(req.url)
      const sessionId = url.pathname.split('/')[2]!
      const data = buildPtyPodBridgeData({
        podUrl: `http://127.0.0.1:${pod.port}`,
        sessionId,
        since: Number(url.searchParams.get('since')) || 0,
        runtimeToken: TOKEN,
      })
      if (server.upgrade(req, { data })) return undefined
      return new Response('upgrade failed', { status: 500 })
    },
    websocket: {
      open: (ws) => bridge.open(ws),
      message: (ws, msg) => bridge.message(ws, msg as any),
      close: (ws, code, reason) => bridge.close(ws, code, reason),
    },
  })
})

afterAll(() => {
  gateway?.stop(true)
  pod?.stop(true)
  manager?.dispose?.()
  rmSync(workspaceDir, { recursive: true, force: true })
})

function connect(sessionId: string) {
  let dials = 0
  const states: PtyClientState[] = []
  const output: string[] = []
  const client = new PtyClient(
    {
      url: `ws://127.0.0.1:${gateway.port}/sessions/${sessionId}/ws`,
      minBackoffMs: 10,
      maxBackoffMs: 40,
      wsFactory: (u) => {
        dials++
        return new WebSocket(u)
      },
    },
    {
      onState: (s) => states.push(s),
      onData: (b) => output.push(new TextDecoder().decode(b)),
    },
  )
  client.connect()
  return { client, states, output, dials: () => dials }
}

async function until(cond: () => boolean, ms = 5000) {
  const deadline = Date.now() + ms
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition')
    await Bun.sleep(10)
  }
}

describe('terminal over the PTY bridge (real sockets)', () => {
  test('a live session relays keystrokes and shell output end to end', async () => {
    const rec = manager.create({ cwd: workspaceDir, cmd: ['/bin/sh'] })
    const t = connect(rec.id)
    try {
      await until(() => t.client.state === 'open')
      t.client.send('echo pty-bridge-$((40+2))\n')
      await until(() => t.output.join('').includes('pty-bridge-42'))
    } finally {
      t.client.dispose()
      manager.kill(rec.id)
    }
  })

  test('a session the pod no longer has is not retried', async () => {
    const rec = manager.create({ cwd: workspaceDir, cmd: ['/bin/sh'] })
    manager.kill(rec.id)
    await until(() => manager.get(rec.id) === null)

    const t = connect(rec.id)
    try {
      await until(() => t.states.includes('closed'))
      // Give a retry loop (10–40ms backoff) ample room to show itself.
      await Bun.sleep(600)
      expect(t.dials()).toBe(1)
      expect(t.client.state).toBe('closed')
    } finally {
      t.client.dispose()
    }
  })

  test('a pod that is down is still retried (it may be cold-starting)', async () => {
    const down = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('', { status: 503 }) })
    const port = down.port
    down.stop(true)
    const bridge = createPtyPodBridgeHandlers({ logger: { error: () => {} } })
    const gw = Bun.serve<PtyPodBridgeData, never>({
      port: 0,
      hostname: '127.0.0.1',
      fetch(req, server) {
        const data = buildPtyPodBridgeData({ podUrl: `http://127.0.0.1:${port}`, sessionId: 's', since: 0, runtimeToken: TOKEN })
        return server.upgrade(req, { data }) ? undefined : new Response('upgrade failed', { status: 500 })
      },
      websocket: {
        open: (ws) => bridge.open(ws),
        message: (ws, msg) => bridge.message(ws, msg as any),
        close: (ws, code, reason) => bridge.close(ws, code, reason),
      },
    })
    let dials = 0
    const client = new PtyClient({
      url: `ws://127.0.0.1:${gw.port}/ws`,
      minBackoffMs: 10,
      maxBackoffMs: 40,
      wsFactory: (u) => {
        dials++
        return new WebSocket(u)
      },
    })
    try {
      client.connect()
      await until(() => dials >= 3)
    } finally {
      client.dispose()
      gw.stop(true)
    }
  })
})
