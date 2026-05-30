// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Thin wrapper around the user's installed `git` CLI. Every git invocation
// in Shogo Desktop goes through `runGit(cwd, args)` so we have a single
// place to enforce timeouts, redact secrets, and observe slow commands.
//
// We deliberately do NOT use simple-git, isomorphic-git, or nodegit. See
// the TODO card on the canvas for the rationale: shelling out matches VS
// Code/Cursor exactly, reuses the user's git config + credential helper +
// LFS + submodules + hooks for free, and `--porcelain=v2 -z` is a stable
// machine-readable contract we can parse without a dependency.

import { spawn } from 'node:child_process'

export type RunGitResult =
  | { ok: true; stdout: string; stderr: string; code: 0 }
  | { ok: false; stdout: string; stderr: string; code: number; signal: NodeJS.Signals | null }

export interface RunGitOptions {
  /** Working directory the git command runs in. Required. */
  cwd: string
  /** Hard timeout (ms). Defaults to 15 s. */
  timeoutMs?: number
  /** Stdin string to feed the child. Defaults to none. */
  stdin?: string
  /** Extra env vars layered on top of `process.env`. */
  env?: NodeJS.ProcessEnv
  /** Max bytes of stdout to retain. Defaults to 32 MB. */
  maxStdoutBytes?: number
}

const DEFAULT_TIMEOUT = 15_000
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024

/**
 * Run `git <args>` in `cwd`. Resolves with a result envelope — callers
 * inspect `ok` instead of catching. Never throws on a non-zero exit.
 */
export function runGit(args: string[], options: RunGitOptions): Promise<RunGitResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT
  const maxBytes = options.maxStdoutBytes ?? DEFAULT_MAX_BYTES

  return new Promise((resolve) => {
    const child = spawn('git', args, {
      cwd: options.cwd,
      // Inherit shell PATH so the user's git is found. Layer optional env.
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', ...options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let stdoutBytes = 0
    let timedOut = false

    const onTimeout = setTimeout(() => {
      timedOut = true
      try {
        child.kill('SIGKILL')
      } catch { /* ignore */ }
    }, timeoutMs)

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length
      if (stdoutBytes > maxBytes) {
        try { child.kill('SIGKILL') } catch { /* ignore */ }
        stderr += `\n[shogo-git] stdout exceeded ${maxBytes} bytes, truncating`
        return
      }
      // git porcelain -z output is NUL-delimited; we keep it as a string and
      // the parser handles the binary structure. UTF-8 is fine for paths.
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })

    child.on('error', (err) => {
      clearTimeout(onTimeout)
      resolve({
        ok: false,
        stdout,
        stderr: `${stderr}\n[shogo-git] spawn error: ${err.message}`,
        code: -1,
        signal: null,
      })
    })

    child.on('close', (code, signal) => {
      clearTimeout(onTimeout)
      if (timedOut) {
        resolve({
          ok: false,
          stdout,
          stderr: `${stderr}\n[shogo-git] timed out after ${timeoutMs}ms`,
          code: code ?? -1,
          signal,
        })
        return
      }
      if (code === 0) {
        resolve({ ok: true, stdout, stderr, code: 0 })
      } else {
        resolve({ ok: false, stdout, stderr, code: code ?? -1, signal })
      }
    })

    if (options.stdin) {
      child.stdin.write(options.stdin)
    }
    child.stdin.end()
  })
}

/**
 * Probe whether `git` is on PATH and modern enough for porcelain v2.
 * Resolves once on service boot; cached afterwards.
 */
let cachedProbe: Promise<GitProbe> | null = null
export interface GitProbe {
  available: boolean
  version: string | null
  /** True if version >= 2.11 (porcelain v2 + the `--branch` summary line). */
  supportsPorcelainV2: boolean
  error?: string
}
export function probeGit(): Promise<GitProbe> {
  if (cachedProbe) return cachedProbe
  cachedProbe = (async (): Promise<GitProbe> => {
    const res = await runGit(['--version'], { cwd: process.cwd(), timeoutMs: 5_000 })
    if (!res.ok) {
      return { available: false, version: null, supportsPorcelainV2: false, error: res.stderr || `exit ${res.code}` }
    }
    const m = /git version (\d+)\.(\d+)/.exec(res.stdout)
    if (!m) return { available: true, version: res.stdout.trim(), supportsPorcelainV2: false, error: 'unrecognized version string' }
    const major = Number.parseInt(m[1], 10)
    const minor = Number.parseInt(m[2], 10)
    const supports = major > 2 || (major === 2 && minor >= 11)
    return { available: true, version: `${major}.${minor}`, supportsPorcelainV2: supports }
  })()
  return cachedProbe
}

/** Reset the cached probe — only used in tests. */
export function _resetGitProbeForTests(): void {
  cachedProbe = null
}
