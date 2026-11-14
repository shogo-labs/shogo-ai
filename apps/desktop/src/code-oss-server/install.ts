// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Download, verify and unpack the prebuilt Shogo IDE server on first use.
 * Electron-free so it can be unit tested against a local HTTP server.
 *
 * Layout: <installRoot>/<commit12>-<inputs12>/ with `.installed.json` written
 * last, so a crash mid-install never looks installed. The install root is
 * short on purpose (%LOCALAPPDATA%\Shogo\ide-server on Windows) because the
 * server's node_modules paths would otherwise exceed MAX_PATH; the build
 * enforces the matching per-file budget.
 */
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from '../child-process'
import type { ServerAsset, ServerTarget } from './manifest'

export type InstallPhase = 'downloading' | 'verifying' | 'extracting'

export interface InstallProgress {
  phase: InstallPhase
  received?: number
  total?: number
}

export interface InstalledMarker {
  artifactId: string
  target: ServerTarget
  sha256: string
  installedAt: string
}

export interface EnsureServerOptions {
  artifactId: string
  target: ServerTarget
  asset: ServerAsset
  installRoot: string
  onProgress?: (progress: InstallProgress) => void
  signal?: AbortSignal
  fetchImpl?: typeof fetch
  extract?: (archive: string, destination: string) => Promise<void>
  /** Wait before each retry; its length is the number of retries. */
  retryDelaysMs?: readonly number[]
}

export interface EnsureServerResult {
  dir: string
  downloaded: boolean
}

export class Sha256MismatchError extends Error {
  constructor(readonly expected: string, readonly actual: string) {
    super(`The downloaded Shogo IDE server is corrupt (expected SHA-256 ${expected}, got ${actual}).`)
    this.name = 'Sha256MismatchError'
  }
}

const MARKER = '.installed.json'
const DEFAULT_RETRY_DELAYS_MS = [1_000, 3_000, 9_000]
const inflight = new Map<string, Promise<EnsureServerResult>>()

export function defaultInstallRoot(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = process.env.HOME ?? process.env.USERPROFILE ?? '',
): string {
  if (platform === 'win32') {
    return path.win32.join(env.LOCALAPPDATA || path.win32.join(home, 'AppData', 'Local'), 'Shogo', 'ide-server')
  }
  if (platform === 'darwin') return path.posix.join(home, 'Library', 'Application Support', 'Shogo', 'ide-server')
  return path.posix.join(env.XDG_DATA_HOME || path.posix.join(home, '.local', 'share'), 'shogo', 'ide-server')
}

const INSTALL_DIR_RE = /^[0-9a-f]{12}-[0-9a-f]{12}(\.tmp-[0-9a-f]+)?$/

/**
 * `<installRoot>/<commit12>-<inputs12>`: the artifact id without its prefix
 * or the target (one target per machine; the marker records it). Every
 * character counts against MAX_PATH on Windows.
 */
export function serverInstallDir(installRoot: string, artifactId: string): string {
  return path.join(installRoot, artifactId.replace(/^shogo-ide-server-/, ''))
}

export function readInstalledMarker(dir: string): InstalledMarker | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, MARKER), 'utf8')) as InstalledMarker
  } catch {
    return null
  }
}

/** Extracts with the OS tar. On Windows always System32's bsdtar, never Git's GNU tar. */
export function systemTarExtract(archive: string, destination: string): Promise<void> {
  const tar = process.platform === 'win32'
    ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar'
  return new Promise((resolve, reject) => {
    const child = spawn(tar, ['-xzf', archive, '-C', destination], { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`Could not unpack the Shogo IDE server (tar exited with ${code}): ${stderr.trim().slice(-400)}`))
    })
  })
}

function isRetryable(error: unknown): boolean {
  if (error instanceof Sha256MismatchError) return false
  if ((error as { name?: string })?.name === 'AbortError') return false
  const status = (error as { status?: number })?.status
  return status === undefined || status >= 500 || status === 429
}

async function download(
  asset: ServerAsset,
  destination: string,
  options: Pick<EnsureServerOptions, 'onProgress' | 'signal' | 'fetchImpl'>,
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch
  const res = await fetchImpl(asset.url, { signal: options.signal, redirect: 'follow' })
  if (!res.ok || !res.body) {
    const error = new Error(`Downloading the Shogo IDE server failed: HTTP ${res.status} from ${asset.url}`)
    ;(error as Error & { status: number }).status = res.status
    throw error
  }
  const total = Number(res.headers.get('content-length')) || asset.size
  const hash = createHash('sha256')
  const out = fs.createWriteStream(destination)
  let received = 0
  try {
    options.onProgress?.({ phase: 'downloading', received, total })
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      hash.update(chunk)
      received += chunk.byteLength
      if (!out.write(chunk)) await new Promise<void>((resolve) => out.once('drain', resolve))
      options.onProgress?.({ phase: 'downloading', received, total })
    }
  } finally {
    await new Promise<void>((resolve) => out.end(resolve))
  }
  options.onProgress?.({ phase: 'verifying' })
  const actual = hash.digest('hex')
  if (actual !== asset.sha256) throw new Sha256MismatchError(asset.sha256, actual)
}

function prune(installRoot: string, keep: string): void {
  let entries: string[]
  try {
    entries = fs.readdirSync(installRoot)
  } catch {
    return
  }
  for (const name of entries) {
    const full = path.join(installRoot, name)
    if (full === keep) continue
    if (INSTALL_DIR_RE.test(name) || name.startsWith('.download-')) {
      try {
        fs.rmSync(full, { recursive: true, force: true })
      } catch {
        // In use (a server from the old version still running); next install retries.
      }
    }
  }
}

async function install(options: EnsureServerOptions): Promise<EnsureServerResult> {
  const { artifactId, target, asset, installRoot } = options
  const dir = serverInstallDir(installRoot, artifactId)
  const marker = readInstalledMarker(dir)
  if (marker?.sha256 === asset.sha256 && marker.target === target) return { dir, downloaded: false }

  fs.mkdirSync(installRoot, { recursive: true })
  const suffix = randomBytes(4).toString('hex')
  const archive = path.join(installRoot, `.download-${suffix}.tar.gz`)
  const staging = `${dir}.tmp-${suffix}`
  const delays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        await download(asset, archive, options)
        break
      } catch (error) {
        fs.rmSync(archive, { force: true })
        if (attempt >= delays.length || !isRetryable(error)) throw error
        await new Promise((resolve) => setTimeout(resolve, delays[attempt]))
      }
    }
    options.onProgress?.({ phase: 'extracting' })
    fs.mkdirSync(staging, { recursive: true })
    await (options.extract ?? systemTarExtract)(archive, staging)
    const installed: InstalledMarker = { artifactId, target, sha256: asset.sha256, installedAt: new Date().toISOString() }
    fs.writeFileSync(path.join(staging, MARKER), `${JSON.stringify(installed, null, 2)}\n`)
    fs.rmSync(dir, { recursive: true, force: true })
    fs.renameSync(staging, dir)
  } finally {
    fs.rmSync(archive, { force: true })
    fs.rmSync(staging, { recursive: true, force: true })
  }
  prune(installRoot, dir)
  return { dir, downloaded: true }
}

/** Installs the server if needed; concurrent calls for one install share a single download. */
export function ensureCodeOssServer(options: EnsureServerOptions): Promise<EnsureServerResult> {
  const key = serverInstallDir(options.installRoot, options.artifactId)
  const existing = inflight.get(key)
  if (existing) return existing
  const pending = install(options).finally(() => inflight.delete(key))
  inflight.set(key, pending)
  return pending
}
