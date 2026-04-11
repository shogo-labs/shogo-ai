// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * TypeScript Language Server Service
 *
 * Spawns typescript-language-server (LSP over stdio) and provides a typed
 * request/notification API.  Used by both runtime (Monaco editor
 * IntelliSense) and agent-runtime (read_lints diagnostics).
 */

import { spawn, type Subprocess } from 'bun'
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'fs'
import { join, dirname, resolve } from 'path'

const IS_WINDOWS = process.platform === 'win32'
const WIN_BIN_EXTENSIONS = ['.exe', '.cmd']

/**
 * Resolve a Node CLI binary across platforms.
 *
 * On Windows, Bun creates `.exe` / `.bunx` shims in `node_modules/.bin/`
 * instead of extensionless POSIX scripts, so a bare `existsSync(…/.bin/name)`
 * will fail. This helper checks the extensionless path first, then Windows
 * shim extensions, then falls back to the module's JS entry point
 * (bypassing `.bin/` entirely, like the Vite workaround in manager.ts).
 */
export function resolveBin(
  name: string,
  searchDirs: string[],
  directEntryPath?: string,
): { resolved: string; viaBun: boolean } | undefined {
  for (const dir of searchDirs) {
    const base = join(dir, 'node_modules', '.bin', name)
    if (existsSync(base)) return { resolved: base, viaBun: false }
    if (IS_WINDOWS) {
      for (const ext of WIN_BIN_EXTENSIONS) {
        const withExt = base + ext
        if (existsSync(withExt)) return { resolved: withExt, viaBun: false }
      }
    }
  }

  if (directEntryPath) {
    for (const dir of searchDirs) {
      const entry = join(dir, 'node_modules', name, directEntryPath)
      if (existsSync(entry)) return { resolved: entry, viaBun: true }
    }
  }

  return undefined
}

export interface LSPMessage {
  jsonrpc: '2.0'
  id?: number | string
  method?: string
  params?: unknown
  result?: unknown
  error?: {
    code: number
    message: string
    data?: unknown
  }
}

export interface LSPDiagnostic {
  range: {
    start: { line: number; character: number }
    end: { line: number; character: number }
  }
  severity?: number
  message: string
  source?: string
  code?: number | string
}

export interface TSLanguageServerOptions {
  /** Explicit path to the language server binary */
  serverBin?: string
  /** Additional CLI args after --stdio (default: ['--log-level', '1'] for TS) */
  serverArgs?: string[]
  /** Fallback binary names to search for if serverBin is not set */
  fallbackBinNames?: string[]
  /** Default languageId sent in didOpen (default: 'typescript') */
  defaultLanguageId?: string
  /** Label for log messages (default: 'LSP') */
  label?: string
  /** Extra fields merged into LSP initializationOptions */
  initializationOptions?: Record<string, unknown>
}

export class TSLanguageServer {
  private process: Subprocess<'pipe', 'pipe', 'pipe'> | null = null
  private projectDir: string
  private serverBin: string | undefined
  private serverArgs: string[]
  private fallbackBinNames: string[]
  private defaultLanguageId: string
  private label: string
  private messageBuffer = ''
  private contentLength = -1
  private messageHandlers = new Set<(msg: LSPMessage) => void>()
  private requestId = 0
  private pendingRequests = new Map<number | string, {
    resolve: (result: unknown) => void
    reject: (error: Error) => void
  }>()
  private isInitialized = false
  private initPromise: Promise<void> | null = null
  private openDocVersions = new Map<string, number>()
  private diagnosticsByUri = new Map<string, LSPDiagnostic[]>()
  private extraInitOptions: Record<string, unknown>

  constructor(projectDir: string, opts?: TSLanguageServerOptions) {
    this.projectDir = resolve(projectDir)
    this.serverBin = opts?.serverBin
    this.serverArgs = opts?.serverArgs ?? ['--log-level', '1']
    this.fallbackBinNames = opts?.fallbackBinNames ?? ['typescript-language-server']
    this.defaultLanguageId = opts?.defaultLanguageId ?? 'typescript'
    this.label = opts?.label ?? 'LSP'
    this.extraInitOptions = opts?.initializationOptions ?? {}
  }

  async start(): Promise<void> {
    if (this.process) return

    const searchDirs = [
      this.projectDir,
      dirname(dirname(import.meta.path)),
    ]

    let serverPath: string | undefined
    let spawnViaBun = false

    if (this.serverBin) {
      if (existsSync(this.serverBin)) {
        serverPath = this.serverBin
      } else if (IS_WINDOWS) {
        for (const ext of WIN_BIN_EXTENSIONS) {
          if (existsSync(this.serverBin + ext)) {
            serverPath = this.serverBin + ext
            break
          }
        }
      }
    }

    if (!serverPath) {
      for (const name of this.fallbackBinNames) {
        const result = resolveBin(name, searchDirs, 'lib/cli.mjs')
        if (result) {
          serverPath = result.resolved
          spawnViaBun = result.viaBun
          break
        }
      }
    }

    if (!serverPath) {
      const tried = this.fallbackBinNames.join(', ')
      throw new Error(
        `[${this.label}] Could not find language server binary (${tried}). ` +
        `Searched: ${searchDirs.map(d => join(d, 'node_modules', '.bin')).join(', ')}`,
      )
    }

    // In Bun runtime, always spawn via bun — .bin shims use #!/usr/bin/env node
    // which may not exist (e.g. packaged Electron apps ship bun, not node)
    if (typeof Bun !== 'undefined') spawnViaBun = true

    console.log(`[${this.label}] Starting ${serverPath}${spawnViaBun ? ' (via bun)' : ''}`)
    console.log(`[${this.label}] Project directory: ${this.projectDir}`)

    const cmd = spawnViaBun
      ? ['bun', serverPath, '--stdio', ...this.serverArgs]
      : [serverPath, '--stdio', ...this.serverArgs]

    try {
      this.process = spawn(cmd, {
        cwd: this.projectDir,
        env: { ...process.env },
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      })

      this.readOutputStream()
      this.readErrorStream()

      if (this.process?.exitCode !== null) {
        throw new Error(`${serverPath} exited with code ${this.process?.exitCode}`)
      }

      console.log(`[${this.label}] Language server started`)
    } catch (error) {
      console.error(`[${this.label}] Failed to start language server:`, error)
      this.process = null
      throw error
    }
  }

  private async readOutputStream() {
    if (!this.process?.stdout) return
    const reader = this.process.stdout.getReader()
    const decoder = new TextDecoder()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        this.messageBuffer += decoder.decode(value, { stream: true })
        this.processBuffer()
      }
    } catch { /* stream closed */ }
  }

  private async readErrorStream() {
    if (!this.process?.stderr) return
    const reader = this.process.stderr.getReader()
    const decoder = new TextDecoder()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const text = decoder.decode(value, { stream: true })
        if (text.trim()) console.log(`[${this.label} stderr]`, text.trim())
      }
    } catch { /* stream closed */ }
  }

  private processBuffer() {
    while (true) {
      if (this.contentLength === -1) {
        const headerEnd = this.messageBuffer.indexOf('\r\n\r\n')
        if (headerEnd === -1) return
        const header = this.messageBuffer.substring(0, headerEnd)
        const match = header.match(/Content-Length:\s*(\d+)/i)
        if (!match) {
          this.messageBuffer = this.messageBuffer.substring(headerEnd + 4)
          continue
        }
        this.contentLength = parseInt(match[1], 10)
        this.messageBuffer = this.messageBuffer.substring(headerEnd + 4)
      }

      if (this.messageBuffer.length < this.contentLength) return

      const messageText = this.messageBuffer.substring(0, this.contentLength)
      this.messageBuffer = this.messageBuffer.substring(this.contentLength)
      this.contentLength = -1

      try {
        const message = JSON.parse(messageText) as LSPMessage

        // Collect published diagnostics automatically
        if (message.method === 'textDocument/publishDiagnostics' && message.params) {
          const p = message.params as { uri: string; diagnostics: LSPDiagnostic[] }
          this.diagnosticsByUri.set(p.uri, p.diagnostics)
        }

        // Auto-respond to server-initiated requests (pyright, etc.)
        if (message.id !== undefined && message.method) {
          this.handleServerRequest(message)
        }

        if (message.id !== undefined && !message.method) {
          const pending = this.pendingRequests.get(message.id)
          if (pending) {
            this.pendingRequests.delete(message.id)
            if (message.error) {
              pending.reject(new Error(message.error.message))
            } else {
              pending.resolve(message.result)
            }
          }
        }

        for (const handler of this.messageHandlers) {
          handler(message)
        }
      } catch { /* skip malformed lines */ }
    }
  }

  send(message: LSPMessage): void {
    if (!this.process?.stdin) {
      throw new Error('Language server not running')
    }
    const content = JSON.stringify(message)
    const header = `Content-Length: ${Buffer.byteLength(content)}\r\n\r\n`
    this.process.stdin.write(header + content)
    this.process.stdin.flush()
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    const id = ++this.requestId
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject })
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id)
        reject(new Error(`Request timeout: ${method}`))
      }, 30000)

      this.send({ jsonrpc: '2.0', id, method, params })

      const originalResolve = resolve
      this.pendingRequests.get(id)!.resolve = (result) => {
        clearTimeout(timeout)
        originalResolve(result)
      }
    })
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) return
    if (this.initPromise) return this.initPromise

    this.initPromise = (async () => {
      console.log(`[${this.label}] Initializing language server...`)

      const rootUri = `file://${this.projectDir}`
      await this.request('initialize', {
        processId: process.pid,
        rootUri,
        rootPath: this.projectDir,
        workspaceFolders: [{ uri: rootUri, name: 'workspace' }],
        capabilities: {
          textDocument: {
            synchronization: { dynamicRegistration: true, didSave: true },
            completion: {
              dynamicRegistration: true,
              completionItem: { snippetSupport: true, documentationFormat: ['markdown', 'plaintext'] },
            },
            hover: { dynamicRegistration: true, contentFormat: ['markdown', 'plaintext'] },
            signatureHelp: { dynamicRegistration: true },
            definition: { dynamicRegistration: true },
            references: { dynamicRegistration: true },
            documentHighlight: { dynamicRegistration: true },
            documentSymbol: { dynamicRegistration: true },
            codeAction: { dynamicRegistration: true },
            rename: { dynamicRegistration: true },
            publishDiagnostics: {
              relatedInformation: true,
              tagSupport: { valueSet: [1, 2] },
            },
          },
          workspace: {
            applyEdit: true,
            workspaceEdit: { documentChanges: true },
            didChangeConfiguration: { dynamicRegistration: true },
            didChangeWatchedFiles: { dynamicRegistration: true },
            workspaceFolders: true,
            configuration: true,
          },
        },
        initializationOptions: { ...this.extraInitOptions },
      })

      this.send({ jsonrpc: '2.0', method: 'initialized', params: {} })

      // Some LSP servers (e.g. pyright) need a didChangeConfiguration
      // notification before they begin background analysis.
      this.send({
        jsonrpc: '2.0',
        method: 'workspace/didChangeConfiguration',
        params: { settings: {} },
      })

      this.isInitialized = true
      console.log(`[${this.label}] Language server initialized`)
    })()

    return this.initPromise
  }

  // -------------------------------------------------------------------------
  // Server-initiated request handler
  // -------------------------------------------------------------------------

  private handleServerRequest(message: LSPMessage): void {
    const id = message.id
    switch (message.method) {
      case 'workspace/configuration': {
        const items = (message.params as any)?.items as any[] | undefined
        const result = (items ?? []).map((item: any) => {
          if (item?.section === 'python') {
            return { pythonPath: 'python3', analysis: { typeCheckingMode: 'basic' } }
          }
          if (item?.section === 'python.analysis') {
            return { typeCheckingMode: 'basic' }
          }
          return {}
        })
        this.send({ jsonrpc: '2.0', id, result })
        break
      }
      case 'client/registerCapability':
        this.send({ jsonrpc: '2.0', id, result: null })
        break
      case 'window/workDoneProgress/create':
        this.send({ jsonrpc: '2.0', id, result: null })
        break
      default:
        this.send({ jsonrpc: '2.0', id, result: null })
        break
    }
  }

  // -------------------------------------------------------------------------
  // Document sync helpers (for agent-runtime to keep the LSP up to date)
  // -------------------------------------------------------------------------

  notifyFileChanged(filePath: string, content: string): void {
    if (!this.isInitialized || !this.isRunning()) return
    const uri = `file://${filePath}`
    const version = (this.openDocVersions.get(uri) ?? 0) + 1
    this.openDocVersions.set(uri, version)

    if (version === 1) {
      const languageId = this.inferLanguageId(filePath)
      this.send({
        jsonrpc: '2.0',
        method: 'textDocument/didOpen',
        params: { textDocument: { uri, languageId, version, text: content } },
      })
    } else {
      this.send({
        jsonrpc: '2.0',
        method: 'textDocument/didChange',
        params: {
          textDocument: { uri, version },
          contentChanges: [{ text: content }],
        },
      })
    }
  }

  notifyFileSaved(filePath: string): void {
    if (!this.isInitialized || !this.isRunning()) return
    const uri = `file://${filePath}`
    if (!this.openDocVersions.has(uri)) return
    this.send({
      jsonrpc: '2.0',
      method: 'textDocument/didSave',
      params: { textDocument: { uri } },
    })
  }

  notifyFileDeleted(filePath: string): void {
    if (!this.isInitialized || !this.isRunning()) return
    const uri = `file://${filePath}`
    if (this.openDocVersions.has(uri)) {
      this.send({
        jsonrpc: '2.0',
        method: 'textDocument/didClose',
        params: { textDocument: { uri } },
      })
      this.openDocVersions.delete(uri)
      this.diagnosticsByUri.delete(uri)
    }
  }

  getDiagnostics(uri?: string): Map<string, LSPDiagnostic[]> {
    if (uri) {
      const diags = this.diagnosticsByUri.get(uri)
      const result = new Map<string, LSPDiagnostic[]>()
      if (diags) result.set(uri, diags)
      return result
    }
    return new Map(this.diagnosticsByUri)
  }

  onMessage(handler: (msg: LSPMessage) => void): () => void {
    this.messageHandlers.add(handler)
    return () => this.messageHandlers.delete(handler)
  }

  private inferLanguageId(filePath: string): string {
    if (/\.py$/.test(filePath)) return 'python'
    if (/\.tsx$/.test(filePath)) return 'typescriptreact'
    if (/\.jsx$/.test(filePath)) return 'javascriptreact'
    if (/\.js$/.test(filePath)) return 'javascript'
    return this.defaultLanguageId
  }

  stop(): void {
    if (this.process) {
      console.log(`[${this.label}] Stopping language server`)
      this.process.kill()
      this.process = null
      this.isInitialized = false
      this.initPromise = null
      this.messageBuffer = ''
      this.contentLength = -1
      this.pendingRequests.clear()
      this.openDocVersions.clear()
      this.diagnosticsByUri.clear()
    }
  }

  isRunning(): boolean {
    return this.process !== null && this.process.exitCode === null
  }

  getProjectDir(): string {
    return this.projectDir
  }
}

export class LSPServerManager {
  private servers = new Map<string, TSLanguageServer>()

  async getServer(projectDir: string): Promise<TSLanguageServer> {
    let server = this.servers.get(projectDir)
    if (!server || !server.isRunning()) {
      server = new TSLanguageServer(projectDir)
      this.servers.set(projectDir, server)
      await server.start()
    }
    return server
  }

  stopServer(projectDir: string): void {
    const server = this.servers.get(projectDir)
    if (server) {
      server.stop()
      this.servers.delete(projectDir)
    }
  }

  stopAll(): void {
    for (const [, server] of this.servers) {
      server.stop()
    }
    this.servers.clear()
  }
}

export const lspManager = new LSPServerManager()

// ---------------------------------------------------------------------------
// WorkspaceLSPManager — routes files to the correct language server
// ---------------------------------------------------------------------------

const TS_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx'])
const PY_EXTENSIONS = new Set(['.py', '.pyi'])

function extOf(filePath: string): string {
  const dot = filePath.lastIndexOf('.')
  return dot >= 0 ? filePath.slice(dot) : ''
}

export interface WorkspaceLSPManagerOptions {
  projectDir: string
  tsServerBin?: string
  /** Path to the pyright CLI binary (not pyright-langserver) */
  pyrightBin?: string
}

/**
 * Manages language diagnostics for a workspace. TypeScript uses a persistent
 * LSP server for incremental analysis. Python uses pyright CLI invocations
 * (pyright --outputjson) since pyright-langserver's push diagnostics are
 * unreliable in headless environments.
 *
 * The interface is identical for both — callers just see diagnostics.
 */
export class WorkspaceLSPManager {
  private tsServer: TSLanguageServer | null = null
  private projectDir: string
  private tsServerBin: string | undefined
  private pyrightBin: string | undefined
  private pyDirtyFiles = new Set<string>()
  private pyCachedDiags = new Map<string, LSPDiagnostic[]>()
  private pyAvailable = false
  private warmupPromise: Promise<void> | null = null

  constructor(opts: WorkspaceLSPManagerOptions) {
    this.projectDir = resolve(opts.projectDir)
    this.tsServerBin = opts.tsServerBin
    this.pyrightBin = opts.pyrightBin
  }

  async startAll(): Promise<void> {
    const results = await Promise.allSettled([
      this.startTS(),
      this.detectPyright(),
    ])
    for (const r of results) {
      if (r.status === 'rejected') {
        console.warn('[WorkspaceLSP] Start failed (non-fatal):', r.reason?.message)
      }
    }
    if (this.tsServer) {
      this.warmupPromise = this.warmupTS()
    }
  }

  async waitForReady(): Promise<void> {
    if (this.warmupPromise) await this.warmupPromise
  }

  private async warmupTS(): Promise<void> {
    const warmupFile = join(this.projectDir, '.shogo', '__lsp_warmup__.ts')
    const warmupContent = '// LSP warmup sentinel — do not delete\nimport { useState } from "react"\nvar _w = useState(0)\nreturn h("div", {}, _w[0])\n'
    try {
      mkdirSync(join(this.projectDir, '.shogo'), { recursive: true })
      writeFileSync(warmupFile, warmupContent, 'utf-8')
      this.tsServer!.notifyFileChanged(warmupFile, warmupContent)

      const warmupUri = `file://${warmupFile}`
      const deadline = Date.now() + 15_000
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 300))
        const diags = this.tsServer!.getDiagnostics(warmupUri)
        if (diags.has(warmupUri)) {
          const errors = diags.get(warmupUri) ?? []
          const hasCanvasErr = errors.some(
            d => /Cannot find name/.test(d.message),
          )
          if (!hasCanvasErr) break
        }
      }
    } catch (err: any) {
      console.warn('[WorkspaceLSP] Warmup failed (non-fatal):', err.message)
    }
  }

  renotifyWarmupFile(): void {
    if (!this.tsServer?.isRunning()) return
    const warmupFile = join(this.projectDir, '.shogo', '__lsp_warmup__.ts')
    const warmupContent = '// LSP warmup sentinel — do not delete\nimport { useState } from "react"\nvar _w = useState(0)\nreturn h("div", {}, _w[0])\n'
    try {
      mkdirSync(join(this.projectDir, '.shogo'), { recursive: true })
      writeFileSync(warmupFile, warmupContent, 'utf-8')
      this.tsServer.notifyFileChanged(warmupFile, warmupContent)
    } catch {}
  }

  private async startTS(): Promise<void> {
    this.ensureTsconfigWatchExclusions()
    this.tsServer = new TSLanguageServer(this.projectDir, {
      serverBin: this.tsServerBin,
      fallbackBinNames: ['typescript-language-server'],
      serverArgs: ['--log-level', '1'],
      defaultLanguageId: 'typescript',
      label: 'LSP-TS',
      initializationOptions: {
        maxTsServerMemory: 512,
        disableAutomaticTypingAcquisition: true,
        tsserver: {
          useSyntaxServer: 'never',
        },
      },
    })
    await this.tsServer.start()
    await this.tsServer.initialize()
  }

  /**
   * Ensure the workspace tsconfig.json has watchOptions.excludeDirectories
   * so tsserver doesn't watch node_modules (tens of thousands of files).
   */
  private ensureTsconfigWatchExclusions(): void {
    const tsconfigPath = join(this.projectDir, 'tsconfig.json')
    try {
      if (!existsSync(tsconfigPath)) return
      const raw = readFileSync(tsconfigPath, 'utf-8')
      const config = JSON.parse(raw)
      if (config.watchOptions?.excludeDirectories?.length) return
      config.watchOptions = {
        ...config.watchOptions,
        excludeDirectories: ['**/node_modules'],
      }
      writeFileSync(tsconfigPath, JSON.stringify(config, null, 2) + '\n', 'utf-8')
      console.log('[LSP-TS] Added watchOptions.excludeDirectories to tsconfig.json')
    } catch {
      // Non-fatal — tsconfig may have comments or be malformed
    }
  }

  private async detectPyright(): Promise<void> {
    if (this.pyrightBin && existsSync(this.pyrightBin)) {
      this.pyAvailable = true
      console.log(`[LSP-PY] Pyright CLI available at: ${this.pyrightBin}`)
      return
    }

    const searchDirs = [
      this.projectDir,
      dirname(dirname(import.meta.path)),
    ]
    const result = resolveBin('pyright', searchDirs)
    if (result) {
      this.pyrightBin = result.resolved
      this.pyAvailable = true
      console.log(`[LSP-PY] Pyright CLI available at: ${result.resolved}`)
      return
    }

    console.log('[LSP-PY] Pyright not found — Python linting disabled')
  }

  notifyFileChanged(filePath: string, content: string): void {
    const ext = extOf(filePath)
    if (TS_EXTENSIONS.has(ext)) {
      this.tsServer?.notifyFileChanged(filePath, content)
    } else if (PY_EXTENSIONS.has(ext)) {
      this.pyDirtyFiles.add(filePath)
    }
  }

  notifyFileSaved(filePath: string): void {
    const ext = extOf(filePath)
    if (TS_EXTENSIONS.has(ext)) {
      this.tsServer?.notifyFileSaved(filePath)
    }
  }

  notifyFileDeleted(filePath: string): void {
    const ext = extOf(filePath)
    if (TS_EXTENSIONS.has(ext)) {
      this.tsServer?.notifyFileDeleted(filePath)
    } else if (PY_EXTENSIONS.has(ext)) {
      this.pyDirtyFiles.delete(filePath)
      const uri = `file://${filePath}`
      this.pyCachedDiags.delete(uri)
    }
  }

  /**
   * Get diagnostics for a file or all tracked files.
   * For Python files, runs pyright CLI on demand if dirty files exist.
   */
  async getDiagnosticsAsync(uri?: string): Promise<Map<string, LSPDiagnostic[]>> {
    if (this.warmupPromise) await this.warmupPromise

    // Refresh Python diagnostics if any .py files have changed
    if (this.pyAvailable && this.pyDirtyFiles.size > 0) {
      await this.runPyrightCLI()
    }

    const merged = new Map<string, LSPDiagnostic[]>()

    // TS diagnostics from LSP
    if (this.tsServer?.isRunning()) {
      for (const [u, diags] of this.tsServer.getDiagnostics(uri)) {
        merged.set(u, diags)
      }
    }

    // Python diagnostics from cache
    if (uri) {
      const pyDiags = this.pyCachedDiags.get(uri)
      if (pyDiags) {
        const existing = merged.get(uri) ?? []
        merged.set(uri, [...existing, ...pyDiags])
      }
    } else {
      for (const [u, diags] of this.pyCachedDiags) {
        const existing = merged.get(u) ?? []
        merged.set(u, [...existing, ...diags])
      }
    }

    return merged
  }

  /** Synchronous version — returns TS LSP diagnostics + cached Python diagnostics */
  getDiagnostics(uri?: string): Map<string, LSPDiagnostic[]> {
    const merged = new Map<string, LSPDiagnostic[]>()

    if (this.tsServer?.isRunning()) {
      for (const [u, diags] of this.tsServer.getDiagnostics(uri)) {
        merged.set(u, diags)
      }
    }

    if (uri) {
      const pyDiags = this.pyCachedDiags.get(uri)
      if (pyDiags) {
        const existing = merged.get(uri) ?? []
        merged.set(uri, [...existing, ...pyDiags])
      }
    } else {
      for (const [u, diags] of this.pyCachedDiags) {
        const existing = merged.get(u) ?? []
        merged.set(u, [...existing, ...diags])
      }
    }

    return merged
  }

  private async runPyrightCLI(): Promise<void> {
    if (!this.pyrightBin) return
    const files = [...this.pyDirtyFiles]
    this.pyDirtyFiles.clear()

    try {
      const cmd = typeof Bun !== 'undefined'
        ? ['bun', this.pyrightBin, '--outputjson', ...files]
        : [this.pyrightBin, '--outputjson', ...files]
      const proc = spawn(cmd, {
        cwd: this.projectDir,
        env: { ...process.env },
        stdout: 'pipe',
        stderr: 'pipe',
      })

      const chunks: Buffer[] = []
      const reader = proc.stdout.getReader()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          chunks.push(Buffer.from(value))
        }
      } catch { /* stream ended */ }

      const output = Buffer.concat(chunks).toString('utf-8')
      await proc.exited

      // Clear old Python diagnostics for the checked files
      for (const f of files) {
        this.pyCachedDiags.delete(`file://${f}`)
      }

      if (!output.trim()) return

      const result = JSON.parse(output) as {
        generalDiagnostics?: Array<{
          file: string
          severity: string
          message: string
          range: { start: { line: number; character: number }; end: { line: number; character: number } }
          rule?: string
        }>
      }

      for (const d of result.generalDiagnostics ?? []) {
        const uri = `file://${d.file}`
        const severity = d.severity === 'error' ? 1 : d.severity === 'warning' ? 2 : 3
        const diag: LSPDiagnostic = {
          range: d.range,
          severity,
          message: d.message,
          code: d.rule,
        }
        const existing = this.pyCachedDiags.get(uri) ?? []
        existing.push(diag)
        this.pyCachedDiags.set(uri, existing)
      }

      console.log(`[LSP-PY] Analyzed ${files.length} file(s), ${result.generalDiagnostics?.length ?? 0} diagnostics`)
    } catch (err: any) {
      console.warn('[LSP-PY] Pyright CLI failed:', err.message)
    }
  }

  isRunning(): boolean {
    return (this.tsServer?.isRunning() ?? false) || this.pyAvailable
  }

  stop(): void {
    this.tsServer?.stop()
    this.tsServer = null
    this.pyDirtyFiles.clear()
    this.pyCachedDiags.clear()
  }
}
