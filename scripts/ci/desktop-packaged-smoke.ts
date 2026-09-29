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
 *   5. A terminal session spawns where the project folder is reachable.
 *
 * Usage: bun scripts/ci/desktop-packaged-smoke.ts --log <main.log> [--folder <dir>]
 *   The API port is read from the app's "[Desktop] Ports: API=<port>" line.
 *   `--base http://localhost:8002` targets a local-mode dev API instead.
 */

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

export function apiPortFromLog(log: string): number | null {
  const m = [...log.matchAll(/\[Desktop\] Ports: API=(\d+)/g)].at(-1)
  return m ? Number(m[1]) : null
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

class Session {
  private cookie = ''
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

async function main(): Promise<void> {
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
  await s.call('DELETE', `/api/projects/${project.id}/terminal/sessions/${term.json.id}`)

  console.log('Desktop packaged smoke PASSED')
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`Desktop packaged smoke FAILED: ${err?.message ?? err}`)
    process.exit(1)
  })
}
