// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import electron from 'electron'
import type { UtilityProcess } from 'electron'
import path from 'path'
import crypto from 'crypto'
import { ExtensionInstallService, type ExtensionListItem } from './install-service'

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  startedAt: number
}

export interface RunningExtensionStatus {
  id: string
  active: boolean
  activationTimeMs?: number
  activationReason?: string
  crashCount: number
}

export class ExtensionHostManager {
  private child: UtilityProcess | null = null
  private ready = false
  private pending = new Map<string, PendingRequest>()
  private running = new Map<string, RunningExtensionStatus>()
  private crashCount = 0
  private workspaceRoot?: string

  constructor(private readonly installService: ExtensionInstallService) {}

  async executeCommand(commandId: string, args: unknown[] = [], workspaceRoot?: string): Promise<unknown> {
    await this.ensureStarted(workspaceRoot)
    const requestId = crypto.randomUUID()
    const result = await this.request(requestId, { type: 'executeCommand', requestId, commandId, args })
    return result
  }

  async activateEvent(event: string, workspaceRoot?: string): Promise<unknown> {
    await this.ensureStarted(workspaceRoot)
    const requestId = crypto.randomUUID()
    return await this.request(requestId, { type: 'activateEvent', requestId, event })
  }

  async getView(viewId: string, workspaceRoot?: string): Promise<unknown> {
    await this.ensureStarted(workspaceRoot)
    const requestId = crypto.randomUUID()
    return await this.request(requestId, { type: 'getView', requestId, viewId })
  }

  async restart(workspaceRoot?: string): Promise<{ restarted: boolean }> {
    await this.stop()
    this.installService.clearRestartRequired()
    await this.ensureStarted(workspaceRoot)
    return { restarted: true }
  }

  async stop(): Promise<void> {
    if (!this.child) return
    if (this.ready) {
      const requestId = crypto.randomUUID()
      try { await this.request(requestId, { type: 'deactivate', requestId }, 1500) } catch {}
    }
    this.child.kill()
    this.child = null
    this.ready = false
    this.pending.clear()
    this.running.clear()
  }

  getRunningExtensions(): RunningExtensionStatus[] {
    return [...this.running.values()]
  }

  private async ensureStarted(workspaceRoot?: string): Promise<void> {
    const targetWorkspace = workspaceRoot ?? this.workspaceRoot
    if (this.child && this.ready && this.workspaceRoot === targetWorkspace) return
    if (this.child && this.workspaceRoot !== targetWorkspace) await this.stop()
    this.workspaceRoot = targetWorkspace
    const child = electron.utilityProcess.fork(this.hostEntry(), [], { serviceName: 'shogo-extension-host' })
    this.child = child
    this.ready = false
    child.on('message', (message) => this.handleMessage(message))
    child.once('exit', () => {
      this.crashCount++
      this.child = null
      this.ready = false
      for (const request of this.pending.values()) request.reject(new Error('Extension host exited'))
      this.pending.clear()
    })
    child.postMessage({ type: 'init', workspaceRoot: targetWorkspace, extensions: this.extensionPayload(targetWorkspace) })
    await this.waitUntilReady()
  }

  private extensionPayload(workspaceRoot?: string) {
    return this.installService.listInstalled(workspaceRoot)
      .filter((ext) => ext.enabled && ext.compatible && ext.manifest.main)
      .map((ext) => ({
        id: ext.id,
        installPath: ext.installPath,
        main: ext.manifest.main,
        activationEvents: ext.manifest.activationEvents ?? [],
        commands: (ext.manifest.contributes?.commands ?? []).map((command) => command.command),
        views: Object.values(ext.manifest.contributes?.views ?? {}).flat().map((view) => view.id),
        globalStoragePath: path.join(electron.app.getPath('userData'), 'extensions', 'state', 'global-storage', ext.id),
        workspaceStoragePath: path.join(electron.app.getPath('userData'), 'extensions', 'state', 'workspace-storage', hashWorkspace(workspaceRoot ?? 'no-workspace'), ext.id),
      }))
  }

  private hostEntry(): string {
    return path.join(electron.app.getAppPath(), 'dist', 'extensions', 'extension-host-runner.js')
  }

  private handleMessage(message: unknown): void {
    const data = message as Record<string, unknown>
    if (data.type === 'ready') {
      this.ready = true
      return
    }
    if (data.type === 'activated' && typeof data.extensionId === 'string') {
      this.running.set(data.extensionId, {
        id: data.extensionId,
        active: true,
        activationTimeMs: typeof data.activationTimeMs === 'number' ? data.activationTimeMs : undefined,
        activationReason: typeof data.reason === 'string' ? data.reason : undefined,
        crashCount: this.crashCount,
      })
      return
    }
    if (data.type === 'response' && typeof data.requestId === 'string') {
      const request = this.pending.get(data.requestId)
      if (!request) return
      this.pending.delete(data.requestId)
      if (data.ok) request.resolve(data.result)
      else request.reject(new Error(typeof data.error === 'string' ? data.error : 'Extension host request failed'))
    }
  }

  private request(requestId: string, message: Record<string, unknown>, timeoutMs = 10000): Promise<unknown> {
    const child = this.child
    if (!child) return Promise.reject(new Error('Extension host is not running'))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new Error('Extension host request timed out'))
      }, timeoutMs)
      this.pending.set(requestId, {
        startedAt: Date.now(),
        resolve: (value) => { clearTimeout(timer); resolve(value) },
        reject: (error) => { clearTimeout(timer); reject(error) },
      })
      child.postMessage(message)
    })
  }

  private waitUntilReady(): Promise<void> {
    if (this.ready) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const started = Date.now()
      const timer = setInterval(() => {
        if (this.ready) {
          clearInterval(timer)
          resolve()
        } else if (Date.now() - started > 5000) {
          clearInterval(timer)
          reject(new Error('Extension host did not become ready'))
        }
      }, 20)
    })
  }
}

function hashWorkspace(workspaceRoot: string): string {
  return crypto.createHash('sha256').update(path.resolve(workspaceRoot)).digest('hex').slice(0, 32)
}
