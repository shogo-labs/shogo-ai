#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Team chat load test: many people in one cloud team workspace, all holding
 * the realtime socket, typing and posting in #general. Measures what a
 * person feels — how long a post takes, how long until everyone else sees
 * it, whether anyone missed it — plus typing and presence.
 *
 * Runs against a cloud-mode API (Postgres + Redis). Start one with
 * LOAD_TEST_SECRET set so sign-ups from one IP aren't throttled (the
 * per-user chat limits still apply, as in production):
 *
 *   DATABASE_URL=<pg> REDIS_URL=<redis> BETTER_AUTH_SECRET=x BETTER_AUTH_URL=http://localhost:8012 \
 *     API_PORT=8012 LOAD_TEST_SECRET=lt bun --no-env-file apps/api/src/entry.ts
 *
 *   LOAD_TEST_KEY=lt bun load-tests/team-chat.ts --users 25,50,100,200 --rate 0.5 --duration 60
 *
 * Options (flags or env):
 *   --base      BASE_URL        API origin (http://localhost:8012)
 *   --users     USERS           comma list of stage sizes; each stage reuses the first N people (25,50,100)
 *   --rate      RATE            posts per person per second (0.5; the chat limit is 1/s)
 *   --duration  DURATION        seconds of posting per stage (30)
 *   --server-pid SERVER_PID     sample the API process's CPU and memory
 *   --out       OUT             also write the results as JSON here
 *
 * Exits 1 if a stage misses the targets printed at the end.
 */

type Stage = {
  users: number
  postsSent: number
  postStatus: Record<string, number>
  postMs: number[]
  fanoutMs: number[]
  deliveriesExpected: number
  deliveriesReceived: number
  typingExpected: number
  typingReceived: number
  typingMs: number[]
  socketDrops: number
  connectMs: number[]
  presenceOk: number
  presenceMs: number
  clientLagMaxMs: number
  serverCpuMax: number | null
  serverRssMaxMb: number | null
  durationS: number
}

function arg(name: string, env: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`)
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1]!
  return process.env[env] ?? fallback
}

const BASE = arg('base', 'BASE_URL', 'http://localhost:8012').replace(/\/$/, '')
const STAGES = arg('users', 'USERS', '25,50,100').split(',').map((n) => parseInt(n, 10)).filter((n) => n > 0)
const RATE = parseFloat(arg('rate', 'RATE', '0.5'))
const DURATION_S = parseFloat(arg('duration', 'DURATION', '30'))
const SERVER_PID = arg('server-pid', 'SERVER_PID', '')
const OUT = arg('out', 'OUT', '')
const LOAD_KEY = process.env.LOAD_TEST_KEY ?? ''
const RUN = Date.now().toString(36)

const TARGETS = {
  postP95Ms: 500,
  fanoutP95Ms: 500,
  deliveryPct: 99.9,
  errorPct: 1,
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function pct(values: number[], p: number): number {
  if (!values.length) return NaN
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!
}

const fmt = (n: number) => (Number.isFinite(n) ? `${Math.round(n)}` : '–')

async function pool<T>(items: T[], size: number, fn: (item: T, i: number) => Promise<void>): Promise<void> {
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++
        await fn(items[i]!, i)
      }
    }),
  )
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface Person {
  id: string
  name: string
  cookie: string
  socket?: WebSocket
}

function headers(p?: Person, json = true): Record<string, string> {
  const h: Record<string, string> = { origin: BASE }
  if (json) h['content-type'] = 'application/json'
  if (p) h.cookie = p.cookie
  if (LOAD_KEY) h['x-load-test-key'] = LOAD_KEY
  return h
}

async function call(p: Person | undefined, method: string, path: string, body?: unknown) {
  // Bodiless POSTs without a JSON content type are refused as cross-site.
  const payload = body ?? (method === 'GET' ? undefined : {})
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: headers(p, payload !== undefined),
    body: payload === undefined ? undefined : JSON.stringify(payload),
  })
  const data = await res.json().catch(() => null)
  return { status: res.status, data, res }
}

async function signUp(i: number): Promise<Person> {
  const name = `Load ${i}`
  const { status, data, res } = await call(undefined, 'POST', '/api/auth/sign-up/email', {
    email: `load-${RUN}-${i}@example.com`,
    password: 'Passw0rd!long-enough',
    name,
  })
  if (status !== 200) throw new Error(`sign-up ${i} failed: ${status} ${JSON.stringify(data)}`)
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ')
  return { id: data.user.id, name, cookie }
}

// ─── Monitors ───────────────────────────────────────────────────────────────

/** How late this process's timers fire; a busy client inflates latencies. */
function watchClientLag(): () => number {
  let max = 0
  let expected = Date.now() + 100
  const t = setInterval(() => {
    max = Math.max(max, Date.now() - expected)
    expected = Date.now() + 100
  }, 100)
  return () => {
    clearInterval(t)
    return max
  }
}

function watchServer(): () => { cpu: number | null; rssMb: number | null } {
  if (!SERVER_PID) return () => ({ cpu: null, rssMb: null })
  let cpu = 0
  let rss = 0
  const t = setInterval(async () => {
    const out = await new Response(Bun.spawn(['ps', '-o', 'rss=,%cpu=', '-p', SERVER_PID]).stdout).text()
    const [r, c] = out.trim().split(/\s+/).map(Number)
    if (Number.isFinite(r)) rss = Math.max(rss, r! / 1024)
    if (Number.isFinite(c)) cpu = Math.max(cpu, c!)
  }, 1000)
  return () => {
    clearInterval(t)
    return { cpu, rssMb: rss }
  }
}

// ─── Stage ──────────────────────────────────────────────────────────────────

async function runStage(people: Person[], workspaceId: string, conversationId: string): Promise<Stage> {
  const n = people.length
  const stage: Stage = {
    users: n,
    postsSent: 0,
    postStatus: {},
    postMs: [],
    fanoutMs: [],
    deliveriesExpected: 0,
    deliveriesReceived: 0,
    typingExpected: 0,
    typingReceived: 0,
    typingMs: [],
    socketDrops: 0,
    connectMs: [],
    presenceOk: 0,
    presenceMs: 0,
    clientLagMaxMs: 0,
    serverCpuMax: null,
    serverRssMaxMb: null,
    durationS: DURATION_S,
  }
  const sentAt = new Map<string, number>()
  const typingAt = new Map<string, number>()
  let running = true

  const wsUrl = `${BASE.replace(/^http/, 'ws')}/api/workspaces/${workspaceId}/rt`
  await pool(people, 20, async (p) => {
    const started = performance.now()
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(wsUrl, { headers: headers(p, false) } as any)
      const timer = setTimeout(() => reject(new Error(`socket for ${p.name} never got ready`)), 15_000)
      ws.onmessage = (ev) => {
        const frame = JSON.parse(String(ev.data))
        const now = performance.now()
        if (frame.type === 'ready') {
          clearTimeout(timer)
          stage.connectMs.push(now - started)
          resolve()
        } else if (frame.type === 'message.created') {
          const at = sentAt.get(frame.message?.clientMsgId)
          if (at !== undefined) {
            stage.deliveriesReceived++
            stage.fanoutMs.push(now - at)
          }
        } else if (frame.type === 'typing' && frame.conversationId === conversationId) {
          const at = typingAt.get(frame.userId)
          if (at !== undefined) {
            stage.typingReceived++
            stage.typingMs.push(now - at)
          }
        }
      }
      ws.onclose = () => {
        if (running) stage.socketDrops++
      }
      ws.onerror = () => reject(new Error(`socket for ${p.name} failed`))
      p.socket = ws
    })
  })

  const stopLag = watchClientLag()
  const stopServer = watchServer()
  const end = performance.now() + DURATION_S * 1000
  const interval = 1000 / RATE

  await Promise.all(
    people.map(async (p, i) => {
      // Spread first posts across one interval so people don't post in lockstep.
      await sleep(Math.random() * interval)
      let k = 0
      while (performance.now() < end) {
        p.socket!.send(JSON.stringify({ type: 'typing', conversationId }))
        typingAt.set(p.id, performance.now())
        stage.typingExpected += n - 1
        await sleep(300)
        const clientMsgId = `lt-${RUN}-${n}-${i}-${k++}`
        const started = performance.now()
        sentAt.set(clientMsgId, started)
        stage.postsSent++
        stage.deliveriesExpected += n
        let status = 'error'
        try {
          const res = await call(p, 'POST', `/api/conversations/${conversationId}/messages`, {
            text: `load ${n}/${i} #${k}`,
            clientMsgId,
          })
          status = String(res.status)
          stage.postMs.push(performance.now() - started)
          if (res.status >= 300) {
            sentAt.delete(clientMsgId)
            stage.deliveriesExpected -= n
          }
        } catch {
          sentAt.delete(clientMsgId)
          stage.deliveriesExpected -= n
        }
        stage.postStatus[status] = (stage.postStatus[status] ?? 0) + 1
        // Never faster than the server's 2s typing throttle.
        await sleep(Math.max(2000, interval * (1 + Math.random() * 0.4)) - 300)
      }
    }),
  )
  // Let the last events arrive.
  await sleep(3000)
  stage.clientLagMaxMs = stopLag()
  const server = stopServer()
  stage.serverCpuMax = server.cpu
  stage.serverRssMaxMb = server.rssMb

  // Batched: ~400 ids would push the URL past the server's 16KB header limit.
  const presenceStarted = performance.now()
  const statuses: Record<string, string> = {}
  for (let i = 0; i < people.length; i += 200) {
    const ids = people.slice(i, i + 200).map((p) => p.id).join(',')
    const res = await call(people[0], 'GET', `/api/workspaces/${workspaceId}/presence?userIds=${ids}`)
    Object.assign(statuses, res.data?.presence ?? {})
  }
  stage.presenceMs = performance.now() - presenceStarted
  stage.presenceOk = people.filter((p) => statuses[p.id] === 'active').length

  running = false
  for (const p of people) p.socket?.close()
  await sleep(500)
  return stage
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const health = await fetch(`${BASE}/api/health`).catch(() => null)
  if (!health?.ok) throw new Error(`No API at ${BASE}`)
  const max = Math.max(...STAGES)
  console.log(`Team chat load test against ${BASE}: stages ${STAGES.join(', ')} people, ${RATE} posts/person/s, ${DURATION_S}s each`)

  const setupStarted = performance.now()
  const owner = await signUp(0)
  const workspaces = (await call(owner, 'GET', '/api/workspaces')).data.items as Array<{ id: string; kind: string }>
  const team = workspaces.find((w) => w.kind === 'team')!
  const link = await call(owner, 'POST', '/api/invite-links', { workspaceId: team.id })
  if (link.status !== 200) throw new Error(`invite link failed: ${link.status} ${JSON.stringify(link.data)}`)
  const people: Person[] = [owner]
  await pool(Array.from({ length: max - 1 }, (_, i) => i + 1), 10, async (i) => {
    const p = await signUp(i)
    const accepted = await call(p, 'POST', `/api/invite-links/${link.data.data.token}/accept`)
    if (accepted.status >= 300) throw new Error(`accept ${i} failed: ${accepted.status} ${JSON.stringify(accepted.data)}`)
    people.push(p)
  })
  const channels = (await call(owner, 'GET', `/api/workspaces/${team.id}/conversations`)).data.conversations as Array<{ id: string; slug: string }>
  const general = channels.find((c) => c.slug === 'general')
  if (!general) throw new Error('no #general channel')
  console.log(`Set up ${people.length} people in one workspace in ${fmt((performance.now() - setupStarted) / 1000)}s\n`)

  const results: Stage[] = []
  for (const size of STAGES) {
    process.stdout.write(`Stage ${size} people… `)
    const stage = await runStage(people.slice(0, size), team.id, general.id)
    results.push(stage)
    console.log(`done (${stage.postsSent} posts)`)
  }

  console.log('')
  const rows = results.map((s) => {
    const ok = s.postStatus['201'] ?? 0
    const limited = s.postStatus['429'] ?? 0
    const errors = s.postsSent - ok - limited
    const errorPct = s.postsSent ? (errors / s.postsSent) * 100 : 0
    const deliveryPct = s.deliveriesExpected ? (s.deliveriesReceived / s.deliveriesExpected) * 100 : 100
    const pass =
      pct(s.postMs, 95) <= TARGETS.postP95Ms &&
      pct(s.fanoutMs, 95) <= TARGETS.fanoutP95Ms &&
      deliveryPct >= TARGETS.deliveryPct &&
      errorPct <= TARGETS.errorPct &&
      s.socketDrops === 0
    return {
      people: s.users,
      'posts/s': (ok / s.durationS).toFixed(1),
      'events/s': fmt(s.deliveriesReceived / s.durationS),
      'post p50/p95/p99 ms': `${fmt(pct(s.postMs, 50))}/${fmt(pct(s.postMs, 95))}/${fmt(pct(s.postMs, 99))}`,
      'seen-by-all p50/p95/p99 ms': `${fmt(pct(s.fanoutMs, 50))}/${fmt(pct(s.fanoutMs, 95))}/${fmt(pct(s.fanoutMs, 99))}`,
      delivered: `${deliveryPct.toFixed(2)}%`,
      'typing p95 ms': fmt(pct(s.typingMs, 95)),
      'typing seen': s.typingExpected ? `${((s.typingReceived / s.typingExpected) * 100).toFixed(1)}%` : '–',
      '429 / errors': `${limited} / ${errors}`,
      drops: s.socketDrops,
      'presence ok': `${s.presenceOk}/${s.users}`,
      'connect p95 ms': fmt(pct(s.connectMs, 95)),
      'server cpu% / MB': s.serverCpuMax === null ? '–' : `${fmt(s.serverCpuMax)} / ${fmt(s.serverRssMaxMb!)}`,
      'client lag ms': fmt(s.clientLagMaxMs),
      result: pass ? 'pass' : 'FAIL',
    }
  })
  console.table(rows)
  console.log(
    `Targets: post p95 ≤ ${TARGETS.postP95Ms}ms, seen-by-all p95 ≤ ${TARGETS.fanoutP95Ms}ms, ≥ ${TARGETS.deliveryPct}% delivered, ≤ ${TARGETS.errorPct}% errors, no socket drops.`,
  )
  console.log('A client lag over ~200ms means this machine, not the server, is inflating latencies.')
  if (OUT) await Bun.write(OUT, JSON.stringify({ base: BASE, rate: RATE, durationS: DURATION_S, stages: results, rows }, null, 2))
  process.exit(rows.every((r) => r.result === 'pass') ? 0 : 1)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(2)
})
