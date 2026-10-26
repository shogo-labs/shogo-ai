// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-185 — the cross-pod tunnel relay, on two real API processes and a real
 * Redis.
 *
 * Every relay test before this one mocked `lib/tunnel-redis`, so nothing ever
 * checked what a *second pod* does when the first one is slow. On prod-US a slow
 * relay made the requesting pod delete a live tunnel's owner key, and the
 * heartbeat's `EXPIRE` could not put it back, so every later call 503'd
 * "Machine is offline" for the life of the socket.
 *
 * Requires a real Redis (`TEST_REDIS_URL`, set in the CI job that already runs
 * the Redis service). Not skipped quietly in CI: with `CI_REQUIRE_REDIS=1` a
 * missing server fails the run.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { spawn, type Subprocess } from 'bun'
import Redis from 'ioredis'
import { join } from 'path'

const REDIS_URL = process.env.TEST_REDIS_URL || process.env.REDIS_URL
const WORKER = join(import.meta.dir, 'helpers', 'relay-pod.ts')

if (!REDIS_URL && process.env.CI_REQUIRE_REDIS === '1') {
  throw new Error('SHO-185 two-pod relay test needs TEST_REDIS_URL (real Redis)')
}

const describeIfRedis = REDIS_URL ? describe : describe.skip

let redis: Redis
/** Each test gets its own pod ids: two owners sharing a POD_ID both subscribe to
 *  the same `tunnel:pod:<id>:request` channel and race to answer. */
let podCounter = 0
const nextPod = (prefix = 'pod') => `${prefix}-${++podCounter}`
/** Every spawned worker, so a failed assertion cannot leak processes. */
const workers: Subprocess[] = []
/** One stdout reader per worker, so buffered bytes are never lost. */
const readers = new WeakMap<Subprocess, { reader: ReadableStreamDefaultReader<Uint8Array>; buffer: string }>()

function podEnv(podId: string, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  // The ambient shell (and the local dev API) sets these; the relay modules read
  // them at import time and would otherwise run in single-process "local mode".
  delete env.SHOGO_LOCAL_MODE
  env.HOSTNAME = podId
  env.REDIS_URL = REDIS_URL!
  env.TEST_REDIS_URL = REDIS_URL!
  delete env.TUNNEL_REDIS_REINIT_MS
  return { ...env, ...extra }
}

function runPod(args: string[], env: Record<string, string>): Subprocess {
  const proc = spawn({
    cmd: ['bun', '--no-env-file', WORKER, ...args],
    cwd: join(import.meta.dir, '..', '..'),
    env,
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'pipe',
  })
  workers.push(proc)
  readers.set(proc, { reader: (proc.stdout as ReadableStream<Uint8Array>).getReader(), buffer: '' })
  return proc
}

/**
 * Read stdout until a line matches, buffering across calls. Workers log their own
 * startup lines (`[TunnelRedis] Initialized …`), so a plain "first line" read
 * picks up the wrong one.
 */
async function waitForLine(proc: Subprocess, match: (line: string) => boolean, deadlineMs = 20_000): Promise<string> {
  const state = readers.get(proc)!
  const deadline = Date.now() + deadlineMs
  while (Date.now() < deadline) {
    const newline = state.buffer.indexOf('\n')
    if (newline >= 0) {
      const line = state.buffer.slice(0, newline).trim()
      state.buffer = state.buffer.slice(newline + 1)
      if (line && match(line)) return line
      continue
    }
    const remaining = deadline - Date.now()
    const read = await Promise.race([
      state.reader.read(),
      new Promise<{ done: true; value: undefined }>((resolve) =>
        setTimeout(() => resolve({ done: true, value: undefined }), Math.max(remaining, 1)),
      ),
    ])
    if (read.done) {
      const tail = state.buffer.trim()
      throw new Error(`worker produced no matching line. buffered=${JSON.stringify(tail)}`)
    }
    state.buffer += new TextDecoder().decode(read.value, { stream: true })
  }
  throw new Error('worker timed out producing a line')
}

/** Spawn the owner pod and wait until it holds the tunnel. */
async function startOwner(instanceId: string, podId: string, env: Record<string, string>) {
  const proc = runPod(['owner', instanceId], env)
  await waitForLine(proc, (line) => line === 'READY')
  expect(await redis.get(`tunnel:${instanceId}:pod`)).toBe(podId)
  return proc
}

/** Run one request from a *different* pod and return its JSON result. */
async function relayFrom(instanceId: string, podId: string, env: Record<string, string>, path?: string) {
  const proc = runPod(['requester', instanceId, ...(path ? [path] : [])], env)
  const line = await waitForLine(proc, (l) => l.startsWith('{'))
  const err = await new Response(proc.stderr as ReadableStream).text().catch(() => '')
  try {
    return JSON.parse(line)
  } catch {
    throw new Error(`requester printed no JSON (${line}) stderr=${err}`)
  }
}

beforeAll(async () => {
  if (!REDIS_URL) return
  redis = new Redis(REDIS_URL, { lazyConnect: false, maxRetriesPerRequest: 2 })
  await redis.ping()
})

function killWorkers() {
  for (const proc of workers) {
    try { proc.kill() } catch { /* already gone */ }
  }
  workers.length = 0
}

afterEach(() => killWorkers())

afterAll(async () => {
  killWorkers()
  await redis?.quit().catch(() => {})
})

describeIfRedis('two API pods, one real Redis', () => {
  test('a tunnel on pod A serves a request that lands on pod B', async () => {
    const instanceId = `inst-relay-${Date.now()}`
    const ownerPod = nextPod('pod-A')
    const requesterPod = nextPod('pod-B')
    await startOwner(instanceId, ownerPod, podEnv(ownerPod))

    const result = await relayFrom(instanceId, requesterPod, podEnv(requesterPod))

    expect(result.ok).toBe(true)
    expect(result.status).toBe(200)
    expect(result.body).toBe('pong-from-desktop')
    // The relay must not disturb ownership on the happy path.
    expect(await redis.get(`tunnel:${instanceId}:pod`)).toBe(ownerPod)
  }, 30_000)

  test('a relay timeout keeps a live owner, and later calls still work', async () => {
    const instanceId = `inst-slow-${Date.now()}`
    const ownerPod = nextPod('pod-A')
    const requesterPod = nextPod('pod-B')
    // Owner never times out on its own (60s proxy), so only the requester pod's
    // relay deadline can end the request — the exact prod shape.
    await startOwner(instanceId, ownerPod, podEnv(ownerPod, { SHOGO_PROXY_TIMEOUT_MS: '60000' }))

    // The requester gives up long before the owner would: proxy 1s + 0.5s grace.
    const slowEnv = podEnv(requesterPod, { SHOGO_PROXY_TIMEOUT_MS: '1000', SHOGO_RELAY_GRACE_MS: '500' })
    const timedOut = await relayFrom(instanceId, requesterPod, slowEnv, '/api/chat/never')

    // A typed timeout, not "Machine is offline": the pod answered the probe.
    expect(timedOut.ok).toBe(false)
    expect(timedOut.code).toBe('machine_timeout')
    expect(timedOut.message).not.toMatch(/offline/i)

    // The bug: this key was deleted here, and EXPIRE could never restore it.
    expect(await redis.get(`tunnel:${instanceId}:pod`)).toBe(ownerPod)

    // And the tunnel keeps working through the very pod that timed out.
    const after = await relayFrom(instanceId, requesterPod, slowEnv)
    expect(after.ok).toBe(true)
    expect(after.status).toBe(200)
    expect(after.body).toBe('pong-from-desktop')
  }, 40_000)
})
