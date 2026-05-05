// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * CanvasBuildManager — Drives the workspace's web bundler on file changes.
 *
 * Stack-aware: works for any first-party stack whose bundler binary is in
 * `node_modules/.bin/`.
 *
 * Concretely today:
 *   - Vite stacks (`react-app`, `threejs-game`, `phaser-game`) — invokes
 *     `vite build --outDir dist.staging --emptyOutDir` and atomically
 *     swaps the result into `dist/`.
 *   - Metro stacks (`expo-app`, `expo-three`) — invokes
 *     `expo export --platform web --output-dir dist.staging` and atomically
 *     swaps the result into `dist/`.
 *
 * The historical implementation ran `bun run build` and let package.json
 * pick the command. That worked, but the templates' build scripts target
 * `dist/` directly — both `expo export` and `vite build` clear the output
 * dir before writing, so refreshes during a rebuild (and any failed
 * rebuild) left users staring at a 404. We now invoke the bundler
 * ourselves so we control the output dir and can promote it atomically;
 * see `build-output-commit.ts`.
 *
 * Builds are debounced so rapid file writes don't cause build storms.
 */

import { spawn, type ChildProcess } from 'child_process'
import { join } from 'path'
import { existsSync } from 'fs'
import {
  commitBuildOutput,
  cleanupStagingOutput,
  DEFAULT_STAGING_DIR,
} from './build-output-commit'

const BUILD_DEBOUNCE_MS = 500
const LOG_PREFIX = '[CanvasBuildManager]'

type BundlerKind = 'vite' | 'expo'

/**
 * Bundler binaries we know how to drive directly. The first one we
 * find under `node_modules/.bin/` decides the build command. Vite is
 * preferred over Expo when both happen to be present (a Vite app with
 * an Expo tooling sidecar, etc.) because the resulting `dist/` is what
 * the runtime serves.
 */
const KNOWN_BUNDLERS: readonly BundlerKind[] = ['vite', 'expo'] as const

export interface CanvasBuildCallbacks {
  onBuildComplete: () => void
  onBuildError: (error: string) => void
}

export class CanvasBuildManager {
  private workspaceDir: string
  private outDir: string
  private callbacks: CanvasBuildCallbacks
  private buildTimer: ReturnType<typeof setTimeout> | null = null
  private building = false
  private pendingBuild = false
  private buildCount = 0
  private _started = false

  constructor(
    workspaceDir: string,
    callbacks: CanvasBuildCallbacks,
  ) {
    this.workspaceDir = workspaceDir
    this.outDir = join(workspaceDir, 'dist')
    this.callbacks = callbacks
  }

  async start(): Promise<void> {
    await this.runBuild()
    this._started = true
  }

  triggerRebuild(): void {
    if (this.buildTimer) clearTimeout(this.buildTimer)
    this.buildTimer = setTimeout(() => {
      this.runBuild()
    }, BUILD_DEBOUNCE_MS)
  }

  get started(): boolean {
    return this._started
  }

  /** True while a build is in flight. Used by the runtime's static handler
   *  to render a "Building..." placeholder when neither `dist/` nor a
   *  prior build is available. */
  get isBuilding(): boolean {
    return this.building
  }

  isReady(): boolean {
    return this._started && existsSync(join(this.outDir, 'index.html'))
  }

  getOutDir(): string {
    return this.outDir
  }

  /**
   * Resolve the bundler binary to invoke. Picks the platform-correct
   * shim (`.CMD` on Windows, no-extension on POSIX) and returns the
   * first hit from `KNOWN_BUNDLERS`. Returns `null` when no known
   * bundler is installed.
   */
  private resolveBundler(): { kind: BundlerKind; bin: string } | null {
    const binDir = join(this.workspaceDir, 'node_modules', '.bin')
    const isWindows = process.platform === 'win32'
    for (const kind of KNOWN_BUNDLERS) {
      const candidates = isWindows
        ? [join(binDir, `${kind}.CMD`), join(binDir, `${kind}.cmd`), join(binDir, `${kind}.exe`)]
        : [join(binDir, kind)]
      const bin = candidates.find((p) => existsSync(p))
      if (bin) return { kind, bin }
    }
    return null
  }

  /**
   * Build args that route output into `dist.staging/` instead of
   * `dist/` so we can atomically swap on success. `--emptyOutDir` is
   * passed to Vite explicitly to suppress its "outDir outside project
   * root" warning when users seed exotic vite.config.ts setups.
   */
  private buildArgsFor(kind: BundlerKind): string[] {
    if (kind === 'vite') {
      return ['build', '--outDir', DEFAULT_STAGING_DIR, '--emptyOutDir']
    }
    return ['export', '--platform', 'web', '--output-dir', DEFAULT_STAGING_DIR]
  }

  private async runBuild(): Promise<void> {
    if (this.building) {
      this.pendingBuild = true
      return
    }

    if (!existsSync(join(this.workspaceDir, 'package.json'))) {
      return
    }
    const bundler = this.resolveBundler()
    if (!bundler) {
      return
    }

    this.building = true

    // Wipe any leftover staging dir from a prior crashed build so the
    // bundler starts from a clean slate.
    cleanupStagingOutput(this.workspaceDir, DEFAULT_STAGING_DIR)

    const isWindows = process.platform === 'win32'
    try {
      await new Promise<void>((resolve, reject) => {
        const proc: ChildProcess = spawn(bundler.bin, this.buildArgsFor(bundler.kind), {
          cwd: this.workspaceDir,
          stdio: ['ignore', 'pipe', 'pipe'],
          // `.CMD` shims must go through cmd.exe on Windows. Mirrors the
          // shape of the spawn calls in PreviewManager.
          shell: isWindows,
          env: {
            ...process.env,
            NODE_ENV: 'development',
            // Keep Expo non-interactive so a missing dep doesn't deadlock
            // the spawn waiting on stdin.
            CI: '1',
          },
        })

        let stderr = ''
        proc.stderr?.on('data', (chunk: Buffer) => {
          stderr += chunk.toString()
        })
        proc.stdout?.on('data', () => {})

        proc.on('close', (code) => {
          if (code === 0) resolve()
          else reject(new Error(stderr.trim() || `Build exited with code ${code}`))
        })
        proc.on('error', reject)
      })

      // Bundler succeeded — promote the staging dir into `dist/` atomically.
      // A swap failure (e.g. a locked file on Windows) is non-fatal: the
      // previous `dist/` keeps serving and the next rebuild will retry.
      const committed = commitBuildOutput(this.workspaceDir, DEFAULT_STAGING_DIR)
      if (!committed) {
        console.warn(
          `${LOG_PREFIX} Build succeeded but commit into dist/ failed — previous build remains live`,
        )
      }

      this.buildCount++
      console.log(`${LOG_PREFIX} Build #${this.buildCount} (${bundler.kind}) complete → ${this.outDir}`)
      this.callbacks.onBuildComplete()
    } catch (err: any) {
      // Failed build: drop the partial staging output so it doesn't
      // poison the next swap, and leave `dist/` untouched.
      cleanupStagingOutput(this.workspaceDir, DEFAULT_STAGING_DIR)
      console.error(`${LOG_PREFIX} Build error:`, err.message)
      this.callbacks.onBuildError(err.message)
    } finally {
      this.building = false
      if (this.pendingBuild) {
        this.pendingBuild = false
        this.runBuild()
      }
    }
  }

  stop(): void {
    if (this.buildTimer) {
      clearTimeout(this.buildTimer)
      this.buildTimer = null
    }
  }
}
