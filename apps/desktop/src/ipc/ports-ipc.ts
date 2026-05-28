// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Main-process IPC for the Ports tab.
 *
 * Polls `lsof -iTCP -sTCP:LISTEN -P -n` every POLL_INTERVAL_MS, parses the
 * output into PortEntry[], and pushes the list to every subscribed renderer
 * over the `shogo:ports:list` channel.
 *
 * Polling only runs while at least one renderer is subscribed — we don't
 * want to wake `lsof` every 3s for an idle Ports tab nobody is looking at.
 *
 * `lsof` is macOS/Linux only. On Windows we'd swap to `netstat -ano` or
 * `Get-NetTCPConnection`; for now we report ENOENT cleanly and the renderer
 * shows an "unsupported on this platform" empty state.
 *
 * Cleanup actions:
 *   - kill(pid):  SIGTERM, then SIGKILL after 1s if still alive.
 *   - open(port): shell.openExternal('http://localhost:<port>')
 *   - cmdline(pid): `ps -p <pid> -o command=` → string for clipboard.
 */

import { ipcMain, shell, BrowserWindow, type WebContents } from 'electron'
import { spawn } from 'node:child_process'
import { parseLsof, diffNewPorts, type PortEntry } from './lsof-parser'

const CH = {
  subscribe:   'shogo:ports:subscribe',
  unsubscribe: 'shogo:ports:unsubscribe',
  open:        'shogo:ports:open',
  kill:        'shogo:ports:kill',
  cmdline:     'shogo:ports:cmdline',
  list:        'shogo:ports:list',         // push (main → renderer)
  unsupported: 'shogo:ports:unsupported',  // push (main → renderer)
} as const

/** Poll cadence (ms). Spec says "every 3s". */
const POLL_INTERVAL_MS = 3000
/** How long after SIGTERM before we escalate to SIGKILL. */
const KILL_ESCALATION_MS = 1000
/** lsof has up to this long to respond before we treat the scan as failed. */
const LSOF_TIMEOUT_MS = 5000

interface Subscriber {
  wc: WebContents
  /** Last list this subscriber received — used so on first push they get the full list, not a diff. */
  lastSent: PortEntry[]
}

let registered = false
let subscribers = new Set<Subscriber>()
let pollTimer: NodeJS.Timeout | null = null
let lastScan: PortEntry[] = []
let unsupportedReported = false

/**
 * Run `lsof -iTCP -sTCP:LISTEN -P -n` and return parsed rows.
 *
 * Resolves to null when lsof isn't available on this platform (Windows, or a
 * locked-down Linux without lsof installed) — the caller then notifies the
 * renderer to show the "unsupported" empty state, and we stop polling.
 */
async function scanPorts(): Promise<PortEntry[] | null> {
  return new Promise((resolve) => {
    let resolved = false
    const finish = (val: PortEntry[] | null): void => {
      if (resolved) return
      resolved = true
      clearTimeout(timeout)
      resolve(val)
    }

    let proc: ReturnType<typeof spawn>
    try {
      proc = spawn('lsof', ['-iTCP', '-sTCP:LISTEN', '-P', '-n'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch {
      finish(null)
      return
    }

    let stdout = ''
    proc.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    proc.stderr?.on('data', () => { /* swallow — lsof writes harmless warnings here */ })

    proc.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        finish(null)
      } else {
        finish([])
      }
    })

    proc.on('close', (code) => {
      // lsof exits 1 when it finds nothing, that's not an error.
      if (code === 0 || code === 1) {
        finish(parseLsof(stdout))
      } else {
        finish([])
      }
    })

    const timeout = setTimeout(() => {
      try { proc.kill('SIGKILL') } catch { /* swallow */ }
      finish([])
    }, LSOF_TIMEOUT_MS)
  })
}

async function pollOnce(): Promise<void> {
  if (subscribers.size === 0) return     // raced with last unsubscribe
  const next = await scanPorts()

  if (next === null) {
    if (!unsupportedReported) {
      unsupportedReported = true
      for (const sub of subscribers) {
        if (!sub.wc.isDestroyed()) sub.wc.send(CH.unsupported)
      }
    }
    stopPolling()
    return
  }

  const newPorts = diffNewPorts(lastScan, next)
  lastScan = next

  // Push to subscribers. Each subscriber tracks its own lastSent so we can
  // mark "new" rows per-subscriber (a fresh subscriber sees zero "new" rows
  // even if the global scan saw some).
  const newKeys = new Set(newPorts.map((p) => `${p.port}:${p.pid}`))
  for (const sub of subscribers) {
    if (sub.wc.isDestroyed()) continue
    const isFirstSend = sub.lastSent.length === 0
    const subNewKeys = isFirstSend ? [] : [...newKeys]
    sub.wc.send(CH.list, { ports: next, newKeys: subNewKeys })
    sub.lastSent = next
  }
}

function startPolling(): void {
  if (pollTimer) return
  // Fire once immediately so a fresh subscriber doesn't wait 3s for first data.
  void pollOnce()
  pollTimer = setInterval(() => { void pollOnce() }, POLL_INTERVAL_MS)
  // Don't keep the event loop alive for polling.
  if (typeof pollTimer.unref === 'function') pollTimer.unref()
}

function stopPolling(): void {
  if (!pollTimer) return
  clearInterval(pollTimer)
  pollTimer = null
}

function addSubscriber(wc: WebContents): void {
  for (const sub of subscribers) {
    if (sub.wc === wc) return  // already subscribed
  }
  const sub: Subscriber = { wc, lastSent: [] }
  subscribers.add(sub)

  wc.once('destroyed', () => {
    subscribers.delete(sub)
    if (subscribers.size === 0) stopPolling()
  })

  if (unsupportedReported) {
    // We already learned lsof isn't here; tell this subscriber too.
    wc.send(CH.unsupported)
    return
  }
  startPolling()
}

function removeSubscriber(wc: WebContents): void {
  for (const sub of [...subscribers]) {
    if (sub.wc === wc) subscribers.delete(sub)
  }
  if (subscribers.size === 0) stopPolling()
}

async function killProcess(pid: number): Promise<{ ok: boolean; error?: string }> {
  if (!Number.isInteger(pid) || pid <= 1) {
    return { ok: false, error: 'invalid pid' }
  }
  try {
    process.kill(pid, 'SIGTERM')
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code === 'ESRCH') return { ok: true }   // already dead — fine
    return { ok: false, error: e.message }
  }
  // Give it 1s, then SIGKILL if still alive.
  await new Promise((r) => setTimeout(r, KILL_ESCALATION_MS))
  try {
    process.kill(pid, 0)  // probe — throws ESRCH if dead
    try { process.kill(pid, 'SIGKILL') } catch { /* swallow */ }
  } catch {
    // ESRCH — process is gone, which is what we wanted.
  }
  // Trigger an immediate rescan so the row disappears without waiting 3s.
  void pollOnce()
  return { ok: true }
}

async function getCommandLine(pid: number): Promise<{ ok: boolean; commandLine?: string; error?: string }> {
  if (!Number.isInteger(pid) || pid <= 1) {
    return { ok: false, error: 'invalid pid' }
  }
  return new Promise((resolve) => {
    let proc: ReturnType<typeof spawn>
    try {
      proc = spawn('ps', ['-p', String(pid), '-o', 'command='], { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      resolve({ ok: false, error: (err as Error).message })
      return
    }
    let out = ''
    proc.stdout?.on('data', (c: Buffer) => { out += c.toString('utf8') })
    proc.on('error', (err) => { resolve({ ok: false, error: err.message }) })
    proc.on('close', () => {
      const line = out.trim()
      if (!line) resolve({ ok: false, error: 'process not found' })
      else resolve({ ok: true, commandLine: line })
    })
  })
}

export function registerPortsIpcHandlers(): void {
  if (registered) return
  registered = true

  ipcMain.handle(CH.subscribe, (event) => {
    addSubscriber(event.sender)
    return { ok: true }
  })

  ipcMain.handle(CH.unsubscribe, (event) => {
    removeSubscriber(event.sender)
    return { ok: true }
  })

  ipcMain.handle(CH.open, async (_event, port: number) => {
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      return { ok: false, error: 'invalid port' }
    }
    try {
      await shell.openExternal(`http://localhost:${port}`)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle(CH.kill, async (_event, pid: number) => killProcess(pid))

  ipcMain.handle(CH.cmdline, async (_event, pid: number) => getCommandLine(pid))
}

export function disposePortsIpcHandlers(): void {
  if (!registered) return
  registered = false
  ipcMain.removeHandler(CH.subscribe)
  ipcMain.removeHandler(CH.unsubscribe)
  ipcMain.removeHandler(CH.open)
  ipcMain.removeHandler(CH.kill)
  ipcMain.removeHandler(CH.cmdline)
  stopPolling()
  subscribers = new Set()
  lastScan = []
  unsupportedReported = false
}

export const PORTS_IPC_CHANNELS = CH

// ─── test-only helpers ─────────────────────────────────────────────────
// Exposed for unit tests; not part of the public surface.
export const __test = {
  get subscriberCount() { return subscribers.size },
  get pollingActive() { return pollTimer !== null },
  reset(): void {
    stopPolling()
    subscribers = new Set()
    lastScan = []
    unsupportedReported = false
    registered = false
  },
  forcePoll: pollOnce,
  // Lets tests pretend lsof said something specific without spawning.
  pushScanResultForTest(result: PortEntry[] | null): void {
    if (result === null) {
      unsupportedReported = true
      for (const sub of subscribers) {
        if (!sub.wc.isDestroyed()) sub.wc.send(CH.unsupported)
      }
      stopPolling()
      return
    }
    const newPorts = diffNewPorts(lastScan, result)
    lastScan = result
    const newKeys = new Set(newPorts.map((p) => `${p.port}:${p.pid}`))
    for (const sub of subscribers) {
      if (sub.wc.isDestroyed()) continue
      const isFirstSend = sub.lastSent.length === 0
      const subNewKeys = isFirstSend ? [] : [...newKeys]
      sub.wc.send(CH.list, { ports: result, newKeys: subNewKeys })
      sub.lastSent = result
    }
  },
}

// Suppress an unused-warning when not in test.
void BrowserWindow
