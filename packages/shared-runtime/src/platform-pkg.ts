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

export interface PkgInstallOptions {
  timeout?: number
  stdio?: StdioOptions
  env?: NodeJS.ProcessEnv
  /** Attempt --frozen-lockfile first, fall back to plain install (bun only). */
  frozen?: boolean
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
      nodeExecSync('npm.cmd install --loglevel=error', {
        cwd, timeout, stdio, env, shell: true,
      })
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
        if (code === 0) resolve()
        else reject(new Error(`${cmd} install exited with code ${code}\n${stderr}`))
      })

      proc.on('error', (err) => {
        clearTimeout(timer)
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

/** Singleton — most consumers just need one. */
export const pkg = new PlatformPackageManager()
