// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * CanvasBuildManager — Runs `bun run build` in the workspace on file changes.
 *
 * Stack-aware: works for any first-party stack whose package.json exposes a
 * `build` script and whose bundler binary is in `node_modules/.bin/`.
 *
 * Concretely today:
 *   - Vite stacks (`react-app`, `threejs-game`, `phaser-game`) — `vite build`
 *     produces `dist/`.
 *   - Metro stacks (`expo-app`, `expo-three`) — `expo export --platform web
 *     --output-dir dist` produces `dist/` containing the react-native-web
 *     rendering of the app.
 *
 * In both cases we just run `bun run build` and let package.json drive the
 * actual command. The only thing this manager checks is that *some* known
 * bundler binary is present, so we don't fire `bun run build` against a
 * fresh workspace where nothing has installed yet.
 *
 * Builds are debounced so rapid file writes don't cause build storms.
 */

import { spawn, type ChildProcess } from 'child_process'
import { join } from 'path'
import { existsSync } from 'fs'

const BUILD_DEBOUNCE_MS = 500
const LOG_PREFIX = '[CanvasBuildManager]'

/**
 * Bundler binaries we know how to drive via `bun run build`. The first one
 * we find under `node_modules/.bin/` is enough to consider the workspace
 * buildable. Order doesn't matter — they're not exclusive (an Expo app
 * could in principle have vite for a tooling sidecar).
 */
const KNOWN_BUNDLER_BINS = ['vite', 'expo'] as const

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

  isReady(): boolean {
    return this._started && existsSync(join(this.outDir, 'index.html'))
  }

  getOutDir(): string {
    return this.outDir
  }

  /** True if we can find a bundler binary under `node_modules/.bin/`. */
  private hasBundlerBin(): boolean {
    const binDir = join(this.workspaceDir, 'node_modules', '.bin')
    return KNOWN_BUNDLER_BINS.some((b) => existsSync(join(binDir, b)))
  }

  private async runBuild(): Promise<void> {
    if (this.building) {
      this.pendingBuild = true
      return
    }

    if (!existsSync(join(this.workspaceDir, 'package.json'))) {
      return
    }
    if (!this.hasBundlerBin()) {
      return
    }

    this.building = true

    try {
      await new Promise<void>((resolve, reject) => {
        const bunBin = process.env.SHOGO_BUN_PATH || 'bun'
        const proc: ChildProcess = spawn(bunBin, ['run', 'build'], {
          cwd: this.workspaceDir,
          stdio: ['ignore', 'pipe', 'pipe'],
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

      this.buildCount++
      console.log(`${LOG_PREFIX} Build #${this.buildCount} complete → ${this.outDir}`)
      this.callbacks.onBuildComplete()
    } catch (err: any) {
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
