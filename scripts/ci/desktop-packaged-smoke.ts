#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Post-boot smoke for a packaged desktop app, run by the release workflows
 * after the boot smoke saw "API server is healthy".
 *
 * Each step is a regression #1003 shipped past CI because nothing exercised
 * the packaged app beyond "the local server starts":
 *
 *   1. Local auto-sign-in yields a session.
 *   2. Opening a folder lands in a TEAM workspace (a personal one runs the
 *      no-shell profile, so the agent could not run a single command).
 *   3. The folder project starts restricted and "Trust folder" flips it.
 *   4. Its runtime spawns from the bundled toolchain under the app's launch
 *      PATH (Finder's /usr/bin:/bin:/usr/sbin:/sbin, not a dev shell's).
 *   5. A terminal session spawns where the project folder is reachable, and
 *      a command typed over its WebSocket echoes back (a real PTY, which on
 *      Windows needs the bundled Bun to be >= 1.4 for ConPTY).
 *
 * Usage: bun scripts/ci/desktop-packaged-smoke.ts --log <main.log> [--folder <dir>] [--bundled-bun <path>]
 *   The API port is read from the app's "[Desktop] Ports: API=<port>" line.
 *   `--base http://localhost:8002` targets a local-mode dev API instead.
 *   `--bundled-bun` checks the app's shipped Bun meets MIN_BUNDLED_BUN.
 */

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import {
  ServerFrameType,
  decodeServerFrame,
  encodeClientData,
} from '../../packages/pty-core/src/pty-protocol'

/** Bun.spawn({ terminal }) has a Windows (ConPTY) backend only from 1.4.0. */
export const MIN_BUNDLED_BUN = '1.4.0'

export function apiPortFromLog(log: string): number | null {
  const m = [...log.matchAll(/\[Desktop\] Ports: API=(\d+)/g)].at(-1)
  return m ? Number(m[1]) : null
}

/** True when dotted version `actual` (e.g. "1.4.2", "1.4.0-canary.1") >= `min`. */
export function versionAtLeast(actual: string, min: string): boolean {
  const parse = (v: string) => v.trim().replace(/^v/, '').split(/[-+]/)[0].split('.').map((n) => Number(n) || 0)
  const a = parse(actual)
  const b = parse(min)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    if (d !== 0) return d > 0
  }
  return true
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

class Session {
  cookie = ''
  constructor(readonly base: string) {}

  async call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        origin: this.base,
        ...(this.cookie ? { cookie: this.cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    })
    const set = res.headers.getSetCookie?.() ?? []
    if (set.length) this.cookie = set.map((c) => c.split(';')[0]).join('; ')
    const text = await res.text()
    let json: any = text
    try { json = JSON.parse(text) } catch { /* keep text */ }
    return { status: res.status, json }
  }
}

function check(ok: unknown, step: string, detail: unknown): void {
  if (ok) {
    console.log(`  ok  ${step}`)
    return
  }
  console.error(`  FAIL ${step}\n       ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
  process.exit(1)
}

/**
 * Type a command into the session's WebSocket and resolve with everything
 * the PTY sent back once `marker` has appeared twice (the echoed command
 * line, then its output), or reject after `timeoutMs`.
 */
function terminalEcho(s: Session, path: string, marker: string, timeoutMs: number): Promise<string> {
  const url = s.base.replace(/^http/, 'ws') + path
  // Bun's WebSocket client accepts headers; the API authenticates by cookie.
  const ws = new WebSocket(url, { headers: { cookie: s.cookie, origin: s.base } } as any)
  ws.binaryType = 'arraybuffer'
  let out = ''
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.close()
      reject(new Error(`no "${marker}" echo within ${timeoutMs}ms; received ${JSON.stringify(out.slice(-400))}`))
    }, timeoutMs)
    ws.addEventListener('open', () => {
      // ConPTY treats CR as Enter; a POSIX line discipline maps it to LF.
      const enter = process.platform === 'win32' ? '\r' : '\n'
      ws.send(encodeClientData(new TextEncoder().encode(`echo ${marker}${enter}`)))
    })
    ws.addEventListener('message', (ev) => {
      const frame = decodeServerFrame(new Uint8Array(ev.data as ArrayBuffer))
      if (frame?.type !== ServerFrameType.DATA) return
      out += new TextDecoder().decode(frame.bytes)
      if (out.split(marker).length - 1 >= 2) {
        clearTimeout(timer)
        ws.close()
        resolve(out)
      }
    })
    ws.addEventListener('error', () => {
      clearTimeout(timer)
      reject(new Error(`WebSocket error on ${url}`))
    })
    ws.addEventListener('close', (ev) => {
      clearTimeout(timer)
      reject(new Error(`WebSocket closed (${ev.code} ${ev.reason}) before "${marker}" echoed; received ${JSON.stringify(out.slice(-400))}`))
    })
  })
}

async function main(): Promise<void> {
  const bundledBun = arg('--bundled-bun')
  if (bundledBun) {
    const proc = Bun.spawnSync([bundledBun, '--version'])
    const version = proc.stdout.toString().trim()
    check(
      proc.exitCode === 0 && versionAtLeast(version, MIN_BUNDLED_BUN),
      `bundled Bun is >= ${MIN_BUNDLED_BUN} (terminal PTY support)`,
      { path: bundledBun, exitCode: proc.exitCode, version, stderr: proc.stderr.toString().trim() },
    )
  }

  let base = arg('--base')
  if (!base) {
    const logPath = arg('--log')
    if (!logPath) throw new Error('--log <main.log> (or --base <url>) is required')
    const port = apiPortFromLog(readFileSync(logPath, 'utf-8'))
    if (!port) throw new Error(`no "[Desktop] Ports: API=<port>" line in ${logPath}`)
    base = `http://127.0.0.1:${port}`
  }
  const s = new Session(base)
  console.log(`Desktop packaged smoke against ${s.base}`)

  const signIn = await s.call('POST', '/api/local/auto-sign-in')
  check(signIn.status === 200, 'local auto-sign-in', signIn)
  await s.call('POST', '/api/onboarding/complete')

  // Linked folders must live under the user's home directory.
  const folder = arg('--folder') ?? mkdtempSync(join(homedir(), 'shogo-smoke-folder-'))
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, 'README.md'), '# desktop smoke\n')
  const created = await s.call('POST', '/api/local/projects/from-folders', { paths: [folder], acceptedGitRoot: false })
  const project = created.json?.project ?? created.json
  check(created.status < 300 && project?.id, 'open a folder as a project', created)

  const workspaces = await s.call('GET', '/api/workspaces')
  const items: Array<{ id: string; kind?: string }> = workspaces.json?.items ?? workspaces.json?.data?.items ?? []
  const ws = items.find((w) => w.id === project.workspaceId)
  check(ws && ws.kind !== 'personal', 'folder project lands in a team workspace (the personal profile has no shell)', { workspaceId: project.workspaceId, workspaces: items })

  check(project.trustLevel === 'restricted', 'folder project starts restricted', project.trustLevel)
  const trusted = await s.call('POST', `/api/local/projects/${project.id}/trust`, { trusted: true })
  check(trusted.json?.project?.trustLevel === 'trusted', 'Trust folder flips it to trusted', trusted)

  const deadline = Date.now() + 180_000
  let runtime: { status: number; json: any } = { status: 0, json: null }
  while (Date.now() < deadline) {
    runtime = await s.call('POST', `/api/projects/${project.id}/runtime/start`)
    if (runtime.status >= 400 || runtime.json?.status === 'running') break
    await Bun.sleep(3_000)
  }
  check(runtime.json?.status === 'running', 'project runtime spawns under the launch PATH', runtime)

  const term = await s.call('POST', `/api/projects/${project.id}/terminal/sessions`, { cols: 80, rows: 24 })
  check(term.status === 200 && term.json?.id, 'terminal session spawns', term)
  // The runtime's merged root mounts the folder at `<root>/<projectId>`.
  const real = (p: string) => { try { return realpathSync(p) } catch { return '' } }
  const cwd = term.json.cwd ?? ''
  const reachesFolder = real(cwd) === real(folder) || real(join(cwd, project.id)) === real(folder)
  check(reachesFolder, 'terminal opens where the project folder is reachable', { cwd, folder })

  const wsPath = `/api/projects/${project.id}/terminal/sessions/${term.json.id}/ws`
  const echoed = await terminalEcho(s, wsPath, 'shogo-smoke-echo', 30_000).then(
    () => true,
    (err: Error) => err.message,
  )
  check(echoed === true, 'a command typed over the terminal WebSocket echoes back', echoed)
  await s.call('DELETE', `/api/projects/${project.id}/terminal/sessions/${term.json.id}`)

  console.log('Desktop packaged smoke PASSED')
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`Desktop packaged smoke FAILED: ${err?.message ?? err}`)
    process.exit(1)
  })
}
