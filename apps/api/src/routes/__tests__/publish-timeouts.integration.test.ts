// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The publish build talks to a real HTTP server standing in for the runtime.
 * A hung build is aborted with the production timeout and retried once.
 * A hard failure is not retried. Metal configure waits longer than Knative.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test'
import { createServer, type Server, type IncomingMessage } from 'node:http'

const pod = { url: 'http://127.0.0.1:9' }
const substrate = { kind: 'knative' as 'knative' | 'metal' }

mock.module('../../lib/knative-project-manager', () => ({
  getKnativeProjectManager: () => ({}),
  getProjectPodUrl: async () => pod.url,
}))
mock.module('../../lib/project-runtime-token', () => ({
  deriveProjectRuntimeToken: async () => 'rt-test',
}))
mock.module('../../lib/substrate/router', () => ({
  getPublishSubstrate: async () => ({ kind: substrate.kind }),
}))

import { publishConfigureTimeoutMs, triggerBuildWithRetry } from '../publish'

let server: Server | null = null
const realTimeout = AbortSignal.timeout.bind(AbortSignal)

async function listen(handler: (req: IncomingMessage, res: import('node:http').ServerResponse) => void): Promise<number> {
  server = createServer(handler)
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('failed to bind')
  return address.port
}

afterEach(async () => {
  AbortSignal.timeout = realTimeout
  substrate.kind = 'knative'
  if (server) {
    await new Promise<void>((resolve, reject) => server!.close((err) => err ? reject(err) : resolve()))
    server = null
  }
})

describe('publish build timeout and retry', () => {
  test('a hung build is aborted at the production timeout and retried once', async () => {
    const seen: number[] = []
    AbortSignal.timeout = ((ms: number) => {
      seen.push(ms)
      return realTimeout(ms >= 1_000 ? 40 : ms)
    }) as typeof AbortSignal.timeout

    let calls = 0
    const port = await listen((req, res) => {
      calls++
      if (calls === 1) {
        req.on('close', () => {})
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    })
    pod.url = `http://127.0.0.1:${port}`

    const result = await triggerBuildWithRetry('proj-1')
    expect(result.success).toBe(true)
    expect(calls).toBe(2)
    expect(seen.filter((ms) => ms === (Number(process.env.PUBLISH_BUILD_TIMEOUT_MS) || 180_000))).toHaveLength(2)
  })

  test('a failed build is not retried', async () => {
    let calls = 0
    const port = await listen((_req, res) => {
      calls++
      res.writeHead(500, { 'content-type': 'text/plain' })
      res.end('build exploded')
    })
    pod.url = `http://127.0.0.1:${port}`

    const result = await triggerBuildWithRetry('proj-1')
    expect(result.success).toBe(false)
    expect(result.code).toBe('build_failed')
    expect(calls).toBe(1)
  })

  test('metal configure waits 150s and knative stays at 60s', async () => {
    substrate.kind = 'metal'
    expect(await publishConfigureTimeoutMs('proj-1')).toBe(Number(process.env.PUBLISH_CONFIGURE_TIMEOUT_METAL_MS) || 150_000)
    substrate.kind = 'knative'
    expect(await publishConfigureTimeoutMs('proj-1')).toBe(Number(process.env.PUBLISH_CONFIGURE_TIMEOUT_MS) || 60_000)
  })
})
