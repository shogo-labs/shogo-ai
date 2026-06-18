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
  action: string
  target?: string
}

export interface ExtensionHostDiagnostic {
  id: string
  timestamp: number
  level: 'info' | 'error'
  type: 'activation' | 'command' | 'view' | 'deactivation' | 'crash' | 'timeout' | 'host'
  message: string
  extensionId?: string
  event?: string
  commandId?: string
  viewId?: string
  durationMs?: number
  error?: string
}

export interface RunningExtensionStatus {
  id: string
  active: boolean
  activationTimeMs?: number
  activationReason?: string
  crashCount: number
}

export interface ExtensionStatusBarItem {
  id: string
  extensionId: string
  text: string
  tooltip?: string
  command?: unknown
  alignment: 'left' | 'right'
  priority?: number
  visible: boolean
}

export interface ExtensionWebviewPanel {
  id: string
  extensionId: string
  viewType: string
  title: string
  html: string
  active: boolean
}

export interface ExtensionOutputChannel {
  id: string
  extensionId: string
  name: string
  visible: boolean
  disposed: boolean
  lines: string
  updatedAt: number
}

export interface ExtensionUiRequest {
  requestId: string
  extensionId: string
  kind: 'notification' | 'quickPick' | 'inputBox'
  payload: Record<string, unknown>
}

export interface ExtensionWorkspaceDocument {
  path: string
  fsPath?: string
  languageId: string
  version: number
  text: string
  isDirty?: boolean
}

export interface ExtensionWorkspaceState {
  workspaceRoot?: string
  workspaceName?: string
  activeDocumentPath?: string | null
  visibleDocumentPaths?: string[]
  documents?: ExtensionWorkspaceDocument[]
  configuration?: Record<string, unknown>
}

type ExtensionHostEvent =
  | { type: 'outputChanged'; channels: ExtensionOutputChannel[]; changed?: ExtensionOutputChannel }
  | { type: 'uiRequest'; request: ExtensionUiRequest }

export class ExtensionHostManager {
  private child: UtilityProcess | null = null
  private ready = false
  private pending = new Map<string, PendingRequest>()
  private running = new Map<string, RunningExtensionStatus>()
  private statusBarItems: ExtensionStatusBarItem[] = []
  private webviewPanels: ExtensionWebviewPanel[] = []
  private outputChannels = new Map<string, ExtensionOutputChannel>()
  private diagnostics: ExtensionHostDiagnostic[] = []
  private listeners = new Set<(event: ExtensionHostEvent) => void>()
  private crashCount = 0
  private stopping = false
  private workspaceRoot?: string
  private latestWorkspaceState?: ExtensionWorkspaceState

  constructor(private readonly installService: ExtensionInstallService) {}

  async executeCommand(commandId: string, args: unknown[] = [], workspaceRoot?: string): Promise<unknown> {
    await this.ensureStarted(workspaceRoot)
    const requestId = crypto.randomUUID()
    const result = await this.request(requestId, { type: 'executeCommand', requestId, commandId, args }, 10000, { action: 'command', target: commandId })
    return result
  }

  async activateEvent(event: string, workspaceRoot?: string): Promise<unknown> {
    await this.ensureStarted(workspaceRoot)
    const requestId = crypto.randomUUID()
    return await this.request(requestId, { type: 'activateEvent', requestId, event }, 10000, { action: 'activation', target: event })
  }

  async getView(viewId: string, workspaceRoot?: string, itemHandle?: string): Promise<unknown> {
    await this.ensureStarted(workspaceRoot)
    const requestId = crypto.randomUUID()
    return await this.request(requestId, { type: 'getView', requestId, viewId, itemHandle }, 10000, { action: 'view', target: viewId })
  }

  async getStatusBarItems(workspaceRoot?: string): Promise<ExtensionStatusBarItem[]> {
    await this.ensureStarted(workspaceRoot)
    const requestId = crypto.randomUUID()
    return await this.request(requestId, { type: 'getStatusBarItems', requestId }) as ExtensionStatusBarItem[]
  }

  async getWebviewPanels(workspaceRoot?: string): Promise<ExtensionWebviewPanel[]> {
    await this.ensureStarted(workspaceRoot)
    const requestId = crypto.randomUUID()
    return await this.request(requestId, { type: 'getWebviewPanels', requestId }) as ExtensionWebviewPanel[]
  }

  async getOutputChannels(workspaceRoot?: string): Promise<ExtensionOutputChannel[]> {
    await this.ensureStarted(workspaceRoot)
    return this.outputSnapshot()
  }

  async updateWorkspaceState(state: ExtensionWorkspaceState): Promise<void> {
    this.latestWorkspaceState = state
    const targetWorkspace = state.workspaceRoot ?? this.workspaceRoot
    await this.ensureStarted(targetWorkspace)
    this.postWorkspaceState(state)
  }

  respondToUiRequest(requestId: string, ok: boolean, result?: unknown, error?: string): void {
    if (!this.child) throw new Error('Extension host is not running')
    this.child.postMessage({ type: 'uiResponse', requestId, ok, result, error })
  }

  onEvent(listener: (event: ExtensionHostEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
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
    this.stopping = true
    this.child.kill()
    this.child = null
    this.ready = false
    this.pending.clear()
    this.running.clear()
    this.statusBarItems = []
    this.webviewPanels = []
    this.diagnostics = []
    this.outputChannels.clear()
    this.emit({ type: 'outputChanged', channels: [] })
  }

  getRunningExtensions(): RunningExtensionStatus[] {
    return [...this.running.values()]
  }

  getDiagnostics(): ExtensionHostDiagnostic[] {
    return [...this.diagnostics].sort((a, b) => b.timestamp - a.timestamp)
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
    ;(child as unknown as { once(event: 'exit', listener: (code: number | null, signal: string | null) => void): void }).once('exit', () => {
      if (this.stopping) {
        this.stopping = false
        return
      }
      this.crashCount++
      this.recordDiagnostic({ level: 'error', type: 'crash', message: 'Extension host process exited unexpectedly.', error: 'Extension host exited' })
      this.child = null
      this.ready = false
      for (const request of this.pending.values()) request.reject(new Error('Extension host exited'))
      this.pending.clear()
    })
    child.postMessage({ type: 'init', workspaceRoot: targetWorkspace, extensions: this.extensionPayload(targetWorkspace) })
    await this.waitUntilReady()
    if (this.latestWorkspaceState) this.postWorkspaceState(this.latestWorkspaceState)
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
    if (data.type === 'statusBarItemsChanged' && Array.isArray(data.items)) {
      this.statusBarItems = data.items as ExtensionStatusBarItem[]
      return
    }
    if (data.type === 'webviewPanelsChanged' && Array.isArray(data.panels)) {
      this.webviewPanels = data.panels as ExtensionWebviewPanel[]
      return
    }
    if (data.type === 'uiRequest' && typeof data.requestId === 'string' && typeof data.extensionId === 'string' && typeof data.kind === 'string') {
      this.emit({
        type: 'uiRequest',
        request: {
          requestId: data.requestId,
          extensionId: data.extensionId,
          kind: data.kind as ExtensionUiRequest['kind'],
          payload: isRecord(data.payload) ? data.payload : {},
        },
      })
      return
    }
    if (typeof data.type === 'string' && ['output', 'outputCleared', 'outputShown', 'outputDisposed'].includes(data.type)) {
      this.handleOutputMessage(data)
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
      this.recordDiagnostic({
        level: 'info',
        type: 'activation',
        extensionId: data.extensionId,
        event: typeof data.reason === 'string' ? data.reason : undefined,
        durationMs: typeof data.activationTimeMs === 'number' ? data.activationTimeMs : undefined,
        message: `${data.extensionId} activated${typeof data.reason === 'string' ? ` by ${data.reason}` : ''}.`,
      })
      return
    }
    if (typeof data.type === 'string' && ['activationError', 'commandExecuted', 'commandError', 'viewResolved', 'viewError', 'deactivateError'].includes(data.type)) {
      this.recordRuntimeDiagnostic(data)
      return
    }
    if (data.type === 'response' && typeof data.requestId === 'string') {
      const request = this.pending.get(data.requestId)
      if (!request) return
      this.pending.delete(data.requestId)
      if (data.ok) request.resolve(data.result)
      else {
        const error = typeof data.error === 'string' ? data.error : 'Extension host request failed'
        this.recordDiagnostic({
          level: 'error',
          type: request.action === 'command' ? 'command' : request.action === 'view' ? 'view' : 'activation',
          message: `${request.action} failed${request.target ? `: ${request.target}` : ''}`,
          error,
          commandId: request.action === 'command' ? request.target : undefined,
          viewId: request.action === 'view' ? request.target : undefined,
          event: request.action === 'activation' ? request.target : undefined,
        })
        request.reject(new Error(error))
      }
    }
  }

  private request(requestId: string, message: Record<string, unknown>, timeoutMs = 10000, diagnostic?: { action: string; target?: string }): Promise<unknown> {
    const child = this.child
    if (!child) return Promise.reject(new Error('Extension host is not running'))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        this.recordDiagnostic({
          level: 'error',
          type: 'timeout',
          message: `${diagnostic?.action ?? 'request'} timed out${diagnostic?.target ? `: ${diagnostic.target}` : ''}`,
          error: 'Extension host request timed out',
          commandId: diagnostic?.action === 'command' ? diagnostic.target : undefined,
          viewId: diagnostic?.action === 'view' ? diagnostic.target : undefined,
          event: diagnostic?.action === 'activation' ? diagnostic.target : undefined,
        })
        reject(new Error('Extension host request timed out'))
      }, timeoutMs)
      this.pending.set(requestId, {
        startedAt: Date.now(),
        action: diagnostic?.action ?? 'request',
        target: diagnostic?.target,
        resolve: (value) => { clearTimeout(timer); resolve(value) },
        reject: (error) => { clearTimeout(timer); reject(error) },
      })
      child.postMessage(message)
    })
  }

  private recordRuntimeDiagnostic(data: Record<string, unknown>): void {
    const extensionId = typeof data.extensionId === 'string' ? data.extensionId : undefined
    const durationMs = typeof data.durationMs === 'number' ? data.durationMs : undefined
    const error = typeof data.error === 'string' ? data.error : undefined
    const commandId = typeof data.commandId === 'string' ? data.commandId : undefined
    const viewId = typeof data.viewId === 'string' ? data.viewId : undefined
    const event = typeof data.event === 'string' ? data.event : undefined
    if (data.type === 'commandExecuted') {
      this.recordDiagnostic({ level: 'info', type: 'command', extensionId, commandId, durationMs, message: `Command completed: ${commandId ?? 'unknown command'}` })
    } else if (data.type === 'commandError') {
      this.recordDiagnostic({ level: 'error', type: 'command', extensionId, commandId, durationMs, error, message: `Command failed: ${commandId ?? 'unknown command'}` })
    } else if (data.type === 'viewResolved') {
      this.recordDiagnostic({ level: 'info', type: 'view', extensionId, viewId, durationMs, message: `View resolved: ${viewId ?? 'unknown view'}` })
    } else if (data.type === 'viewError') {
      this.recordDiagnostic({ level: 'error', type: 'view', extensionId, viewId, durationMs, error, message: `View failed: ${viewId ?? 'unknown view'}` })
    } else if (data.type === 'activationError') {
      this.recordDiagnostic({ level: 'error', type: 'activation', extensionId, event, durationMs, error, message: `Activation failed${extensionId ? `: ${extensionId}` : ''}` })
    } else if (data.type === 'deactivateError') {
      this.recordDiagnostic({ level: 'error', type: 'deactivation', extensionId, error, message: `Deactivation failed${extensionId ? `: ${extensionId}` : ''}` })
    }
  }

  private recordDiagnostic(diagnostic: Omit<ExtensionHostDiagnostic, 'id' | 'timestamp'>): void {
    this.diagnostics.push({ ...diagnostic, id: crypto.randomUUID(), timestamp: Date.now() })
    if (this.diagnostics.length > 200) this.diagnostics.splice(0, this.diagnostics.length - 200)
  }

  private handleOutputMessage(data: Record<string, unknown>): void {
    const extensionId = typeof data.extensionId === 'string' ? data.extensionId : 'unknown'
    const name = typeof data.name === 'string' ? data.name : 'Output'
    const id = `${extensionId}:${name}`
    const existing = this.outputChannels.get(id) ?? { id, extensionId, name, visible: false, disposed: false, lines: '', updatedAt: Date.now() }
    if (data.type === 'output') {
      existing.lines += typeof data.value === 'string' ? data.value : String(data.value ?? '')
      existing.disposed = false
    } else if (data.type === 'outputCleared') {
      existing.lines = ''
    } else if (data.type === 'outputShown') {
      existing.visible = true
    } else if (data.type === 'outputDisposed') {
      existing.disposed = true
      existing.visible = false
    }
    existing.updatedAt = Date.now()
    this.outputChannels.set(id, existing)
    this.emit({ type: 'outputChanged', channels: this.outputSnapshot(), changed: { ...existing } })
  }

  private outputSnapshot(): ExtensionOutputChannel[] {
    return [...this.outputChannels.values()].sort((a, b) => b.updatedAt - a.updatedAt).map((channel) => ({ ...channel }))
  }

  private postWorkspaceState(state: ExtensionWorkspaceState): void {
    if (!this.child) return
    const workspaceRoot = state.workspaceRoot ?? this.workspaceRoot
    const documents = (state.documents ?? []).map((document) => {
      const fsPath = this.resolveWorkspacePath(workspaceRoot, document.fsPath ?? document.path)
      return {
        uri: { scheme: 'file', fsPath, path: fsPath },
        fileName: fsPath,
        languageId: document.languageId,
        version: document.version,
        text: document.text,
        isDirty: !!document.isDirty,
      }
    })
    const byPath = new Map<string, (typeof documents)[number]>()
    for (const document of documents) byPath.set(document.fileName, document)
    const activePath = state.activeDocumentPath ? this.resolveWorkspacePath(workspaceRoot, state.activeDocumentPath) : null
    const activeDocument = activePath ? byPath.get(activePath) : undefined
    const visiblePaths = state.visibleDocumentPaths?.map((candidate) => this.resolveWorkspacePath(workspaceRoot, candidate)) ?? []
    const visibleTextEditors = visiblePaths.map((file) => byPath.get(file)).filter((document): document is (typeof documents)[number] => !!document).map((document) => ({ document }))
    this.child.postMessage({
      type: 'workspaceState',
      state: {
        workspaceFolders: workspaceRoot ? [{ uri: { scheme: 'file', fsPath: workspaceRoot, path: workspaceRoot }, name: state.workspaceName ?? path.basename(workspaceRoot), index: 0 }] : [],
        textDocuments: documents,
        activeTextEditor: activeDocument ? { document: activeDocument } : null,
        visibleTextEditors,
        configuration: state.configuration ?? {},
      },
    })
  }

  private resolveWorkspacePath(workspaceRoot: string | undefined, candidate: string): string {
    if (path.isAbsolute(candidate)) return path.resolve(candidate)
    return workspaceRoot ? path.resolve(workspaceRoot, candidate) : path.resolve(candidate)
  }

  private emit(event: ExtensionHostEvent): void {
    for (const listener of this.listeners) listener(event)
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
          this.recordDiagnostic({ level: 'error', type: 'timeout', message: 'Extension host did not become ready.', error: 'Extension host did not become ready' })
          reject(new Error('Extension host did not become ready'))
        }
      }, 20)
    })
  }
}

function hashWorkspace(workspaceRoot: string): string {
  return crypto.createHash('sha256').update(path.resolve(workspaceRoot)).digest('hex').slice(0, 32)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
