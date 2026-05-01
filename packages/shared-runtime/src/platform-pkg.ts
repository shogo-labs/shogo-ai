// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * PlatformPackageManager — centralises Windows vs Unix differences for
 * package-manager operations (install, exec, prisma, etc.).
 *
 * On Windows Bun 1.x's default hardlink backend can leave empty package
 * directories in `node_modules/` (most visibly under transitive deps
 * like `whatwg-url` → `webidl-conversions`, which then crashes any
 * `expo export` / Vite build that imports them). We mitigate by
 * preferring `npm.cmd` for installs when Node.js is on PATH; if it
 * isn't (Shogo Desktop ships its own bun but not Node), we fall back
 * to `bun install --backend=copyfile` which sidesteps the hardlink
 * path entirely. The trade-off is a slower install vs. a half-broken
 * `node_modules` that fails downstream commands without explanation.
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

  private shellOpt(): string | undefined {
    return IS_WINDOWS ? 'cmd.exe' : undefined
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
      if (isNodeAvailableOnWindows(env.PATH)) {
        try {
          nodeExecSync('npm.cmd install --loglevel=error', {
            cwd, timeout, stdio, env, shell: 'cmd.exe',
          })
          return
        } catch (err: any) {
          // If the failure is "npm not found at runtime" (race: user
          // uninstalled Node mid-session), fall through to bun. Any
          // other npm error is a real install problem — rethrow it.
          const wrapped = wrapWindowsNpmError(err)
          if (!wrapped) throw err
          // wrapped is NodeMissingError → fall through to bun fallback.
        }
      }
      // npm unavailable (or vanished mid-run) → bun with --backend=copyfile
      // to avoid the Windows hardlink bug that produces empty package
      // dirs (the original reason we preferred npm here in the first
      // place). Slower than hardlink, but the install actually
      // *completes correctly* with no Node.js prerequisite.
      this.installSyncBunCopyfile(cwd, opts)
      return
    }

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

  /**
   * Windows-only fallback path: `bun install [--frozen-lockfile]
   * --backend=copyfile`. Used when npm.cmd isn't available on PATH
   * (typically: Shogo Desktop bundles bun but the user didn't install
   * Node.js separately).
   *
   * The `--backend=copyfile` flag forces bun to copy package contents
   * into `node_modules/` instead of hardlinking from
   * `~/.bun/install/cache`. Hardlinks are bun's default for speed but
   * fail in confusing ways on Windows (the destination directory gets
   * created but ends up empty, and downstream `require('webidl-conversions')`
   * etc. then crash with MODULE_NOT_FOUND). See bun#10327 / #28653.
   */
  private installSyncBunCopyfile(cwd: string, opts?: PkgInstallOptions): void {
    const timeout = opts?.timeout ?? DEFAULT_INSTALL_TIMEOUT
    const stdio = opts?.stdio ?? 'pipe'
    const env = this.spawnEnv(opts?.env)
    const bun = this.bunBinary
    console.warn(
      '[platform-pkg] Node.js / npm.cmd not found on PATH — falling back to ' +
        '`bun install --backend=copyfile` (Shogo Desktop bundle path). ' +
        'This is slower than hardlink but avoids the Windows extract bug.',
    )
    if (opts?.frozen) {
      try {
        nodeExecSync(`"${bun}" install --frozen-lockfile --backend=copyfile`, {
          cwd, timeout, stdio, env,
        })
        return
      } catch {
        // fall through to plain install (lockfile might be stale)
      }
    }
    nodeExecSync(`"${bun}" install --backend=copyfile`, { cwd, timeout, stdio, env })
  }

  // ---------------------------------------------------------------------------
  // Install — async with spawn (used by RuntimeManager)
  // ---------------------------------------------------------------------------

  installAsync(cwd: string, opts?: PkgInstallOptions): Promise<void> {
    if (IS_WINDOWS) {
      const env = this.spawnEnv(opts?.env)
      if (isNodeAvailableOnWindows(env.PATH)) {
        return this.installAsyncWindowsNpm(cwd, opts).catch((err) => {
          // npm install failed — if it was specifically "npm.cmd missing"
          // (race), retry through the bun fallback path. Any other error
          // is a real install problem and should bubble up.
          if (err instanceof NodeMissingError) {
            return this.installAsyncBunCopyfile(cwd, opts)
          }
          throw err
        })
      }
      return this.installAsyncBunCopyfile(cwd, opts)
    }
    return this.installAsyncBun(cwd, opts)
  }

  private installAsyncWindowsNpm(cwd: string, opts?: PkgInstallOptions): Promise<void> {
    const timeout = opts?.timeout ?? DEFAULT_INSTALL_TIMEOUT
    const env = this.spawnEnv(opts?.env)
    const cmd = 'npm.cmd'
    const args = ['install', '--loglevel=error']
    return new Promise<void>((resolve, reject) => {
      const proc = spawn(cmd, args, {
        cwd,
        stdio: 'pipe',
        env,
        shell: true,
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
        if (/not recognized as an internal or external command/i.test(stderr)) {
          return reject(new NodeMissingError())
        }
        reject(new Error(`${cmd} install exited with code ${code}\n${stderr}`))
      })
      proc.on('error', (err: NodeJS.ErrnoException) => {
        clearTimeout(timer)
        if (err.code === 'ENOENT') return reject(new NodeMissingError())
        reject(err)
      })
    })
  }

  private installAsyncBunCopyfile(cwd: string, opts?: PkgInstallOptions): Promise<void> {
    console.warn(
      '[platform-pkg] Node.js / npm.cmd not found on PATH — falling back to ' +
        '`bun install --backend=copyfile` (Shogo Desktop bundle path).',
    )
    return this.installAsyncBun(cwd, opts, ['--backend=copyfile'])
  }

  private installAsyncBun(
    cwd: string,
    opts?: PkgInstallOptions,
    extraArgs: string[] = [],
  ): Promise<void> {
    const timeout = opts?.timeout ?? DEFAULT_INSTALL_TIMEOUT
    const env = this.spawnEnv(opts?.env)
    const bun = this.bunBinary
    const baseArgs = ['install', ...extraArgs]
    const frozenArgs = opts?.frozen ? ['install', '--frozen-lockfile', ...extraArgs] : null

    const runOnce = (args: string[]): Promise<{ ok: boolean; stderr: string }> =>
      new Promise<{ ok: boolean; stderr: string }>((resolve, reject) => {
        const proc = spawn(bun, args, {
          cwd,
          stdio: 'pipe',
          env,
        })
        const timer = setTimeout(() => {
          proc.kill()
          reject(new Error(`bun ${args.join(' ')} timed out after ${timeout / 1000}s`))
        }, timeout)
        let stderr = ''
        proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
        proc.stdout?.on('data', () => { /* drain */ })
        proc.on('exit', (code) => {
          clearTimeout(timer)
          resolve({ ok: code === 0, stderr })
        })
        proc.on('error', (err) => {
          clearTimeout(timer)
          reject(err)
        })
      })

    const run = async () => {
      if (frozenArgs) {
        const first = await runOnce(frozenArgs)
        if (first.ok) return
        // Lockfile out of date / missing — retry without --frozen-lockfile.
        // Mirrors the legacy ensureWorkspaceDeps fallback: we'd rather
        // produce a working node_modules than insist on the lockfile.
      }
      const second = await runOnce(baseArgs)
      if (!second.ok) {
        throw new Error(`bun install failed: ${second.stderr}`)
      }
    }

    return run()
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
