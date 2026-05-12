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
import { existsSync, readlinkSync, lstatSync } from 'node:fs'
import { isAbsolute, join, resolve as resolvePath, dirname } from 'node:path'

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

let _unixNodeAvailable: boolean | null = null

/**
 * True if a `node` binary is on PATH (Unix-style search). The Shogo
 * Desktop API process is spawned by Electron with a PATH inherited
 * from `launchctl`, which on macOS frequently EXCLUDES the user's
 * shell-managed paths (Homebrew, nvm, asdf). `process.env.PATH` is
 * what child spawns see when they exec a `#!/usr/bin/env node` shim,
 * so this is the right thing to check.
 *
 * Cached for the lifetime of the process — node-install state doesn't
 * change between project opens, and re-walking PATH on every spawn
 * adds up.
 *
 * Pass an explicit `pathEnv` only from tests; production callers should
 * use the default.
 */
export function isNodeAvailableOnUnix(pathEnv: string | undefined = process.env.PATH): boolean {
  if (process.platform === 'win32') return false
  if (pathEnv === process.env.PATH && _unixNodeAvailable !== null) return _unixNodeAvailable
  let found = false
  if (pathEnv) {
    for (const dir of pathEnv.split(':')) {
      if (!dir) continue
      if (existsSync(join(dir, 'node'))) { found = true; break }
    }
  }
  if (pathEnv === process.env.PATH) _unixNodeAvailable = found
  return found
}

/** Reset the cached node-availability probe — only used by tests. */
export function _resetUnixNodeCache(): void { _unixNodeAvailable = null }

/**
 * Resolve a `node_modules/.bin/<name>` invocation that works whether
 * or not a system `node` is on PATH.
 *
 * Why this exists: npm publishes its `.bin/<tool>` shims with
 * `#!/usr/bin/env node` at the top of the underlying JS file. The
 * kernel reads the shebang and tries to exec `/usr/bin/env node`;
 * if `node` isn't on PATH the exec fails with `env: node: No such
 * file or directory` and the spawn exits 127. Shogo Desktop ships
 * the bundled `bun` runtime but does not bundle Node.js, and many
 * end-user macOS PATHs (launchctl-default) don't expose any
 * shell-installed node either — so every `spawn(.bin/vite, ...)`
 * fails on first use. Observed in main.log:
 *   [CanvasBuildManager] Build error: env: node: No such file or directory
 *   [preview-manager] Vite build --watch exited (code=127, signal=null)
 *
 * Returns `null` if the shim doesn't exist (caller should treat
 * this exactly like the historical `existsSync(viteBin)` no-op
 * path). Otherwise returns `{ cmd, argsPrefix }`:
 *   - On Windows, or when `node` is on PATH: the shim itself with
 *     no prefix args (preserves the current behavior — fastest path).
 *   - When node is missing on Unix: `readlinkSync` resolves the shim
 *     to its underlying `.../bin/<tool>.js`, and we route through
 *     the bundled `bun` (`{ cmd: bunBinary, argsPrefix: [jsEntry] }`),
 *     which executes the JS directly and treats the shebang as a
 *     comment. Bun's CLI compatibility is a superset of node for
 *     the bundler tools we ship (vite, expo) — same exit codes,
 *     same flag parsing.
 */
export function resolveBinInvocation(
  workspaceDir: string,
  binName: string,
): { cmd: string; argsPrefix: string[] } | null {
  const binDir = join(workspaceDir, 'node_modules', '.bin')
  const isWindows = process.platform === 'win32'
  const candidates = isWindows
    ? [join(binDir, `${binName}.CMD`), join(binDir, `${binName}.cmd`), join(binDir, `${binName}.exe`)]
    : [join(binDir, binName)]
  const shim = candidates.find((p) => existsSync(p))
  if (!shim) return null

  // Windows .CMD shims are batch files that resolve node themselves;
  // they're outside this fix's scope.
  if (isWindows) return { cmd: shim, argsPrefix: [] }

  if (isNodeAvailableOnUnix()) return { cmd: shim, argsPrefix: [] }

  // Node missing — readlink the shim and route through bundled bun.
  // If the shim isn't a symlink (some installs write wrapper scripts
  // instead — bun's hardlink-fallback mode can do this), fall back
  // to direct invocation; that path will still fail with code 127 but
  // we've done what we can.
  try {
    const st = lstatSync(shim)
    if (!st.isSymbolicLink()) return { cmd: shim, argsPrefix: [] }
    const target = readlinkSync(shim)
    const jsEntry = isAbsolute(target) ? target : resolvePath(dirname(shim), target)
    if (!existsSync(jsEntry)) return { cmd: shim, argsPrefix: [] }
    const bun = process.env.SHOGO_BUN_PATH || 'bun'
    return { cmd: bun, argsPrefix: [jsEntry] }
  } catch {
    return { cmd: shim, argsPrefix: [] }
  }
}

export interface PkgExecOptions {
  timeout?: number
  stdio?: StdioOptions
  env?: NodeJS.ProcessEnv
  /** Use `bunx --bun` instead of plain `bunx` (needed for some tools). */
  useBunFlag?: boolean
}

const IS_WINDOWS = process.platform === 'win32'
// 60s was not enough for a cold `bun install` over a 9p-mounted /workspace
// inside the desktop's Linux guest VM — production logs show every cold
// boot hitting "bun install timed out after 60s" and leaving a half-deleted
// node_modules behind (which then poisons the next preview run with
// ENOENT for @prisma/internals etc.). Bump to 5 min and let env override.
const DEFAULT_INSTALL_TIMEOUT = parseInt(
  process.env.SHOGO_INSTALL_TIMEOUT_MS || (IS_WINDOWS ? '300000' : '300000'),
  10,
)
const DEFAULT_EXEC_TIMEOUT = 60_000

export class PlatformPackageManager {
  readonly isWindows = IS_WINDOWS

  /** Resolved path to the bun binary — prefers SHOGO_BUN_PATH (set by desktop app) over bare `bun`. */
  get bunBinary(): string {
    return process.env.SHOGO_BUN_PATH || 'bun'
  }

  private shellOpt(): string | boolean | undefined {
    // On Windows we used to return the bare string 'cmd.exe' here, but
    // Bun's child_process can fail to resolve that name and crash with
    // `Executable not found in $PATH: "cmd.exe"` even when System32 is
    // on PATH. Returning `true` lets Node/Bun pick the platform default
    // shell via `process.env.ComSpec`, which is always an absolute path
    // (e.g. `C:\Windows\System32\cmd.exe`) and works regardless of how
    // PATH happens to be cased in the inherited environment.
    return IS_WINDOWS ? true : undefined
  }

  private spawnEnv(base?: NodeJS.ProcessEnv): Record<string, string> {
    const source = base ?? process.env
    const env: Record<string, string> = {}
    // Windows env keys are case-insensitive at the OS level, but a plain
    // spread of `process.env` preserves whatever casing Bun/Node used
    // internally. On Windows-Bun that ends up as `Path`, so a later
    // `env.PATH = ...` assignment creates a *second* key — and the child
    // process inherits both, with Bun picking the lexicographically-later
    // `PATH` (containing only what we just set, missing System32). The
    // visible symptom is `Executable not found in $PATH: "cmd.exe"`.
    //
    // Normalise on the way in: collapse all PATH-like keys into a single
    // canonical `PATH`, dropping the duplicates so spawn() sees one entry.
    let pathValue = ''
    for (const [k, v] of Object.entries(source)) {
      if (v === undefined) continue
      if (IS_WINDOWS && k.toLowerCase() === 'path') {
        if (v) pathValue = v
        continue
      }
      env[k] = v
    }
    if (IS_WINDOWS) {
      const nodePath = 'C:\\Program Files\\nodejs'
      env.PATH = pathValue.includes(nodePath)
        ? pathValue
        : `${nodePath};${pathValue}`
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
  // Exec — async variant that DOES NOT block the JS event loop.
  //
  // The sync variant above is fine for one-shot project scaffolding
  // (template.copy.ts) where blocking is intentional. Inside the runtime's
  // hot path (PreviewManager.runPrismaIfNeeded → /pool/assign) it caused
  // a measured ~4.7s freeze of /pool/assign in staging because prisma's
  // child process held the event loop for the full duration. Always
  // prefer this variant in long-lived services.
  // ---------------------------------------------------------------------------

  async execToolAsync(
    tool: string,
    args: string[],
    cwd: string,
    opts?: PkgExecOptions,
  ): Promise<string> {
    const timeout = opts?.timeout ?? DEFAULT_EXEC_TIMEOUT
    const stdio = opts?.stdio ?? 'pipe'
    const env = this.spawnEnv(opts?.env)

    // Skip the shell on Unix so we can spawn `bun x <tool> <args>` directly
    // and reliably collect stdout/stderr. On Windows we still route through
    // the shell so `npx.cmd` resolution behaves the same as execToolSync.
    let cmd: string
    let argv: string[]
    let useShell: boolean
    if (IS_WINDOWS) {
      const argStr = args.length > 0 ? ` ${args.join(' ')}` : ''
      cmd = `npx ${tool}${argStr}`
      argv = []
      useShell = true
    } else {
      cmd = this.bunBinary
      argv = ['x']
      if (opts?.useBunFlag) argv.push('--bun')
      argv.push(tool, ...args)
      useShell = false
    }

    return new Promise<string>((resolvePromise, rejectPromise) => {
      const proc = spawn(cmd, argv, {
        cwd,
        env,
        stdio,
        shell: useShell ? (this.shellOpt() as boolean) : false,
      })
      let stdout = ''
      let stderr = ''
      // stdio may be 'inherit', in which case stdout/stderr are null. Only
      // wire data handlers when piped so we don't crash on undefined.
      proc.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
      proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })

      const timer = setTimeout(() => {
        try { proc.kill('SIGKILL') } catch { /* already dead */ }
        rejectPromise(
          new Error(`${tool} ${args.join(' ')} timed out after ${timeout}ms`),
        )
      }, timeout)

      proc.on('error', (err) => {
        clearTimeout(timer)
        rejectPromise(err)
      })
      proc.on('exit', (code) => {
        clearTimeout(timer)
        if (code === 0) {
          resolvePromise(stdout)
        } else {
          const errMsg = stderr.trim() || stdout.trim() || `exit ${code}`
          rejectPromise(new Error(`${tool} ${args.join(' ')} failed: ${errMsg}`))
        }
      })
    })
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

  // Async siblings of the prisma wrappers above. Use these from any
  // long-running service (runtime, agent gateway, preview manager) so a
  // 1-3s prisma child process doesn't freeze /health, /pool/assign, or
  // other concurrent HTTP work. Same arg shape, same timeout defaults.
  async prismaGenerateAsync(cwd: string, opts?: PkgExecOptions): Promise<void> {
    await this.execToolAsync('prisma', ['generate'], cwd, {
      timeout: opts?.timeout ?? 30_000,
      stdio: opts?.stdio,
      env: opts?.env,
    })
  }

  async prismaDbPushAsync(
    cwd: string,
    opts?: PkgExecOptions & { acceptDataLoss?: boolean },
  ): Promise<void> {
    const args = ['db', 'push']
    if (opts?.acceptDataLoss) args.push('--accept-data-loss')
    await this.execToolAsync('prisma', args, cwd, {
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
