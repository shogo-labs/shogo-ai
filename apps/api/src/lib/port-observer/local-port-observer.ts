// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * local-port-observer.ts
 *
 * OS-level observer for listening TCP sockets on the local machine,
 * with project attribution by PID cwd / argv / parent-chain.
 *
 * This is the load-bearing piece of the "Preview URL auto-pickup" fix
 * (issue: server tab doesn't auto-detect the dev server unless it was
 * launched inside Shogo's own PTY). The existing detected-urls flow in
 * packages/agent-runtime sniffs PTY stdout for "Local: http://…" lines;
 * that only covers servers started inside the runtime's terminal, and
 * is gated on `runtime.status === 'running'`. External-folder projects
 * (workingMode='external'), where the user runs `bun dev` in Cursor /
 * iTerm, get nothing — `detectedUrl` is permanently null.
 *
 * The observer plugs that gap. It is source-agnostic: any HTTP listener
 * on the local machine whose owning process can be attributed to one of
 * the project's linked folders (via `ProjectFolder.path`) is reported as
 * a detected URL. Detection is by OS state (`lsof`), not by terminal
 * bytes, so it works for servers started anywhere — Cursor's terminal,
 * an external shell, docker-compose, a desktop launcher, doesn't matter.
 *
 * Design notes
 * ─────────────
 *  - The scanner is dependency-injected so unit tests can run without
 *    `lsof` on the box. The default impl shells out to `lsof` on
 *    darwin/linux; on platforms where it isn't available, the scanner
 *    returns an empty list and the observer degrades to "no detection",
 *    which is the same baseline behaviour we have today.
 *
 *  - Scans are coalesced: callers asking simultaneously share one
 *    in-flight scan. A single scan is also throttled to once per
 *    `SCAN_THROTTLE_MS` (default 1500ms) so a busy renderer polling
 *    every second can't melt `lsof`.
 *
 *  - Project folder lookups are cached for `FOLDER_CACHE_TTL_MS` so a
 *    scan doesn't hit Prisma every 1.5s. Adding a new folder mid-session
 *    is rare; users will get it within ~30s without any cache-busting.
 *
 *  - HTTP fingerprinting (HEAD probe with a short timeout) filters out
 *    non-HTTP listeners (Postgres, Redis, language servers). A port that
 *    refuses to speak HTTP is dropped entirely from the result rather
 *    than reported with `probed:false`, because surfacing
 *    `http://localhost:5432` in the Preview URL bar would be worse than
 *    surfacing nothing.
 */

import { spawn } from '@shogo/shared-runtime/child-process'
import { realpath } from 'node:fs/promises'
import { platform } from 'node:os'
import { prisma } from '../prisma'

const SCAN_THROTTLE_MS = 1500
const FOLDER_CACHE_TTL_MS = 30_000
/**
 * A dev server answering a HEAD probe in the middle of a compile can take a
 * couple of seconds (SHO-200 S2). 300 ms flagged a live server as gone, which
 * cleared the detected URL and made the Preview tab re-open.
 */
const HTTP_PROBE_TIMEOUT_MS = 1500
const LSOF_TIMEOUT_MS = 2000
/** How long a port may be absent before it is dropped from a project's result. */
const PORT_MEMORY_TTL_MS = 10_000
/** …and it must be missing for this many real scans in a row, too. */
const PORT_MEMORY_MAX_MISSES = 2
/**
 * Listeners that are never a project's app: Node's inspector is not an app at
 * all, and Shogo's own API/agent-runtime processes (this process and anything
 * it spawned) are not the user's dev server.
 */
const IGNORED_PORTS = new Set<number>([9229])

/** A listening TCP socket reported by the platform scanner. */
export interface ListeningSocket {
  /** Listening port (1‥65535). */
  port: number
  /** OS pid of the owning process. */
  pid: number
  /** Process command (`node`, `bun`, `python` …). May be truncated by lsof. */
  command: string
  /** Listen address (e.g. `127.0.0.1`, `0.0.0.0`, `::1`). */
  address: string
}

/** Per-pid metadata used for attribution. */
export interface ProcessInfo {
  pid: number
  /** Process current working directory (resolved, no trailing slash). */
  cwd: string | null
  /** Parent pid, if known. Used for ancestry-based attribution later. */
  ppid?: number
}

export interface PortScanner {
  listListeningSockets(): Promise<ListeningSocket[]>
  describeProcess(pid: number): Promise<ProcessInfo | null>
}

export interface HttpProbe {
  probe(url: string): Promise<boolean>
}

export interface AttributedPort {
  projectId: string
  port: number
  pid: number
  command: string
  url: string
  /** Folder under which the owning process's cwd was found. */
  matchedFolder: string
  /** Epoch ms when this port was last seen by a scan. */
  observedAt: number
}

/* ────────────────────────────────────────────────────────────────────── *
 * Default scanner: `lsof` on darwin/linux. Other platforms degrade to
 * an empty list (the API just falls back to PTY-derived detection).
 * ────────────────────────────────────────────────────────────────────── */

function runCommand(cmd: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    let settled = false
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] })
    const chunks: Buffer[] = []
    const finish = (stdout: string) => {
      if (settled) return
      settled = true
      resolve(stdout)
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* noop */
      }
      finish('')
    }, timeoutMs)
    child.stdout?.on('data', (c: Buffer) => chunks.push(c))
    child.on('error', () => {
      clearTimeout(timer)
      finish('')
    })
    child.on('close', () => {
      clearTimeout(timer)
      finish(Buffer.concat(chunks).toString('utf8'))
    })
  })
}

/**
 * Parse `lsof -nP -iTCP -sTCP:LISTEN -F pcnL` output.
 *
 * `-F` produces records prefixed by single-letter field codes:
 *   p<pid>     start of a process record
 *   c<command> command name
 *   L<login>   (ignored)
 *   f<fd>      start of a file record (we treat each `n` as one socket)
 *   n<host>:<port>  network address
 *
 * Some lsof builds emit `t<type>` (IPv4/IPv6) too; we don't care.
 */
export function parseLsofListening(raw: string): ListeningSocket[] {
  const out: ListeningSocket[] = []
  if (!raw) return out
  let pid = 0
  let command = ''
  for (const line of raw.split('\n')) {
    if (!line) continue
    const code = line[0]
    const value = line.slice(1)
    if (code === 'p') {
      pid = Number(value) || 0
      command = ''
    } else if (code === 'c') {
      command = value
    } else if (code === 'n') {
      // Examples: "127.0.0.1:5173", "*:8080", "[::1]:3000", "[::]:5432"
      const idx = value.lastIndexOf(':')
      if (idx <= 0) continue
      const addrPart = value.slice(0, idx)
      const portPart = value.slice(idx + 1)
      const port = Number(portPart)
      if (!Number.isInteger(port) || port <= 0 || port > 65535) continue
      // Skip wildcards we can't display; "*" and "[::]" both mean "all
      // interfaces" but in practice "*" is rare on listening sockets we
      // probe — we still keep them, they'll probe as 127.0.0.1.
      let address = addrPart
      if (address.startsWith('[') && address.endsWith(']')) {
        address = address.slice(1, -1)
      }
      if (pid > 0) {
        out.push({ port, pid, command, address })
      }
    }
  }
  return dedupePidPort(out)
}

function dedupePidPort(sockets: ListeningSocket[]): ListeningSocket[] {
  const seen = new Set<string>()
  const out: ListeningSocket[] = []
  for (const s of sockets) {
    const key = `${s.pid}:${s.port}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(s)
  }
  return out
}

export function parseLsofCwd(raw: string): string | null {
  if (!raw) return null
  for (const line of raw.split('\n')) {
    if (line.startsWith('n')) return line.slice(1) || null
  }
  return null
}

export function parsePsPpid(raw: string): number | null {
  const value = Number((raw ?? '').trim())
  return Number.isInteger(value) && value > 0 ? value : null
}

export const defaultScanner: PortScanner = {
  async listListeningSockets() {
    const p = platform()
    if (p !== 'darwin' && p !== 'linux') return []
    const raw = await runCommand(
      'lsof',
      ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pcnL'],
      LSOF_TIMEOUT_MS,
    )
    return parseLsofListening(raw)
  },
  async describeProcess(pid) {
    const p = platform()
    if (p !== 'darwin' && p !== 'linux') return null
    if (!Number.isInteger(pid) || pid <= 0) return null
    const [raw, ppidRaw] = await Promise.all([
      runCommand('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-F', 'n'], LSOF_TIMEOUT_MS),
      runCommand('ps', ['-o', 'ppid=', '-p', String(pid)], LSOF_TIMEOUT_MS),
    ])
    const ppid = parsePsPpid(ppidRaw) ?? undefined
    const cwd = parseLsofCwd(raw)
    if (!cwd) return { pid, cwd: null, ppid }
    try {
      const resolved = await realpath(cwd)
      return { pid, cwd: resolved.replace(/\/+$/, ''), ppid }
    } catch {
      return { pid, cwd: cwd.replace(/\/+$/, ''), ppid }
    }
  },
}

export const defaultHttpProbe: HttpProbe = {
  async probe(url: string) {
    try {
      const res = await fetch(url, {
        method: 'HEAD',
        signal: AbortSignal.timeout(HTTP_PROBE_TIMEOUT_MS),
        redirect: 'manual',
      })
      // Any HTTP-shaped response — 2xx, 3xx, 4xx, 5xx — means "there is
      // an HTTP server here". Non-HTTP listeners hang up the connection
      // and fetch throws, which we catch below.
      return res.status >= 100 && res.status < 600
    } catch {
      // Some servers reject HEAD with a TCP RST and fetch will throw.
      // Fall back to GET with a 1-byte range. This costs us one extra
      // round trip in the worst case but rescues servers like older
      // Vite dev modes that 400 on HEAD.
      try {
        const res = await fetch(url, {
          method: 'GET',
          headers: { Range: 'bytes=0-0' },
          signal: AbortSignal.timeout(HTTP_PROBE_TIMEOUT_MS),
          redirect: 'manual',
        })
        return res.status >= 100 && res.status < 600
      } catch {
        return false
      }
    }
  },
}

/* ────────────────────────────────────────────────────────────────────── *
 * Folder lookup with TTL cache.
 * ────────────────────────────────────────────────────────────────────── */

export interface FolderResolver {
  resolveFolders(projectId: string): Promise<string[]>
}

export function makePrismaFolderResolver(): FolderResolver {
  const cache = new Map<string, { paths: string[]; expiresAt: number }>()
  return {
    async resolveFolders(projectId) {
      const now = Date.now()
      const cached = cache.get(projectId)
      if (cached && cached.expiresAt > now) return cached.paths
      const rows = await prisma.projectFolder.findMany({
        where: { projectId },
        select: { path: true },
      })
      const paths: string[] = []
      for (const r of rows) {
        if (!r.path) continue
        try {
          const real = await realpath(r.path)
          paths.push(real.replace(/\/+$/, ''))
        } catch {
          paths.push(r.path.replace(/\/+$/, ''))
        }
      }
      cache.set(projectId, { paths, expiresAt: now + FOLDER_CACHE_TTL_MS })
      return paths
    },
  }
}

/* ────────────────────────────────────────────────────────────────────── *
 * Attribution helpers.
 * ────────────────────────────────────────────────────────────────────── */

/**
 * Returns true iff `child` is the same path as `parent` or a descendant
 * of it. Both inputs are expected to be absolute, with no trailing
 * slashes — `LocalPortObserver` normalises them before calling.
 *
 * Importantly we anchor on the path separator so `/Users/a/app` does
 * NOT match `/Users/a/app2`.
 */
export function pathIsWithin(child: string, parent: string): boolean {
  if (!child || !parent) return false
  if (child === parent) return true
  return child.startsWith(parent + '/')
}

/**
 * Pick the URL to probe and the URL to surface for a listening socket.
 *
 * A server bound only to `::1` (Node 17+ / Bun resolve `localhost` to IPv6
 * first on macOS, so Vite and Astro dev servers commonly do this) refuses
 * connections on `127.0.0.1`. Probe the family it actually listens on, and
 * surface `localhost` for IPv6 loopback since Chromium tries both families.
 */
export function urlsForListenAddress(
  address: string,
  port: number,
): { probeUrl: string; url: string } {
  if (address === '::1' || address === '::') {
    return { probeUrl: `http://[::1]:${port}`, url: `http://localhost:${port}` }
  }
  const url = `http://127.0.0.1:${port}`
  return { probeUrl: url, url }
}

/* ────────────────────────────────────────────────────────────────────── *
 * The observer.
 * ────────────────────────────────────────────────────────────────────── */

export interface LocalPortObserverOptions {
  scanner?: PortScanner
  httpProbe?: HttpProbe
  folderResolver?: FolderResolver
  /** Override for tests; defaults to Date.now. */
  now?: () => number
  /** Override for tests; defaults to 1500ms. */
  scanThrottleMs?: number
  /** Pids that are never a project's app (this API process, for one). */
  internalPids?: () => ReadonlySet<number>
}

/** A port a project has reported, kept across the scans that miss it. */
interface RememberedPort {
  port: number
  pid: number
  command: string
  url: string
  matchedFolder: string
  lastSeenAt: number
  /** Consecutive *real* scans that did not see this port. */
  misses: number
}

export class LocalPortObserver {
  private readonly scanner: PortScanner
  private readonly httpProbe: HttpProbe
  private readonly folderResolver: FolderResolver
  private readonly now: () => number
  private readonly scanThrottleMs: number
  private readonly internalPids: () => ReadonlySet<number>

  private lastScanAt = 0
  private lastScan: ListeningSocket[] = []
  private inflight: Promise<ListeningSocket[]> | null = null
  private readonly processCache = new Map<number, { info: ProcessInfo | null; expiresAt: number }>()
  /**
   * Ports each project has reported recently, keyed by project. Keeping this is
   * what stops a single missed probe (or a slow compile) from clearing
   * `detectedUrl` and re-opening the Preview tab (SHO-200 S2/S4).
   */
  private readonly remembered = new Map<string, Map<number, RememberedPort>>()
  /** The URL last handed out per project, so a second listener can't steal it. */
  private readonly chosen = new Map<string, string>()
  private readonly internalPidCache = new Map<number, boolean>()

  constructor(opts: LocalPortObserverOptions = {}) {
    this.scanner = opts.scanner ?? defaultScanner
    this.httpProbe = opts.httpProbe ?? defaultHttpProbe
    this.folderResolver = opts.folderResolver ?? makePrismaFolderResolver()
    this.now = opts.now ?? Date.now
    this.scanThrottleMs = opts.scanThrottleMs ?? SCAN_THROTTLE_MS
    this.internalPids = opts.internalPids ?? (() => new Set([process.pid]))
  }

  /**
   * Return every HTTP-speaking listening port that belongs to `projectId`,
   * with the project's previous answer kept sticky.
   *
   * Steps:
   *   1. Coalesced, throttled scan of all listening sockets.
   *   2. Filter to sockets whose owning PID's cwd is inside one of the
   *      project's folders, skipping Node's inspector and Shogo's own
   *      processes.
   *   3. HEAD-probe each candidate; drop the ones that don't speak HTTP.
   *   4. Fold the survivors into the project's remembered set. A port is only
   *      forgotten after `PORT_MEMORY_MAX_MISSES` real scans without it *and*
   *      `PORT_MEMORY_TTL_MS` — one slow answer is not the server going away.
   *   5. Order the result with the URL this project already reported first, so
   *      a second server appearing or disappearing cannot re-rank it.
   */
  async attributedPorts(projectId: string): Promise<AttributedPort[]> {
    if (!projectId) return []
    const folders = await this.folderResolver.resolveFolders(projectId)
    if (folders.length === 0) return []

    const { sockets, fresh } = await this.scan()
    const live = sockets.length === 0 ? [] : await this.livePorts(projectId, folders, sockets)

    const memory = this.remembered.get(projectId) ?? new Map<number, RememberedPort>()
    this.remembered.set(projectId, memory)

    if (fresh) {
      for (const entry of memory.values()) entry.misses += 1
    }
    const ts = this.now()
    for (const port of live) {
      memory.set(port.port, {
        port: port.port,
        pid: port.pid,
        command: port.command,
        url: port.url,
        matchedFolder: port.matchedFolder,
        lastSeenAt: ts,
        misses: 0,
      })
    }
    for (const [port, entry] of memory) {
      if (entry.misses === 0) continue
      const expired =
        entry.misses >= PORT_MEMORY_MAX_MISSES || ts - entry.lastSeenAt >= PORT_MEMORY_TTL_MS
      if (expired) memory.delete(port)
    }
    if (memory.size === 0) {
      this.chosen.delete(projectId)
      return []
    }

    const out: AttributedPort[] = [...memory.values()].map((entry) => ({
      projectId,
      port: entry.port,
      pid: entry.pid,
      command: entry.command,
      url: entry.url,
      matchedFolder: entry.matchedFolder,
      observedAt: entry.lastSeenAt,
    }))

    // Sticky first, then the freshest match, then the lowest port.
    const previous = this.chosen.get(projectId)
    out.sort((a, b) => {
      if (a.url === previous && b.url !== previous) return -1
      if (b.url === previous && a.url !== previous) return 1
      return b.observedAt - a.observedAt || a.port - b.port
    })
    this.chosen.set(projectId, out[0].url)
    return out
  }

  /**
   * Returns the single best URL for a project, or null if none. "Best" is
   * whatever this project last reported — not a fresh ranking by port, which is
   * what made a second listener steal the address bar (SHO-200 S3).
   */
  async detectedUrl(projectId: string): Promise<string | null> {
    const ports = await this.attributedPorts(projectId)
    return ports[0]?.url ?? null
  }

  /** Force a scan now, bypassing the throttle. Used by tests. */
  async scanNow(): Promise<ListeningSocket[]> {
    this.lastScanAt = 0
    const { sockets } = await this.scan()
    return sockets
  }

  /** Drop the in-memory caches. Used by tests. */
  reset(): void {
    this.lastScanAt = 0
    this.lastScan = []
    this.inflight = null
    this.processCache.clear()
    this.remembered.clear()
    this.chosen.clear()
    this.internalPidCache.clear()
  }

  /** Attribute + probe one scan's sockets to this project. */
  private async livePorts(
    projectId: string,
    folders: string[],
    sockets: ListeningSocket[],
  ): Promise<AttributedPort[]> {
    // Group by pid so we describe each process at most once per call.
    const pids = new Set(sockets.map((s) => s.pid))
    const pidToInfo = new Map<number, ProcessInfo | null>()
    await Promise.all(
      Array.from(pids).map(async (pid) => {
        pidToInfo.set(pid, await this.describeProcessCached(pid))
      }),
    )

    const candidates: ListeningSocket[] = []
    const folderByPid = new Map<number, string>()
    for (const sock of sockets) {
      if (IGNORED_PORTS.has(sock.port)) continue
      if (await this.isInternalPid(sock.pid)) continue
      const info = pidToInfo.get(sock.pid) ?? null
      if (!info || !info.cwd) continue
      const matched = folders.find((f) => pathIsWithin(info.cwd!, f))
      if (!matched) continue
      candidates.push(sock)
      folderByPid.set(sock.pid, matched)
    }
    if (candidates.length === 0) return []

    // Probe in parallel. Dedupe by port — if a process listens on both
    // IPv4 and IPv6 we only want one entry per port.
    const byPort = new Map<number, ListeningSocket>()
    for (const c of candidates) {
      if (!byPort.has(c.port)) byPort.set(c.port, c)
    }

    const probeResults = await Promise.all(
      Array.from(byPort.values()).map(async (sock) => {
        const { probeUrl, url } = urlsForListenAddress(sock.address, sock.port)
        const ok = await this.httpProbe.probe(probeUrl)
        return ok ? { sock, url } : null
      }),
    )

    const ts = this.now()
    const out: AttributedPort[] = []
    for (const r of probeResults) {
      if (!r) continue
      out.push({
        projectId,
        port: r.sock.port,
        pid: r.sock.pid,
        command: r.sock.command,
        url: r.url,
        matchedFolder: folderByPid.get(r.sock.pid) ?? '',
        observedAt: ts,
      })
    }
    return out
  }

  /**
   * True for this process and anything it spawned (the agent runtime, the API
   * sidecar) — none of those are the user's dev server, even when their cwd is
   * inside the project folder.
   */
  private async isInternalPid(pid: number): Promise<boolean> {
    const cached = this.internalPidCache.get(pid)
    if (cached !== undefined) return cached
    const roots = this.internalPids()
    const seen = new Set<number>()
    let cursor: number | undefined = pid
    let internal = false
    for (let depth = 0; depth < 16 && cursor && cursor > 1; depth += 1) {
      if (seen.has(cursor)) break
      seen.add(cursor)
      if (roots.has(cursor)) {
        internal = true
        break
      }
      const info = await this.describeProcessCached(cursor)
      cursor = info?.ppid
    }
    this.internalPidCache.set(pid, internal)
    return internal
  }

  private async scan(): Promise<{ sockets: ListeningSocket[]; fresh: boolean }> {
    const now = this.now()
    if (now - this.lastScanAt < this.scanThrottleMs && this.lastScan.length > 0) {
      return { sockets: this.lastScan, fresh: false }
    }
    if (this.inflight) return { sockets: await this.inflight, fresh: false }
    const p = (async () => {
      try {
        const sockets = await this.scanner.listListeningSockets()
        this.lastScan = sockets
        this.lastScanAt = this.now()
        return sockets
      } catch {
        this.lastScan = []
        this.lastScanAt = this.now()
        return []
      } finally {
        this.inflight = null
      }
    })()
    this.inflight = p
    return { sockets: await p, fresh: true }
  }

  private async describeProcessCached(pid: number): Promise<ProcessInfo | null> {
    const now = this.now()
    const cached = this.processCache.get(pid)
    if (cached && cached.expiresAt > now) return cached.info
    const info = await this.scanner.describeProcess(pid)
    this.processCache.set(pid, { info, expiresAt: now + 5_000 })
    return info
  }
}

/* ────────────────────────────────────────────────────────────────────── *
 * Module-level singleton.
 *
 * The API route imports `getLocalPortObserver()`; tests construct their
 * own instance with mocked dependencies. We deliberately do NOT start a
 * background interval — scans happen on-demand from the HTTP handler so
 * an idle server costs nothing.
 * ────────────────────────────────────────────────────────────────────── */

let singleton: LocalPortObserver | null = null

export function getLocalPortObserver(): LocalPortObserver {
  if (!singleton) singleton = new LocalPortObserver()
  return singleton
}

/** Test-only: replace or clear the singleton. */
export function __setLocalPortObserverForTests(obs: LocalPortObserver | null): void {
  singleton = obs
}
