// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * CanvasBuildManager — Runs `vite build` in the workspace on file changes.
 *
 * The workspace is a standard Vite + React app (from runtime-template).
 * We just run `bun run build` in the workspace directory, then notify
 * subscribers (SSE) to trigger an iframe reload.
 *
 * Builds are debounced so rapid file writes don't cause build storms.
 */

import { spawn, type ChildProcess } from 'child_process'
import { join } from 'path'
import { existsSync } from 'fs'

const BUILD_DEBOUNCE_MS = 500
const LOG_PREFIX = '[CanvasBuildManager]'

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

  private async runBuild(): Promise<void> {
    if (this.building) {
      this.pendingBuild = true
      return
    }

    if (!existsSync(join(this.workspaceDir, 'package.json'))) {
      return
    }
    if (!existsSync(join(this.workspaceDir, 'node_modules', '.bin', 'vite'))) {
      return
    }

    this.building = true

    try {
      await new Promise<void>((resolve, reject) => {
        const proc: ChildProcess = spawn('bun', ['run', 'build'], {
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
