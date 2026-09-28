// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Browser Pool
 *
 * Process-wide shared headless Chromium for the `browser` tool's locally
 * launched path. Every tool instance (main agent, each subagent) gets its own
 * BrowserContext — isolated cookies/storage — on top of ONE Chromium process,
 * with a cap on concurrently open contexts. Small VMs (2 vCPU / 4 GB, no swap)
 * OOM when several agents each launch their own Chromium.
 *
 * Extension / CDP-relay mode does not go through this pool.
 *
 * Also hosts:
 *  - a per-session cleanup registry so session disposal can release browser
 *    slots held by that session's tool instances;
 *  - a Linux-only orphan Chromium reaper.
 */

import { readdirSync, readFileSync, writeFileSync } from 'fs'

export interface PoolPage {
  close(): Promise<void>
}

export interface PoolContext {
  newPage(): Promise<any>
  close(): Promise<void>
}

export interface PoolBrowser {
  newContext(): Promise<PoolContext>
  close(): Promise<void>
  isConnected(): boolean
  on(event: 'disconnected', listener: () => void): unknown
}

export interface LaunchedBrowser {
  browser: PoolBrowser
  /** OS pid of the browser process, when it could be determined. */
  pid?: number | null
}

export interface BrowserLease {
  context: PoolContext
  /** Closes the context and frees the slot. Idempotent. */
  release(): Promise<void>
}

export interface BrowserPoolOptions {
  launch: () => Promise<LaunchedBrowser>
  maxContexts?: number
  idleCloseMs?: number
  acquireTimeoutMs?: number
}

export const DEFAULT_MAX_CONTEXTS = 2
export const DEFAULT_IDLE_CLOSE_MS = 5 * 60 * 1000
export const DEFAULT_ACQUIRE_TIMEOUT_MS = 60 * 1000

export class BrowserPoolTimeoutError extends Error {
  constructor(maxContexts: number, waitedMs: number) {
    super(
      `Browser busy: ${maxContexts} browser session(s) already open (limit ${maxContexts}); ` +
      `waited ${Math.round(waitedMs / 1000)}s for one to free up. ` +
      'Close a browser you no longer need (browser action "close") or retry later.',
    )
    this.name = 'BrowserPoolTimeoutError'
  }
}

interface Waiter {
  resolve: () => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

interface LeaseState {
  context: PoolContext
  done: boolean
}

export class BrowserPool {
  readonly maxContexts: number
  readonly idleCloseMs: number
  readonly acquireTimeoutMs: number

  private readonly launchFn: () => Promise<LaunchedBrowser>
  private browser: PoolBrowser | null = null
  private pid: number | null = null
  private launching: Promise<PoolBrowser> | null = null
  /** Slots in use: live leases plus acquires that are still opening a context. */
  private active = 0
  private leases = new Set<LeaseState>()
  private waiters: Waiter[] = []
  private idleTimer: ReturnType<typeof setTimeout> | null = null

  constructor(opts: BrowserPoolOptions) {
    this.launchFn = opts.launch
    this.maxContexts = Math.max(1, opts.maxContexts ?? DEFAULT_MAX_CONTEXTS)
    this.idleCloseMs = Math.max(0, opts.idleCloseMs ?? DEFAULT_IDLE_CLOSE_MS)
    this.acquireTimeoutMs = Math.max(0, opts.acquireTimeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS)
  }

  get activeCount(): number { return this.active }
  get queuedCount(): number { return this.waiters.length }
  get hasBrowser(): boolean { return this.browser !== null }
  get isLaunching(): boolean { return this.launching !== null }
  get browserPid(): number | null { return this.pid }

  async acquire(): Promise<BrowserLease> {
    this.clearIdleTimer()
    if (this.active < this.maxContexts) {
      this.active++
    } else {
      await this.waitForSlot()
    }
    try {
      const browser = await this.getBrowser()
      const context = await browser.newContext()
      const state: LeaseState = { context, done: false }
      this.leases.add(state)
      return {
        context,
        release: () => this.releaseLease(state),
      }
    } catch (err) {
      this.freeSlot()
      throw err
    }
  }

  /** Close the shared browser and fail any queued acquirers. */
  async shutdown(): Promise<void> {
    for (const w of this.waiters.splice(0)) {
      clearTimeout(w.timer)
      w.reject(new Error('Browser pool shut down'))
    }
    for (const l of this.leases) l.done = true
    this.leases.clear()
    this.active = 0
    this.clearIdleTimer()
    await this.closeBrowser()
  }

  private waitForSlot(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const idx = this.waiters.indexOf(waiter)
          if (idx >= 0) this.waiters.splice(idx, 1)
          reject(new BrowserPoolTimeoutError(this.maxContexts, this.acquireTimeoutMs))
        }, this.acquireTimeoutMs),
      }
      unrefTimer(waiter.timer)
      this.waiters.push(waiter)
    })
  }

  private async getBrowser(): Promise<PoolBrowser> {
    if (this.browser && !this.browser.isConnected()) this.handleDisconnect(this.browser)
    if (this.browser) return this.browser
    if (!this.launching) {
      this.launching = (async () => {
        try {
          const { browser, pid } = await this.launchFn()
          this.browser = browser
          this.pid = pid ?? null
          browser.on('disconnected', () => this.handleDisconnect(browser))
          return browser
        } finally {
          this.launching = null
        }
      })()
    }
    return this.launching
  }

  private async releaseLease(state: LeaseState): Promise<void> {
    const wasLive = !state.done && this.leases.delete(state)
    state.done = true
    try { await state.context.close() } catch {}
    if (wasLive) this.freeSlot()
  }

  /** Hand the slot to the next waiter (FIFO) or give it back. */
  private freeSlot(): void {
    const next = this.waiters.shift()
    if (next) {
      clearTimeout(next.timer)
      next.resolve()
      return
    }
    this.active = Math.max(0, this.active - 1)
    if (this.active === 0) this.scheduleIdleClose()
  }

  private handleDisconnect(browser: PoolBrowser): void {
    if (this.browser !== browser) return
    this.browser = null
    this.pid = null
    // Contexts on a dead browser are gone; their slots are freed now so the
    // next acquire relaunches instead of waiting on tools that may never call
    // release. Late release() calls on those leases are no-ops for the count.
    for (const l of this.leases) l.done = true
    this.active = Math.max(0, this.active - this.leases.size)
    this.leases.clear()
    while (this.active < this.maxContexts && this.waiters.length > 0) {
      const next = this.waiters.shift()!
      clearTimeout(next.timer)
      this.active++
      next.resolve()
    }
  }

  private scheduleIdleClose(): void {
    this.clearIdleTimer()
    if (!this.browser) return
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      if (this.active === 0) void this.closeBrowser()
    }, this.idleCloseMs)
    unrefTimer(this.idleTimer)
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }

  private async closeBrowser(): Promise<void> {
    const b = this.browser
    this.browser = null
    this.pid = null
    if (b) {
      try { await b.close() } catch {}
    }
  }
}

function unrefTimer(t: ReturnType<typeof setTimeout>): void {
  ;(t as any)?.unref?.()
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const n = parseInt(raw, 10)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

// ---------------------------------------------------------------------------
// Local Chromium launcher
// ---------------------------------------------------------------------------

export function localChromiumArgs(env: NodeJS.ProcessEnv = process.env): string[] {
  const args: string[] = []
  if (env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || env.CONTAINER) {
    args.push('--no-sandbox', '--disable-setuid-sandbox')
  }
  args.push('--disable-dev-shm-usage', '--disable-gpu', '--renderer-process-limit=2')
  return args
}

export async function launchLocalChromium(): Promise<LaunchedBrowser> {
  const pw = await import('playwright-core')
  const isLinux = process.platform === 'linux'
  const childrenBefore = isLinux ? chromiumChildPids(safeReadProc(), process.pid) : new Set<number>()

  // Bun's stdio pipe transport (FDs 3/4) doesn't deliver CDP frames
  // reliably, so Playwright's default `--remote-debugging-pipe` flow
  // hangs (chromium launches and prints "DevTools listening on ws://"
  // but Browser.getVersion on the pipe never returns). Setting
  // `cdpPort: 0` switches Playwright to its WebSocketTransport, which
  // works correctly under bun once the patch in
  // scripts/patch-playwright-bun.ts has been applied to playwright-core.
  // `cdpPort` is on the internal launch options — not in the public
  // .d.ts — but is accepted via the protocol validator.
  const isBun = typeof (globalThis as any).Bun !== 'undefined'
  const launchOpts: any = {
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    args: localChromiumArgs(),
  }
  if (isBun) launchOpts.cdpPort = 0
  const browser = await pw.chromium.launch(launchOpts)

  // The public Browser API doesn't expose the process; Playwright spawns it
  // as a direct child of this process, so diff our chromium children.
  let pid: number | null = (browser as any).process?.()?.pid ?? null
  if (!pid && isLinux) {
    const fresh = [...chromiumChildPids(safeReadProc(), process.pid)].filter(p => !childrenBefore.has(p))
    if (fresh.length === 1) pid = fresh[0]
  }
  if (pid && isLinux) {
    // Make Chromium (and the renderers it forks, which inherit this) the
    // kernel OOM killer's first choice instead of the agent runtime.
    try { writeFileSync(`/proc/${pid}/oom_score_adj`, '1000') } catch {}
  }
  return { browser: browser as unknown as PoolBrowser, pid }
}

let sharedPool: BrowserPool | null = null

export function getSharedBrowserPool(): BrowserPool {
  if (!sharedPool) {
    sharedPool = new BrowserPool({
      launch: launchLocalChromium,
      maxContexts: Math.max(1, envInt('SHOGO_BROWSER_MAX_CONTEXTS', DEFAULT_MAX_CONTEXTS)),
      idleCloseMs: envInt('SHOGO_BROWSER_IDLE_MS', DEFAULT_IDLE_CLOSE_MS),
      acquireTimeoutMs: envInt('SHOGO_BROWSER_ACQUIRE_TIMEOUT_MS', DEFAULT_ACQUIRE_TIMEOUT_MS),
    })
  }
  return sharedPool
}

/** Close the shared browser and drop the pool; the next use builds a fresh one. */
export async function resetSharedBrowserPool(): Promise<void> {
  const pool = sharedPool
  sharedPool = null
  if (pool) await pool.shutdown()
}

// ---------------------------------------------------------------------------
// Per-session cleanup registry
// ---------------------------------------------------------------------------

type CleanupFn = () => Promise<void> | void

const sessionCleanups = new Map<string, Set<CleanupFn>>()

/** Register a browser cleanup for a session. Returns an unregister function. */
export function registerBrowserSessionCleanup(sessionId: string, fn: CleanupFn): () => void {
  let set = sessionCleanups.get(sessionId)
  if (!set) {
    set = new Set()
    sessionCleanups.set(sessionId, set)
  }
  set.add(fn)
  return () => {
    const s = sessionCleanups.get(sessionId)
    if (!s) return
    s.delete(fn)
    if (s.size === 0) sessionCleanups.delete(sessionId)
  }
}

/** Release every browser context held by tool instances of this session. */
export async function releaseSessionBrowsers(sessionId: string): Promise<void> {
  const set = sessionCleanups.get(sessionId)
  if (!set) return
  sessionCleanups.delete(sessionId)
  await Promise.all([...set].map(async (fn) => {
    try { await fn() } catch {}
  }))
}

// ---------------------------------------------------------------------------
// Orphan Chromium reaper (Linux only)
// ---------------------------------------------------------------------------

export interface ProcEntry {
  pid: number
  ppid: number
  comm: string
}

export type ProcReader = () => ProcEntry[]

export function isChromiumComm(comm: string): boolean {
  // /proc comm is truncated to 15 chars ("chromium-browse", "chrome-headless").
  return /^(chrome|chromium|headless_shell)/i.test(comm)
}

/** Parse the `pid (comm) state ppid ...` line of /proc/<pid>/stat. */
export function parseProcStat(line: string): ProcEntry | null {
  const open = line.indexOf('(')
  const close = line.lastIndexOf(')')
  if (open < 0 || close < open) return null
  const pid = parseInt(line.slice(0, open).trim(), 10)
  const rest = line.slice(close + 1).trim().split(/\s+/)
  const ppid = parseInt(rest[1] ?? '', 10)
  if (!Number.isFinite(pid) || !Number.isFinite(ppid)) return null
  return { pid, ppid, comm: line.slice(open + 1, close) }
}

export const readProcEntries: ProcReader = () => {
  const out: ProcEntry[] = []
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue
    try {
      const entry = parseProcStat(readFileSync(`/proc/${name}/stat`, 'utf-8'))
      if (entry) out.push(entry)
    } catch {}
  }
  return out
}

function safeReadProc(): ProcEntry[] {
  try { return readProcEntries() } catch { return [] }
}

function chromiumChildPids(entries: ProcEntry[], parentPid: number): Set<number> {
  return new Set(entries.filter(e => e.ppid === parentPid && isChromiumComm(e.comm)).map(e => e.pid))
}

function descendantsOf(rootPid: number, children: Map<number, number[]>): Set<number> {
  const out = new Set<number>()
  const stack = [rootPid]
  while (stack.length > 0) {
    const pid = stack.pop()!
    if (out.has(pid)) continue
    out.add(pid)
    for (const c of children.get(pid) ?? []) stack.push(c)
  }
  return out
}

/**
 * Pick Chromium processes to kill: browser roots that are orphaned (parent is
 * init / a subreaper at pid 1) or are leaked direct children of this runtime,
 * plus all their descendants — excluding the shared browser's process tree.
 * Chromium parented by some other live process (a user's Playwright test run,
 * the extension relay) is left alone.
 */
export function selectOrphanChromiumPids(
  entries: ProcEntry[],
  opts: { selfPid: number; sharedPid: number | null },
): number[] {
  const children = new Map<number, number[]>()
  for (const e of entries) {
    const list = children.get(e.ppid)
    if (list) list.push(e.pid)
    else children.set(e.ppid, [e.pid])
  }
  const protectedPids = opts.sharedPid != null ? descendantsOf(opts.sharedPid, children) : new Set<number>()
  protectedPids.add(opts.selfPid)

  const victims = new Set<number>()
  for (const e of entries) {
    if (!isChromiumComm(e.comm) || protectedPids.has(e.pid)) continue
    if (e.ppid !== 1 && e.ppid !== opts.selfPid) continue
    for (const pid of descendantsOf(e.pid, children)) {
      if (!protectedPids.has(pid)) victims.add(pid)
    }
  }
  return [...victims].sort((a, b) => a - b)
}

export interface ReapOptions {
  readProc?: ProcReader
  kill?: (pid: number, signal: NodeJS.Signals) => void
  platform?: NodeJS.Platform
  selfPid?: number
  pool?: BrowserPool | null
}

/** Best-effort kill of orphaned Chromium processes. Returns the pids signalled. */
export function reapOrphanChromium(opts: ReapOptions = {}): number[] {
  if ((opts.platform ?? process.platform) !== 'linux') return []
  const pool = opts.pool !== undefined ? opts.pool : sharedPool
  // Mid-launch, or running with an unknown pid, the shared browser would be
  // indistinguishable from a leaked child.
  if (pool && (pool.isLaunching || (pool.hasBrowser && pool.browserPid == null))) return []
  try {
    const entries = (opts.readProc ?? readProcEntries)()
    const victims = selectOrphanChromiumPids(entries, {
      selfPid: opts.selfPid ?? process.pid,
      sharedPid: pool?.browserPid ?? null,
    })
    const kill = opts.kill ?? ((pid, sig) => process.kill(pid, sig))
    const killed: number[] = []
    for (const pid of victims) {
      try {
        kill(pid, 'SIGKILL')
        killed.push(pid)
      } catch {}
    }
    if (killed.length > 0) {
      console.warn(`[browser-pool] reaped ${killed.length} orphan Chromium process(es): ${killed.join(', ')}`)
    }
    return killed
  } catch {
    return []
  }
}
