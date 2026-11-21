// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-488 — one remote workspace, three places to stand, and a socket that
 * hears it happen.
 *
 * A **remote workspace** is one hosted on a paired computer (SHO-285,
 * `Workspace.hostInstanceId`) and opened from the cloud through the proxy
 * connection. It must behave exactly like a cloud workspace and a local one, so
 * every scenario in this directory runs three times:
 *
 *   cloud    a workspace on cloud compute, used through the cloud API
 *   desktop  the paired computer's own local API (the machine's workspace)
 *   hosted   that same machine workspace, opened through the cloud API
 *
 * The peer of `hosted` is the desktop, so a scenario that can run in both
 * directions (cloud → desktop, desktop → cloud) does.
 *
 * The other half of the point: the existing parity suite only ever polls a GET
 * until the data shows up, which is exactly what a refresh does — so a bug that
 * needs a refresh passes it. Here nothing polls: `Live` opens the workspace's
 * realtime socket *before* the action and asserts the event arrives inside a
 * time budget, with no GET in between. `expectLive` then checks the stored
 * state once, at the end.
 *
 * Real processes on both sides (`entry.ts` on Postgres + Redis for the cloud,
 * `entry.ts` in local mode on its own SQLite file for the desktop, paired
 * through `cli/login`); the only stand-in is the model (FakeLlmServer), so no
 * paid provider is called.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HttpClient } from '@shogo-ai/sdk'
import { FakeLlmServer } from '../../../../desktop/e2e/streaming/fake-llm-server'
import {
  CLOUD_AUTH_SECRET,
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
} from '../helpers/machine-vm-harness'
import { seedWorkspace, type Seeded } from '../helpers/machine-vm-surfaces'
import { fakeS3Env, startFakeS3 } from '../helpers/fake-s3'

export { marker, token } from '../../../../desktop/e2e/streaming/fake-llm-server'
export { waitFor, type CloudProcess, type PairedMachine }

/** Every scenario's default budget for an event to arrive with no refetch. */
export const LIVE_BUDGET_MS = 5_000

/**
 * What a timed-out live wait appends to its error: the desktop's sync status
 * (SHO-502). A desktop-written event reaches the cloud through the pusher, and
 * one failed push backs it off past the budget — without this the failure
 * reads as "slow" when the cause is a refused push.
 */
let liveDiagnostics: (() => Promise<string>) | null = null

/** The three places a workspace is used from. */
export const TARGET_NAMES = ['cloud', 'desktop', 'hosted'] as const
export type TargetName = (typeof TARGET_NAMES)[number]

/**
 * The targets that can run an agent turn in this harness.
 *
 * A turn's model is the scripted `FakeLlmServer`. The desktop and the workspace
 * it hosts reach it through `AI_MODE=local-llm` on their own process; a cloud
 * workspace cannot, because the cloud AI proxy only routes to a local model when
 * `SHOGO_LOCAL_MODE=true` (`ai-proxy.ts` `isLocalDev`) or through a model
 * registered in the catalogue with a custom base URL, and a cloud process must
 * be neither. Running a cloud turn would therefore call a real provider — which
 * this suite must never do — so the turn-driven scenarios run on the two targets
 * that can, and every scenario that does not need a model runs on all three.
 */
export const TURN_TARGETS = TARGET_NAMES.filter((name) => name !== 'cloud')

/** One API to talk to: where it answers, and the session that acts there. */
export interface Side {
  base: string
  cookie: string
  workspaceId: string
}

export interface Target extends Side {
  name: TargetName
  /** Where the client acts, and where its realtime socket is read from. */
  api: HttpClient
  seed: Seeded
  /**
   * The other side of the same workspace. Only a `hosted` target has one (the
   * desktop that computes it); it is what the "both directions" half runs on.
   */
  peer?: { api: HttpClient; base: string; cookie: string; workspaceId: string; kind: 'desktop' }
}

export interface RemoteWorkspace {
  cloud: CloudProcess
  machine: PairedMachine
  llm: FakeLlmServer
  cloudUserId: string
  localUserId: string
  seeds: { cloud: Seeded; machine: Seeded }
  target: (name: TargetName) => Target
  targets: Target[]
  logs: () => string
  stop: () => Promise<void>
}

/**
 * Read a path from one API, uncached.
 *
 * Deliberately plain `fetch`, not `HttpClient.get`: the SDK client de-dupes GETs
 * within a session, so a second read of a path returns the first answer — which
 * would make a read-after-write check pass on stale data (it cost a debugging
 * round on this suite).
 */
export async function read(
  side: Side,
  path: string,
): Promise<{ status: number; data: any; error?: string }> {
  try {
    const res = await fetch(`${side.base}${path}`, {
      headers: { cookie: side.cookie, origin: side.base, accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
    })
    const text = await res.text()
    let data: any = null
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      data = text
    }
    return { status: res.status, data }
  } catch (err: any) {
    return { status: 0, data: null, error: err?.message ?? String(err) }
  }
}
export async function send(
  client: HttpClient,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: any }> {
  try {
    const res: any = await client.request(path, { method, body: body as any })
    return { status: (res.status ?? 200) as number, data: res.data }
  } catch (err: any) {
    return { status: (err?.status ?? 0) as number, data: err?.details ?? err?.message ?? null }
  }
}

/**
 * The desktop's own view of its machine copy (SHO-301): whether the pusher and
 * the puller are moving, and if not why. A stalled sync used to leave no trace,
 * so every wait in this directory reports it when it times out.
 */
export async function syncStatus(machine: PairedMachine): Promise<string> {
  try {
    const res = await read(
      { base: machine.localApiBase, cookie: machine.localCookies, workspaceId: machine.machineWorkspaceId },
      '/api/local/instance-info',
    )
    return JSON.stringify(res.data?.sync ?? `no sync status (HTTP ${res.status})`, null, 2)
  } catch (err) {
    return `unavailable: ${(err as Error)?.message ?? err}`
  }
}

/**
 * Open the desktop's tunnel the way the Studio does when a person opens the
 * workspace (`POST /instances/:id/request-connect`, then the desktop's own
 * heartbeat picks the request up). Without it a hosted send is queued as
 * `host_offline` by design.
 */
export async function warmHostTunnel(cloud: CloudProcess, machine: PairedMachine): Promise<void> {
  const client = httpClient(cloud.base, machine.cookies)
  const side = { base: cloud.base, cookie: machine.cookies, workspaceId: machine.machineWorkspaceId }
  const path = `/api/instances/${encodeURIComponent(machine.machineId)}`
  await send(client, 'POST', `${path}/request-connect`)
  await waitFor(
    'the desktop compute tunnel',
    async () => {
      const res = await read(side, path)
      return res.status < 300 && res.data?.status === 'online'
    },
    120_000,
    2_000,
  )
}

/** Boot the whole stack and seed both workspaces, once per test file. */
export async function startRemoteWorkspace(): Promise<RemoteWorkspace> {
  // Both processes sign and verify with the same secret: a `share_file` link is
  // minted on one side and served on the other (SHO-488, group 6).
  process.env.BETTER_AUTH_SECRET = CLOUD_AUTH_SECRET
  const redisUrl = process.env.TEST_REDIS_URL || process.env.REDIS_URL!
  // The cloud stores channel attachments in the artifact bucket, and CI has no
  // bucket: without one every upload from the cloud answers 500 before its row
  // exists (SHO-494). A real S3 server in-process means the API runs the
  // production path — signing, presigned reads, ranges — with nothing mocked.
  const s3 = startFakeS3()
  Object.assign(process.env, fakeS3Env(s3))
  const llm = new FakeLlmServer()
  await llm.start(0)
  const cloud = await startCloud({
    pgServerUrl: process.env.CHANNELS_TEST_PG_URL!,
    redisUrl,
  })
  const machine = await pairMachine(cloud.base, {
    instanceName: `vm-${Math.random().toString(36).slice(2, 6)}`,
    repoRoot: REPO_ROOT,
    dir: mkdtempSync(join(tmpdir(), 'sho488-desktop-')),
    // The turn runs on the desktop; its model is the scripted one, called from
    // the desktop itself rather than forwarded to the cloud's gateway.
    env: {
      AI_MODE: 'local-llm',
      LOCAL_LLM_BASE_URL: llm.url,
      LOCAL_LLM_BASIC_MODEL: 'fake-stream',
      LOCAL_LLM_ADVANCED_MODEL: 'fake-stream',
      BETTER_AUTH_SECRET: CLOUD_AUTH_SECRET,
    },
  }).catch(async (err) => {
    console.log(cloud.log.join('').slice(-4000))
    await cloud.stop()
    throw err
  })

  const logs = () =>
    `--- cloud ---\n${cloud.log.join('').slice(-3000)}\n--- desktop ---\n${machine.log.join('').slice(-3000)}`
  const stop = async () => {
    liveDiagnostics = null
    await machine.stop().catch(() => {})
    await cloud.stop().catch(() => {})
    await llm.stop().catch(() => {})
    s3.stop()
    await clearChatSlots(redisUrl, [machine.cloudWorkspaceId, machine.machineWorkspaceId])
  }

  const cloudUserId = await sessionUserId(cloud.base, machine.cookies)
  const localUserId = await sessionUserId(machine.localApiBase, machine.localCookies)
  const cloudApi = httpClient(cloud.base, machine.cookies)
  const desktopApi = httpClient(machine.localApiBase, machine.localCookies)

  // The account's personal workspace is the cloud baseline. Team chat is off on
  // a personal workspace by default, and the scenario seeds a channel into it,
  // so turn it on: the workspace is the subject, not the chat default.
  const chatOn = await send(cloudApi, 'PATCH', `/api/workspaces/${encodeURIComponent(machine.cloudWorkspaceId)}/chat-mode`, {
    mode: 'native',
  })
  if (chatOn.status >= 300) {
    await stop()
    throw new Error(`could not enable team chat on the cloud workspace (${chatOn.status}): ${JSON.stringify(chatOn.data)}`)
  }

  const seeds = {
    cloud: await seedWorkspace(cloudApi, machine.cloudWorkspaceId, 'Cloudy'),
    machine: await seedWorkspace(desktopApi, machine.machineWorkspaceId, 'Machy'),
  }
  await warmHostTunnel(cloud, machine)
  liveDiagnostics = () => syncStatus(machine)

  const targets: Target[] = [
    {
      name: 'cloud',
      api: cloudApi,
      base: cloud.base,
      cookie: machine.cookies,
      workspaceId: machine.cloudWorkspaceId,
      seed: seeds.cloud,
    },
    {
      name: 'desktop',
      api: desktopApi,
      base: machine.localApiBase,
      cookie: machine.localCookies,
      workspaceId: machine.machineWorkspaceId,
      seed: seeds.machine,
    },
    {
      name: 'hosted',
      api: cloudApi,
      base: cloud.base,
      cookie: machine.cookies,
      workspaceId: machine.machineWorkspaceId,
      seed: seeds.machine,
      peer: {
        api: desktopApi,
        base: machine.localApiBase,
        cookie: machine.localCookies,
        workspaceId: machine.machineWorkspaceId,
        kind: 'desktop',
      },
    },
  ]
  const byName = new Map(targets.map((t) => [t.name, t]))

  return {
    cloud,
    machine,
    llm,
    cloudUserId,
    localUserId,
    seeds,
    targets,
    target: (name) => {
      const found = byName.get(name)
      if (!found) throw new Error(`no such target: ${name}`)
      return found
    },
    logs,
    stop,
  }
}

/**
 * The reply-slot holders (`chat:slots:<workspaceId>`, `agent-reply-slots.ts`)
 * outlive the processes that wrote them, so every run left keys behind in a
 * shared Redis. `redis-cli` rather than a client: the harness imports no Redis
 * library, and a missing binary simply means there was nothing to clean.
 */
async function clearChatSlots(redisUrl: string, workspaceIds: string[]): Promise<void> {
  for (const id of workspaceIds) {
    if (!id) continue
    try {
      Bun.spawnSync(['redis-cli', '-u', redisUrl, 'DEL', `chat:slots:${id}`], {
        stdout: 'ignore',
        stderr: 'ignore',
      })
    } catch {
      /* no redis-cli on this machine: nothing to clean up from here */
    }
  }
}

/**
 * Wait for the desktop's copy to catch up with a write made on the cloud (the
 * hosted workspace's rows move through machine sync, ~500 ms each way). Used
 * only to settle *setup* — never to assert that a person sees something, which
 * is what `Live` is for.
 */
export async function waitForSync<T>(
  machine: PairedMachine,
  what: string,
  fn: () => Promise<T | null | undefined | false>,
  timeoutMs = 60_000,
  intervalMs = 500,
): Promise<T> {
  try {
    return await waitFor(what, fn, timeoutMs, intervalMs)
  } catch (err) {
    throw new Error(`${(err as Error).message}\n--- desktop sync ---\n${await syncStatus(machine)}\n`)
  }
}

export interface LiveEvent {
  /** Wall-clock ms when the event reached this socket. */
  at: number
  event: any
}

/**
 * A realtime connection to one workspace, opened before the action.
 *
 * The web app holds the `/rt` WebSocket; `conversations/events` is the
 * documented SSE fallback for a client that cannot hold one. Both are fed by
 * the same `publishConversationEvent`, which is why a bug that skips the bus
 * skips both — but the WebSocket is the path a page actually uses, so it is
 * tried first and `transport` records which one answered. If the upgrade fails
 * (and the suite asserts it does not on any target) the SSE fallback keeps the
 * scenario running so the failure names what broke.
 */
export class Live {
  readonly events: LiveEvent[] = []
  transport: 'ws' | 'sse' | null = null
  /** Set when the WebSocket could not be opened, so a test can say why. */
  upgradeError: string | null = null
  private socket: any = null
  private abort: AbortController | null = null
  private closed = false

  private constructor(
    private readonly opts: {
      base: string
      cookie: string
      workspaceId: string
      label: string
      transport?: 'auto' | 'ws' | 'sse'
    },
  ) {}

  static async open(opts: {
    base: string
    cookie: string
    workspaceId: string
    label: string
    /**
     * `auto` (default) tries the WebSocket first, as a page does. `sse` is for
     * a check the WebSocket deliberately cannot answer — it drops a client's
     * own typing frame, while the read-only stream does not.
     */
    transport?: 'auto' | 'ws' | 'sse'
  }): Promise<Live> {
    const live = new Live(opts)
    await live.connect()
    return live
  }

  private get wsUrl(): string {
    return `${this.opts.base.replace(/^http/, 'ws')}/api/workspaces/${encodeURIComponent(this.opts.workspaceId)}/rt`
  }

  private get sseUrl(): string {
    return `${this.opts.base}/api/workspaces/${encodeURIComponent(this.opts.workspaceId)}/conversations/events`
  }

  private push(event: any): void {
    if (this.closed) return
    this.events.push({ at: Date.now(), event })
  }

  private async connect(): Promise<void> {
    if (this.opts.transport === 'sse') {
      await this.connectSse()
      this.transport = 'sse'
      return
    }
    const opened = await this.connectWebSocket()
    if (opened) {
      this.transport = 'ws'
      return
    }
    if (this.opts.transport === 'ws') {
      throw new Error(`${this.opts.label}: WebSocket upgrade failed (${this.upgradeError})`)
    }
    await this.connectSse()
    this.transport = 'sse'
  }

  private connectWebSocket(): Promise<boolean> {
    const WS = (globalThis as any).WebSocket
    if (!WS) {
      this.upgradeError = 'no WebSocket in this runtime'
      return Promise.resolve(false)
    }
    return new Promise<boolean>((resolve) => {
      let settled = false
      const done = (ok: boolean, why?: string) => {
        if (settled) return
        settled = true
        if (!ok) this.upgradeError = why ?? 'unknown'
        resolve(ok)
      }
      let socket: any
      try {
        socket = new WS(this.wsUrl, { headers: { cookie: this.opts.cookie, origin: this.opts.base } })
      } catch (err: any) {
        done(false, `constructor: ${err?.message ?? err}`)
        return
      }
      this.socket = socket
      socket.onopen = () => done(true)
      socket.onerror = (err: any) => done(false, `error: ${err?.message ?? 'websocket error'}`)
      socket.onclose = (err: any) => done(false, `closed before open: ${err?.code ?? ''} ${err?.reason ?? ''}`.trim())
      socket.onmessage = (msg: any) => {
        try {
          const parsed = typeof msg.data === 'string' ? JSON.parse(msg.data) : msg.data
          // The socket answers some frames itself (`presence`, `hello`); they
          // are still workspace events, so they are kept.
          this.push(parsed)
        } catch {
          /* a non-JSON frame is not one of ours */
        }
      }
      setTimeout(() => done(false, 'the upgrade did not open within 10s'), 10_000)
    })
  }

  private async connectSse(): Promise<void> {
    this.abort = new AbortController()
    const res = await fetch(this.sseUrl, {
      headers: { cookie: this.opts.cookie, origin: this.opts.base, accept: 'text/event-stream' },
      signal: this.abort.signal,
    })
    if (!res.ok || !res.body) {
      throw new Error(`${this.opts.label}: SSE fallback refused (${res.status})`)
    }
    void (async () => {
      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          let split: number
          while ((split = buffer.indexOf('\n\n')) >= 0) {
            const chunk = buffer.slice(0, split)
            buffer = buffer.slice(split + 2)
            for (const line of chunk.split('\n')) {
              if (!line.startsWith('data:')) continue
              const payload = line.slice(5).trim()
              if (!payload) continue
              try {
                this.push(JSON.parse(payload))
              } catch {
                /* not ours */
              }
            }
          }
        }
      } catch {
        /* closed */
      }
    })()
    // The stream sends `ready` first; wait for it so a scenario cannot act
    // before the subscription exists (that would be the race this suite is
    // supposed to catch, in the wrong direction).
    await waitFor(`${this.opts.label}: SSE ready`, async () =>
      this.events.some((e) => e.event?.type === 'ready') || null, 10_000, 50)
  }

  /** Send a client frame (typing, presence) — WebSocket only, as a page does. */
  send(frame: Record<string, unknown>): void {
    if (!this.socket || this.transport !== 'ws') throw new Error(`${this.opts.label}: no WebSocket to send on`)
    this.socket.send(JSON.stringify(frame))
  }

  /** Events received after `at` (and after this call, when given). */
  since(at: number): LiveEvent[] {
    return this.events.filter((e) => e.at > at)
  }

  /**
   * Wait for the first event matching `match`, inside `timeoutMs`. No GET is
   * made while waiting: this is the whole difference from the polling suites.
   */
  async waitForEvent(
    match: (event: any) => boolean,
    opts: { label: string; timeoutMs?: number; since?: number },
  ): Promise<LiveEvent> {
    const timeoutMs = opts.timeoutMs ?? LIVE_BUDGET_MS
    const since = opts.since ?? 0
    const started = Date.now()
    const deadline = started + timeoutMs
    let scanned = 0
    while (Date.now() < deadline) {
      const candidates = this.events.filter((e) => e.at > since)
      for (; scanned < candidates.length; scanned++) {
        if (match(candidates[scanned].event)) return candidates[scanned]
      }
      // `started` keeps a quiet socket from looking like a busy one in the
      // failure message.
      await new Promise((r) => setTimeout(r, 25))
    }
    const seen = this.events
      .filter((e) => e.at > since)
      .map((e) => String(e.event?.type ?? '?'))
    const recent = this.events
      .filter((e) => e.at > since)
      .slice(-6)
      .map((e) => JSON.stringify(e.event).slice(0, 240))
    const sync = liveDiagnostics ? await liveDiagnostics().catch((err) => `unavailable: ${err?.message ?? err}`) : null
    throw new Error(
      `${this.opts.label}: no ${opts.label} on the ${this.transport} socket within ${timeoutMs}ms` +
        (this.upgradeError ? ` (ws upgrade failed: ${this.upgradeError})` : '') +
        `\n  events seen: ${seen.length ? [...new Set(seen)].join(', ') : '(none)'}` +
        (recent.length ? `\n  last payloads: ${recent.join('\n    ')}` : '') +
        (sync ? `\n  desktop sync: ${sync}` : ''),
    )
  }

  /** A timestamp to pass as `since`, taken just before the action. */
  mark(): number {
    return Date.now()
  }

  close(): void {
    this.closed = true
    try {
      this.socket?.close?.()
    } catch {
      /* already gone */
    }
    try {
      this.abort?.abort()
    } catch {
      /* already gone */
    }
  }
}

/** Open live sockets on a target and (when it has one) on the other side. */
export async function openLive(target: Target): Promise<{ live: Live; peer?: Live }> {
  const live = await Live.open({
    base: target.base,
    cookie: target.cookie,
    workspaceId: target.workspaceId,
    label: `${target.name} socket`,
  })
  const peer = target.peer
    ? await Live.open({
        base: target.peer.base,
        cookie: target.peer.cookie,
        workspaceId: target.peer.workspaceId,
        label: `${target.name} peer socket`,
      })
    : undefined
  return { live, peer }
}

/**
 * The WebSocket a page holds (fails if it cannot be opened), for a scenario that
 * has to send a client frame as well as read.
 */
export async function openSocket(target: Target): Promise<Live> {
  return Live.open({
    base: target.base,
    cookie: target.cookie,
    workspaceId: target.workspaceId,
    label: `${target.name} socket`,
    transport: 'ws',
  })
}

/**
 * The read-only stream, for the one check the WebSocket deliberately cannot
 * answer: it drops a client's own `typing` frame, and the SSE fallback does not.
 */
export async function openStream(target: Target): Promise<Live> {
  return Live.open({
    base: target.base,
    cookie: target.cookie,
    workspaceId: target.workspaceId,
    label: `${target.name} stream`,
    transport: 'sse',
  })
}

/**
 * A message text unique to this run and to what it is: every assertion matches
 * on it, so an unrelated row can never satisfy a test.
 */
let seq = 0
export function uniq(what: string): string {
  seq += 1
  return `${what} ${Date.now().toString(36)}-${seq}`
}

/**
 * Ask an agent to act in a channel, the way a person does: a friendly `@Name`
 * mention of the project agent, resolved at the insert point.
 */
export function agentMention(seed: Seeded, text: string): string {
  return `@${seed.projectNames[0]} ${text}`
}

export async function channelMessages(target: Side, channelId: string): Promise<any[]> {
  const res = await read(target, `/api/conversations/${encodeURIComponent(channelId)}/messages?limit=100`)
  return res.data?.messages ?? []
}

/** A cloud account that owns nothing, for the access checks. */
export async function strangerSession(cloud: CloudProcess): Promise<{ cookie: string; api: HttpClient }> {
  const stranger = await signUp(cloud.base, 'stranger')
  return { cookie: stranger.cookie, api: httpClient(cloud.base, stranger.cookie) }
}
