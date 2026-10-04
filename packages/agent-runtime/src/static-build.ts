// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Preview for the `custom` tech stack: run the project's own static build and
 * serve its output exactly like a Vite stack's `dist/`.
 *
 * What to run comes from `shogo.preview.json` at the project root:
 *
 *   { "build": "astro build --base $SHOGO_BASE_PATH", "outDir": "dist" }
 *
 * Without that file, an Astro project builds with the Astro CLI and anything
 * else runs its `build` script into `dist/`. A command build gets the preview's
 * base path (`/p/<projectId>/` inside a workspace runtime, `/` otherwise) as
 * `$SHOGO_BASE_PATH`.
 */

import { spawn, type ChildProcess } from 'child_process'
import { cpSync, existsSync, readFileSync, watch, type FSWatcher } from 'fs'
import { join } from 'path'
import { pkg, resolveBinInvocation } from '@shogo/shared-runtime'

export const STATIC_BUILD_CONFIG_FILE = 'shogo.preview.json'

const BUILD_TIMEOUT_MS = 15 * 60_000

export interface StaticBuildConfig {
  build?: string
  outDir?: string
}

export type StaticBuildPlan =
  /** Writes straight into the staging dir via the framework's `--outDir`. */
  | { kind: 'astro'; label: string; cmd: string; args: string[] }
  /** A shell command that writes to `outDir`; its output is copied into staging. */
  | { kind: 'command'; label: string; command: string; outDir: string }

export function readStaticBuildConfig(cwd: string): StaticBuildConfig | { error: string } | null {
  const path = join(cwd, STATIC_BUILD_CONFIG_FILE)
  if (!existsSync(path)) return null
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'))
  } catch (err: any) {
    return { error: `${STATIC_BUILD_CONFIG_FILE} is not valid JSON: ${err?.message ?? err}` }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: `${STATIC_BUILD_CONFIG_FILE} must be a JSON object` }
  }
  const { build, outDir } = raw as Record<string, unknown>
  if (build !== undefined && (typeof build !== 'string' || !build.trim())) {
    return { error: `${STATIC_BUILD_CONFIG_FILE}: "build" must be a non-empty string` }
  }
  if (outDir !== undefined && !isSafeRelativeDir(outDir)) {
    return { error: `${STATIC_BUILD_CONFIG_FILE}: "outDir" must be a relative folder inside the project` }
  }
  return { build: build as string | undefined, outDir: outDir as string | undefined }
}

function isSafeRelativeDir(value: unknown): value is string {
  if (typeof value !== 'string' || !value.trim()) return false
  if (value.startsWith('/') || value.startsWith('\\') || /^[a-zA-Z]:/.test(value)) return false
  return !value.split(/[\\/]/).some((part) => part === '..')
}

function readPackageJson(cwd: string): { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> } | null {
  try {
    return JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf-8'))
  } catch {
    return null
  }
}

/** Decide what to run. `stagingDir` is relative to `cwd`. */
export function resolveStaticBuildPlan(
  cwd: string,
  opts: { stagingDir: string; basePath?: string },
): StaticBuildPlan | { error: string } {
  const config = readStaticBuildConfig(cwd)
  if (config && 'error' in config) return config
  if (config?.build) {
    return { kind: 'command', label: config.build, command: config.build, outDir: config.outDir ?? 'dist' }
  }

  const packageJson = readPackageJson(cwd)
  const usesAstro = !!(packageJson?.dependencies?.astro || packageJson?.devDependencies?.astro)
  const astro = usesAstro ? resolveBinInvocation(cwd, 'astro') : null
  if (astro && !config?.outDir) {
    const args = ['build', '--outDir', opts.stagingDir, ...(opts.basePath ? ['--base', opts.basePath] : [])]
    return { kind: 'astro', label: `astro ${args.join(' ')}`, cmd: astro.cmd, args: [...astro.argsPrefix, ...args] }
  }

  if (packageJson?.scripts?.build) {
    return {
      kind: 'command',
      label: 'bun run build',
      command: `${JSON.stringify(pkg.bunBinary)} run build`,
      outDir: config?.outDir ?? 'dist',
    }
  }

  return {
    error:
      `No build to run: add a "build" script to package.json, or a ${STATIC_BUILD_CONFIG_FILE} ` +
      `like {"build": "<command>", "outDir": "dist"}`,
  }
}

/**
 * Run one build and leave its output in `stagingDir` (relative to `cwd`) for
 * the caller to promote. Never throws.
 */
export async function runStaticBuild(
  cwd: string,
  plan: StaticBuildPlan,
  opts: {
    stagingDir: string
    basePath?: string
    env?: Record<string, string | undefined>
    onLine?: (stream: 'stdout' | 'stderr', line: string) => void
  },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const env = {
    ...process.env,
    ...opts.env,
    SHOGO_BASE_PATH: opts.basePath || '/',
    CI: '1',
  }
  let stderrTail = ''
  const exitCode = await new Promise<number | null>((resolveExit) => {
    let proc: ChildProcess
    try {
      proc =
        plan.kind === 'astro'
          ? spawn(plan.cmd, plan.args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
          : spawn(plan.command, { cwd, env, shell: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err: any) {
      stderrTail = err?.message ?? String(err)
      resolveExit(null)
      return
    }
    const timer = setTimeout(() => {
      stderrTail += `\nbuild timed out after ${BUILD_TIMEOUT_MS / 60_000} minutes`
      try { proc.kill('SIGKILL') } catch {}
    }, BUILD_TIMEOUT_MS)
    proc.stdout?.on('data', (chunk: Buffer) => opts.onLine?.('stdout', chunk.toString().trim()))
    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim()
      opts.onLine?.('stderr', text)
      stderrTail = (stderrTail + '\n' + text).slice(-4000)
    })
    proc.on('error', (err) => {
      clearTimeout(timer)
      stderrTail += `\n${err.message}`
      resolveExit(null)
    })
    proc.on('exit', (code) => {
      clearTimeout(timer)
      resolveExit(code)
    })
  })

  if (exitCode !== 0) {
    const tail = stderrTail.trim().slice(-500)
    return { ok: false, error: `Build failed (${plan.label} exited with code ${exitCode}).${tail ? ` ${tail}` : ''}` }
  }

  if (plan.kind === 'command') {
    const out = join(cwd, plan.outDir)
    if (!existsSync(join(out, 'index.html'))) {
      return { ok: false, error: `Build finished but ${plan.outDir}/index.html was not produced` }
    }
    try {
      cpSync(out, join(cwd, opts.stagingDir), { recursive: true })
    } catch (err: any) {
      return { ok: false, error: `Could not stage ${plan.outDir}/: ${err?.message ?? err}` }
    }
  } else if (!existsSync(join(cwd, opts.stagingDir, 'index.html'))) {
    return { ok: false, error: 'Build finished but did not produce index.html' }
  }
  return { ok: true }
}

const ALWAYS_IGNORED = ['node_modules', '.git', '.shogo', '.astro', '.cache', 'dist']

/**
 * Call `onChange` (debounced) when a source file changes. Build output and
 * tool caches are ignored so a build never retriggers itself.
 */
export function watchStaticSources(
  cwd: string,
  opts: { ignore?: string[]; debounceMs?: number },
  onChange: () => void,
): () => void {
  const ignored = new Set([...ALWAYS_IGNORED, ...(opts.ignore ?? [])])
  let timer: ReturnType<typeof setTimeout> | null = null
  let watcher: FSWatcher
  try {
    watcher = watch(cwd, { recursive: true }, (_event, filename) => {
      if (!filename) return
      const top = String(filename).split(/[\\/]/)[0]
      if (ignored.has(top) || top.startsWith('dist.')) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        onChange()
      }, opts.debounceMs ?? 800)
    })
  } catch (err: any) {
    console.warn(`[static-build] could not watch ${cwd} for changes: ${err?.message ?? err}`)
    return () => {}
  }
  watcher.on('error', () => {})
  return () => {
    if (timer) clearTimeout(timer)
    try { watcher.close() } catch {}
  }
}
