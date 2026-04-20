// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * PlatformPackageManager — centralises Windows vs Unix differences for
 * package-manager operations (install, exec, prisma, etc.).
 *
 * On Windows Bun 1.x creates empty node_modules stubs (hardlink bug),
 * so we fall back to npm for installs and npx for tool execution.
 */

import { execSync as nodeExecSync, spawn, type StdioOptions } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export interface PkgInstallOptions {
  timeout?: number
  stdio?: StdioOptions
  env?: NodeJS.ProcessEnv
  /** Attempt --frozen-lockfile first, fall back to plain install (bun only). */
  frozen?: boolean
}

/** Error thrown when the Windows Node.js prerequisite is missing. */
export class NodeMissingError extends Error {
  readonly code = 'NODE_NOT_INSTALLED' as const
  constructor() {
    super(
      'Shogo Desktop on Windows requires Node.js 20+ to run project sandboxes. ' +
        'npm.cmd was not found on PATH and is not present at C:\\Program Files\\nodejs\\. ' +
        'Install Node.js from https://nodejs.org/ (LTS recommended), then restart Shogo.',
    )
    this.name = 'NodeMissingError'
  }
}

const WINDOWS_NODE_DIR = 'C:\\Program Files\\nodejs'

/**
 * True if npm.cmd can be located via PATH or the standard Windows install dir.
 * Cheap — only a single existsSync + PATH walk — so safe to call from hot paths.
 * Always returns true on non-Windows (bun is used there).
 */
export function isNodeAvailableOnWindows(pathEnv: string | undefined = process.env.PATH): boolean {
  if (process.platform !== 'win32') return true
  if (existsSync(join(WINDOWS_NODE_DIR, 'npm.cmd'))) return true
  if (!pathEnv) return false
  for (const dir of pathEnv.split(';')) {
    if (dir && existsSync(join(dir, 'npm.cmd'))) return true
  }
  return false
}

export interface PkgExecOptions {
  timeout?: number
  stdio?: StdioOptions
  env?: NodeJS.ProcessEnv
  /** Use `bunx --bun` instead of plain `bunx` (needed for some tools). */
  useBunFlag?: boolean
}

const IS_WINDOWS = process.platform === 'win32'
const DEFAULT_INSTALL_TIMEOUT = IS_WINDOWS ? 120_000 : 60_000
const DEFAULT_EXEC_TIMEOUT = 60_000

export class PlatformPackageManager {
  readonly isWindows = IS_WINDOWS

  /** Resolved path to the bun binary — prefers SHOGO_BUN_PATH (set by desktop app) over bare `bun`. */
  get bunBinary(): string {
    return process.env.SHOGO_BUN_PATH || 'bun'
  }

  private shellOpt(): boolean | undefined {
    return IS_WINDOWS ? true : undefined
  }

  private spawnEnv(base?: NodeJS.ProcessEnv): Record<string, string> {
    const env = { ...(base ?? process.env) } as Record<string, string>
    if (IS_WINDOWS) {
      const nodePath = 'C:\\Program Files\\nodejs'
      if (!env.PATH?.includes(nodePath)) {
        env.PATH = `${nodePath};${env.PATH || ''}`
      }
    }
    return env
  }

  // ---------------------------------------------------------------------------
  // Install — synchronous
  // ---------------------------------------------------------------------------

  installSync(cwd: string, opts?: PkgInstallOptions): void {
    const timeout = opts?.timeout ?? DEFAULT_INSTALL_TIMEOUT
    const stdio = opts?.stdio ?? 'pipe'
    const env = this.spawnEnv(opts?.env)

    if (IS_WINDOWS) {
      if (!isNodeAvailableOnWindows(env.PATH)) throw new NodeMissingError()
      try {
        nodeExecSync('npm.cmd install --loglevel=error', {
          cwd, timeout, stdio, env, shell: true,
        })
      } catch (err: any) {
        throw wrapWindowsNpmError(err) ?? err
      }
    } else {
      const bun = this.bunBinary
      if (opts?.frozen) {
        try {
          nodeExecSync(`"${bun}" install --frozen-lockfile 2>&1`, { cwd, timeout, stdio, env })
          return
        } catch {
          // fall through to plain install
        }
      }
      nodeExecSync(`"${bun}" install`, { cwd, timeout, stdio, env })
    }
  }

  // ---------------------------------------------------------------------------
  // Install — async with spawn (used by RuntimeManager)
  // ---------------------------------------------------------------------------

  installAsync(cwd: string, opts?: PkgInstallOptions): Promise<void> {
    const timeout = opts?.timeout ?? DEFAULT_INSTALL_TIMEOUT
    const env = this.spawnEnv(opts?.env)
    const cmd = IS_WINDOWS ? 'npm.cmd' : this.bunBinary
    const args = IS_WINDOWS ? ['install', '--loglevel=error'] : ['install']

    if (IS_WINDOWS && !isNodeAvailableOnWindows(env.PATH)) {
      return Promise.reject(new NodeMissingError())
    }

    return new Promise<void>((resolve, reject) => {
      const proc = spawn(cmd, args, {
        cwd,
        stdio: 'pipe',
        env,
        shell: IS_WINDOWS,
      })

      const timer = setTimeout(() => {
        proc.kill()
        reject(new Error(`${cmd} install timed out after ${timeout / 1000}s`))
      }, timeout)

      let stderr = ''
      proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })

      proc.on('exit', (code) => {
        clearTimeout(timer)
        if (code === 0) return resolve()
        // Windows cmd.exe prints "not recognized" when npm.cmd is missing,
        // even though we preflight above — handle the race where the user
        // uninstalled Node while Shogo was running.
        if (IS_WINDOWS && /not recognized as an internal or external command/i.test(stderr)) {
          return reject(new NodeMissingError())
        }
        reject(new Error(`${cmd} install exited with code ${code}\n${stderr}`))
      })

      proc.on('error', (err: NodeJS.ErrnoException) => {
        clearTimeout(timer)
        if (IS_WINDOWS && err.code === 'ENOENT') return reject(new NodeMissingError())
        reject(err)
      })
    })
  }

  // ---------------------------------------------------------------------------
  // Exec — run an npx/bunx tool synchronously
  // ---------------------------------------------------------------------------

  execToolSync(
    tool: string,
    args: string[],
    cwd: string,
    opts?: PkgExecOptions,
  ): string {
    const timeout = opts?.timeout ?? DEFAULT_EXEC_TIMEOUT
    const stdio = opts?.stdio ?? 'pipe'
    const env = this.spawnEnv(opts?.env)

    const argStr = args.length > 0 ? ` ${args.join(' ')}` : ''
    const bun = this.bunBinary
    const cmd = IS_WINDOWS
      ? `npx ${tool}${argStr}`
      : `"${bun}" x ${opts?.useBunFlag ? '--bun ' : ''}${tool}${argStr}`

    return nodeExecSync(cmd, {
      cwd, timeout, stdio, env,
      shell: this.shellOpt(),
      encoding: 'utf-8',
    }) as unknown as string
  }

  // ---------------------------------------------------------------------------
  // Prisma convenience wrappers
  // ---------------------------------------------------------------------------

  prismaGenerate(cwd: string, opts?: PkgExecOptions): void {
    this.execToolSync('prisma', ['generate'], cwd, {
      timeout: opts?.timeout ?? 30_000,
      stdio: opts?.stdio,
      env: opts?.env,
    })
  }

  prismaDbPush(cwd: string, opts?: PkgExecOptions & { acceptDataLoss?: boolean }): void {
    const args = ['db', 'push']
    if (opts?.acceptDataLoss) args.push('--accept-data-loss')
    this.execToolSync('prisma', args, cwd, {
      timeout: opts?.timeout ?? DEFAULT_EXEC_TIMEOUT,
      stdio: opts?.stdio,
      env: opts?.env,
    })
  }
}

/**
 * Translate the cryptic cmd.exe "not recognized" message emitted when
 * npm.cmd is missing into a typed NodeMissingError. Returns null if the
 * error doesn't look like a missing-node problem so the caller can rethrow.
 */
function wrapWindowsNpmError(err: any): NodeMissingError | null {
  if (!IS_WINDOWS) return null
  const blob = `${err?.stderr?.toString?.() ?? ''}\n${err?.stdout?.toString?.() ?? ''}\n${err?.message ?? ''}`
  if (/not recognized as an internal or external command/i.test(blob)) {
    return new NodeMissingError()
  }
  if (err?.code === 'ENOENT') return new NodeMissingError()
  return null
}

/** Singleton — most consumers just need one. */
export const pkg = new PlatformPackageManager()
