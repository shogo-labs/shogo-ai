// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Run-and-Debug IPC for the desktop IDE.
 *
 * Purpose
 * ───────
 * Surfaces a minimal "run a package.json script" capability to the
 * renderer so the new Activity Bar "Run and Debug" entry has actual
 * end-to-end functionality (not just an explainer panel). This is the
 * pragmatic 80% of what most developers reach for "Run and Debug" for:
 * one-click `npm run dev`, `npm test`, etc. with live streamed output
 * and a Stop button.
 *
 * This deliberately does NOT implement the Debug Adapter Protocol —
 * full breakpoint/stepping support is tracked as FEAT-DEBUG. When DAP
 * lands, this surface stays useful as the "Run without debugging"
 * shortcut, exactly like VS Code's RunAndDebug view.
 *
 * Sandboxing
 * ──────────
 * Mirrors fs-ipc / git-ipc: every `workspaceRoot` passed from the
 * renderer is normalised, resolved, and rejected if it does not live
 * under the user's $HOME. Script names are validated against the
 * actual script keys parsed out of package.json — never executed as
 * raw shell input.
 *
 * Lifecycle
 * ─────────
 * Each spawn is keyed by a server-issued runId (UUID). The main side
 * holds the live ChildProcess in a Map and broadcasts data/exit to all
 * renderer windows via `run:output:<runId>` / `run:exit:<runId>`. On
 * window destruction OR on `dispose()` we SIGTERM all live processes
 * with a 3s SIGKILL grace, so quitting Electron never leaves a
 * `vite build --watch` running.
 */
import { ipcMain, BrowserWindow } from 'electron'
import { spawn, type ChildProcessByStdio } from 'child_process'
import type { Readable } from 'stream'

type RunChild = ChildProcessByStdio<null, Readable, Readable>
import { promises as fs } from 'fs'
import * as path from 'path'
import { validateWorkspace, detectPackageManager, parsePackageJsonScripts, buildInspectorNodeOptions, extractInspectorWsUrl, type PackageManager } from './run-ipc-pure'
import { randomUUID } from 'crypto'

import type { ScriptEntry } from './run-ipc-pure'

interface ListScriptsResult {
  ok: boolean
  scripts?: ScriptEntry[]
  packageManager?: PackageManager
  error?: string
}

interface StartResult {
  ok: boolean
  runId?: string
  /** For debug mode: ws URL once v8 prints it. Empty until then; consumers
   *  should also subscribe to `run:inspector:<runId>` for the late arrival. */
  inspectorWsUrl?: string
  error?: string
}

interface StartOptions {
  /** Spawn the script with NODE_OPTIONS='--inspect-brk=0' so a debugger can attach. */
  debug?: boolean
}

interface RunInfo {
  runId: string
  workspaceRoot: string
  script: string
  packageManager: PackageManager
  startedAt: number
  proc: RunChild
  /** True when this run was launched with --inspect-brk for the debugger to attach. */
  debug: boolean
  /** Buffer of stderr accumulated until we extract the inspector ws URL (then cleared). */
  stderrPrefix: string
  /** Discovered ws URL, once v8 prints "Debugger listening on …". null until then. */
  inspectorWsUrl: string | null
}

const liveRuns = new Map<string, RunInfo>()

async function listScriptsHandler(_e: unknown, root: string): Promise<ListScriptsResult> {
  const valid = validateWorkspace(root)
  if (!valid) return { ok: false, error: 'invalid workspace path' }
  const pkgPath = path.join(valid, 'package.json')
  let raw: string
  try {
    raw = await fs.readFile(pkgPath, 'utf8')
  } catch (e) {
    return { ok: false, error: `no package.json: ${(e as Error).message}` }
  }
  const parsed = parsePackageJsonScripts(raw)
  if (!parsed.ok) {
    return { ok: false, error: parsed.error }
  }
  const scripts = parsed.scripts
  const packageManager = await detectPackageManager(valid)
  return { ok: true, scripts, packageManager }
}

function broadcastToAll(channel: string, payload: unknown) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) {
      try { w.webContents.send(channel, payload) } catch { /* window closed mid-send */ }
    }
  }
}

async function startHandler(
  _e: unknown,
  root: string,
  scriptName: string,
  preferredPm?: PackageManager,
  options?: StartOptions,
): Promise<StartResult> {
  const valid = validateWorkspace(root)
  if (!valid) return { ok: false, error: 'invalid workspace path' }

  // Re-read package.json to verify scriptName is real — never trust
  // the renderer-side cache for what we're about to spawn.
  const lst = await listScriptsHandler(null, valid)
  if (!lst.ok) return { ok: false, error: lst.error }
  const known = new Set((lst.scripts ?? []).map((s) => s.name))
  if (!known.has(scriptName)) {
    return { ok: false, error: `unknown script: ${scriptName}` }
  }

  const pm = preferredPm ?? lst.packageManager ?? 'npm'
  const cmd = pm
  const args = ['run', scriptName]

  const debug = options?.debug === true
  const baseEnv: NodeJS.ProcessEnv = {
    ...process.env,
    FORCE_COLOR: '1',
    npm_lifecycle_event: scriptName,
  }
  if (debug) {
    baseEnv.NODE_OPTIONS = buildInspectorNodeOptions({
      breakOnStart: true,
      port: 0,
      existing: process.env.NODE_OPTIONS,
    })
  }

  let proc: RunChild
  try {
    proc = spawn(cmd, args, {
      cwd: valid,
      env: baseEnv,
      shell: false,
      // Important: do NOT detach. We want children to die when the
      // main process exits.
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (e) {
    return { ok: false, error: `spawn failed: ${(e as Error).message}` }
  }

  const runId = randomUUID()
  const info: RunInfo = {
    runId,
    workspaceRoot: valid,
    script: scriptName,
    packageManager: pm,
    startedAt: Date.now(),
    proc,
    debug,
    stderrPrefix: '',
    inspectorWsUrl: null,
  }
  liveRuns.set(runId, info)

  const outputChannel = `run:output:${runId}`
  const exitChannel = `run:exit:${runId}`

  proc.stdout.on('data', (chunk: Buffer) => {
    broadcastToAll(outputChannel, { stream: 'stdout', data: chunk.toString('utf8') })
  })
  const inspectorChannel = `run:inspector:${runId}`
  proc.stderr.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8')
    if (info.debug && info.inspectorWsUrl === null) {
      info.stderrPrefix += text
      const url = extractInspectorWsUrl(info.stderrPrefix)
      if (url) {
        info.inspectorWsUrl = url
        info.stderrPrefix = ''
        broadcastToAll(inspectorChannel, { runId, wsUrl: url })
      }
      // Cap the prefix buffer at 8 KB so a pathological process that
      // writes a lot to stderr before printing the inspector line
      // doesn't grow it unbounded.
      if (info.stderrPrefix.length > 8192) {
        info.stderrPrefix = info.stderrPrefix.slice(-4096)
      }
    }
    broadcastToAll(outputChannel, { stream: 'stderr', data: text })
  })
  proc.on('error', (err) => {
    broadcastToAll(outputChannel, { stream: 'stderr', data: `\n[shogo] spawn error: ${err.message}\n` })
  })
  proc.on('exit', (code, signal) => {
    liveRuns.delete(runId)
    broadcastToAll(exitChannel, { code, signal })
  })

  return { ok: true, runId, inspectorWsUrl: info.inspectorWsUrl ?? undefined }
}

interface StopResult { ok: boolean; error?: string }

async function stopHandler(_e: unknown, runId: string): Promise<StopResult> {
  const info = liveRuns.get(runId)
  if (!info) return { ok: false, error: 'no such run' }
  try {
    info.proc.kill('SIGTERM')
    // Grace period — if still alive after 3 s, SIGKILL.
    setTimeout(() => {
      const still = liveRuns.get(runId)
      if (still && !still.proc.killed) {
        try { still.proc.kill('SIGKILL') } catch { /* already dead */ }
      }
    }, 3000)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

async function listLiveHandler(): Promise<{ ok: true; runs: Array<{ runId: string; script: string; startedAt: number }> }> {
  const runs = Array.from(liveRuns.values()).map((r) => ({
    runId: r.runId,
    script: r.script,
    startedAt: r.startedAt,
  }))
  return { ok: true, runs }
}

let registered = false

export function registerRunIpcHandlers(): void {
  if (registered) return
  registered = true
  ipcMain.handle('run:listScripts', listScriptsHandler)
  ipcMain.handle('run:start', startHandler)
  ipcMain.handle('run:stop', stopHandler)
  ipcMain.handle('run:listLive', listLiveHandler)
}

export function disposeRunIpc(): void {
  for (const info of liveRuns.values()) {
    try { info.proc.kill('SIGTERM') } catch { /* swallow */ }
  }
  setTimeout(() => {
    for (const info of liveRuns.values()) {
      if (!info.proc.killed) {
        try { info.proc.kill('SIGKILL') } catch { /* swallow */ }
      }
    }
    liveRuns.clear()
  }, 3000)
}

// Pure helpers re-exported for convenience.
export { detectPackageManager, validateWorkspace } from './run-ipc-pure'
