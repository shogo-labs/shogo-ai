// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * TypeScript Language Server Service
 *
 * Spawns typescript-language-server (LSP over stdio) and provides a typed
 * request/notification API.  Used by both runtime (Monaco editor
 * IntelliSense) and agent-runtime (read_lints diagnostics).
 */

import { spawn as bunSpawn, type Subprocess } from 'bun'

// Injection point for tests — replaced via `_setSpawnForTesting`. At runtime
// this is just `bunSpawn` (bun's built-in spawn). The bun-builtin module
// cannot be intercepted by `mock.module()`, so we expose a setter instead.
let spawn: typeof bunSpawn = bunSpawn
export function _setSpawnForTesting(impl: typeof bunSpawn | null): void {
  spawn = impl ?? bunSpawn
}
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
  const isBunRuntime = typeof Bun !== 'undefined'

  // On Windows under Bun, .bin shims (.cmd wrappers, extensionless bash scripts)
  // can't be executed by Bun. Use the direct JS entry point instead.
  if (IS_WINDOWS && isBunRuntime && directEntryPath) {
    for (const dir of searchDirs) {
      const entry = join(dir, 'node_modules', name, directEntryPath)
      if (existsSync(entry)) return { resolved: entry, viaBun: true }
    }
  }

  for (const dir of searchDirs) {
    const base = join(dir, 'node_modules', '.bin', name)
    if (IS_WINDOWS) {
      for (const ext of WIN_BIN_EXTENSIONS) {
        const withExt = base + ext
        if (existsSync(withExt)) return { resolved: withExt, viaBun: false }
      }
    }
    if (existsSync(base)) return { resolved: base, viaBun: false }
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

/**
 * LSP `WatchKind` bitmask (spec 3.17 §workspace/didChangeWatchedFiles).
 * If `kind` is omitted on a registered watcher, default is Create|Change|Delete = 7.
 */
const WATCH_KIND_CREATE = 1
const WATCH_KIND_CHANGE = 2
const WATCH_KIND_DELETE = 4

/** Maps our local event kind to the LSP `FileChangeType` enum (1=Created, 2=Changed, 3=Deleted). */
const FILE_CHANGE_TYPE = { created: 1, changed: 2, deleted: 3 } as const
export type WatchedFileEventKind = keyof typeof FILE_CHANGE_TYPE

interface RegisteredWatcher {
  /** Already-compiled regex matching absolute paths against the watcher's globPattern. */
  matcher: RegExp
  /** Bitmask: 1=Create, 2=Change, 4=Delete. */
  kind: number
}

/**
 * Compile a single LSP `globPattern` into an absolute-path regex.
 *
 * tsserver registers patterns like:
 *   "**\/*.{ts,tsx,js,jsx,json,d.ts}"
 *   "**\/tsconfig.json"
 *   "**\/package.json"
 *
 * which are workspace-relative (LSP convention). We anchor at `^` and allow
 * any prefix before the pattern via a leading `.*` so absolute paths match.
 *
 * Supported syntax: `**`, `*`, `?`, `{a,b,c}`. Brace nesting is not supported
 * (tsserver doesn't emit nested braces). Char classes `[...]` are not
 * supported either (also not used by tsserver).
 *
 * Conservative on purpose: anything that doesn't compile turns into a
 * never-matching regex so we don't accidentally fire for paths the server
 * never asked us to watch.
 */
function compileLspGlob(pattern: string): RegExp {
  const REGEX_META = /[.+^$|()\\]/g
  const escapeLit = (s: string) => s.replace(REGEX_META, m => '\\' + m)

  let re = ''
  let i = 0
  while (i < pattern.length) {
    const c = pattern[i]
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        re += '.*'
        i += 2
        if (pattern[i] === '/') i++
      } else {
        re += '[^/]*'
        i++
      }
    } else if (c === '?') {
      re += '[^/]'
      i++
    } else if (c === '{') {
      const close = pattern.indexOf('}', i)
      if (close === -1) {
        re += '\\{'
        i++
      } else {
        const opts = pattern.slice(i + 1, close).split(',').map(s => s.trim())
        re += '(?:' + opts.map(escapeLit).join('|') + ')'
        i = close + 1
      }
    } else {
      re += escapeLit(c)
      i++
    }
  }

  try {
    return new RegExp('^.*' + re + '$')
  } catch {
    return /^$a/ // never matches
  }
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
  /**
   * `workspace/didChangeWatchedFiles` registrations. Keyed by the LSP
   * registration id supplied in `client/registerCapability`. Cleared on
   * `client/unregisterCapability` and on `stop()`.
   *
   * tsserver dynamically registers a single watcher for project file
   * patterns shortly after `initialized`; we honor that registration so
   * tsserver doesn't fall back to native inotify watching (saturates the
   * per-uid kernel quota at scale — see canvas-file-watcher.ts header).
   * Chokidar in agent-runtime is the single source of truth and bridges
   * its (already-filtered, no-node_modules) event stream into here via
   * `notifyWatchedFileEvent`.
   */
  private watchedFileRegistrations = new Map<string, RegisteredWatcher[]>()

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
      case 'client/registerCapability': {
        // Spec: params.registrations[].{ id, method, registerOptions }
        const params = (message.params as any) ?? {}
        const regs = Array.isArray(params.registrations) ? params.registrations : []
        for (const r of regs) {
          if (r?.method !== 'workspace/didChangeWatchedFiles') continue
          const watchersInput = (r?.registerOptions?.watchers as any[]) ?? []
          const compiled: RegisteredWatcher[] = []
          for (const w of watchersInput) {
            // globPattern can be a string or a `RelativePattern`
            // ({ baseUri, pattern }). tsserver emits strings; we still
            // accept the structured form by extracting `.pattern`.
            const raw = typeof w?.globPattern === 'string'
              ? w.globPattern
              : (typeof w?.globPattern?.pattern === 'string' ? w.globPattern.pattern : null)
            if (!raw) continue
            const kind = typeof w?.kind === 'number'
              ? w.kind
              : (WATCH_KIND_CREATE | WATCH_KIND_CHANGE | WATCH_KIND_DELETE)
            compiled.push({ matcher: compileLspGlob(raw), kind })
          }
          if (compiled.length > 0 && typeof r.id === 'string') {
            this.watchedFileRegistrations.set(r.id, compiled)
          }
        }
        this.send({ jsonrpc: '2.0', id, result: null })
        break
      }
      case 'client/unregisterCapability': {
        const params = (message.params as any) ?? {}
        const unregs = Array.isArray(params.unregisterations) ? params.unregisterations : []
        for (const u of unregs) {
          if (typeof u?.id === 'string') {
            this.watchedFileRegistrations.delete(u.id)
          }
        }
        this.send({ jsonrpc: '2.0', id, result: null })
        break
      }
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

  /**
   * Mark a document as open with caller-supplied version. Idempotent —
   * sending didOpen twice would confuse tsserver, so we collapse a repeat
   * didOpen to a didChange. This is the entry point for IDE clients (Monaco)
   * that drive document state explicitly via dedicated open/change/close
   * notifications, separate from the version-incrementing
   * `notifyFileChanged` used by the workspace file-watcher path.
   */
  didOpenDocument(filePath: string, languageId: string, version: number, text: string): void {
    if (!this.isInitialized || !this.isRunning()) return
    const uri = `file://${filePath}`
    if (this.openDocVersions.has(uri)) {
      // Already open — treat as a full-text didChange so tsserver stays in sync.
      this.didChangeDocument(filePath, version, text)
      return
    }
    this.openDocVersions.set(uri, version)
    this.send({
      jsonrpc: '2.0',
      method: 'textDocument/didOpen',
      params: { textDocument: { uri, languageId, version, text } },
    })
  }

  /**
   * Caller-driven didChange — sends a full-document replacement. Suitable
   * for Monaco's onDidChangeContent firehose where the editor already owns
   * versioning and we don't want to fight it with auto-incremented versions.
   */
  didChangeDocument(filePath: string, version: number, text: string): void {
    if (!this.isInitialized || !this.isRunning()) return
    const uri = `file://${filePath}`
    if (!this.openDocVersions.has(uri)) {
      // Server has no open doc — synthesize the implicit didOpen first.
      this.didOpenDocument(filePath, this.inferLanguageId(filePath), version, text)
      return
    }
    this.openDocVersions.set(uri, version)
    this.send({
      jsonrpc: '2.0',
      method: 'textDocument/didChange',
      params: {
        textDocument: { uri, version },
        contentChanges: [{ text }],
      },
    })
  }

  /** Caller-driven didClose — same wire format as `notifyFileDeleted` but named for the IDE editor-close path. */
  didCloseDocument(filePath: string): void {
    this.notifyFileDeleted(filePath)
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

  /**
   * Bridge a filesystem event into tsserver as `workspace/didChangeWatchedFiles`.
   *
   * Only fires if the path matches a glob the server has registered via
   * `client/registerCapability` and the event kind passes the watcher's
   * kind bitmask. If no registration covers the path, this is a no-op —
   * which is correct: tsserver explicitly told us it doesn't care.
   *
   * Should be called from the workspace's primary file watcher (chokidar
   * in agent-runtime). Live buffers driven by `notifyFileChanged` /
   * `didOpenDocument` already bypass this — tsserver uses the protocol
   * buffer content for those, not on-disk content, so emitting a watched
   * event for them would just cause a redundant disk read.
   */
  notifyWatchedFileEvent(absPath: string, kind: WatchedFileEventKind): void {
    if (!this.isInitialized || !this.isRunning()) return
    if (this.watchedFileRegistrations.size === 0) return
    const kindMask = kind === 'created' ? WATCH_KIND_CREATE
      : kind === 'changed' ? WATCH_KIND_CHANGE
      : WATCH_KIND_DELETE
    let matched = false
    for (const watchers of this.watchedFileRegistrations.values()) {
      for (const w of watchers) {
        if ((w.kind & kindMask) === 0) continue
        if (w.matcher.test(absPath)) {
          matched = true
          break
        }
      }
      if (matched) break
    }
    if (!matched) return
    this.send({
      jsonrpc: '2.0',
      method: 'workspace/didChangeWatchedFiles',
      params: {
        changes: [{ uri: `file://${absPath}`, type: FILE_CHANGE_TYPE[kind] }],
      },
    })
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

  // -------------------------------------------------------------------------
  // Typed request helpers — thin wrappers over `request()` so callers don't
  // have to remember exact LSP method names or param shapes. Return values
  // are passed through verbatim from tsserver; the consumer (Monaco-side
  // adapter or the JSON HTTP route) decides how to convert.
  // -------------------------------------------------------------------------

  async hover(filePath: string, line: number, character: number): Promise<unknown> {
    if (!this.isInitialized || !this.isRunning()) return null
    const uri = `file://${filePath}`
    return this.request('textDocument/hover', {
      textDocument: { uri },
      position: { line, character },
    })
  }

  async completion(
    filePath: string,
    line: number,
    character: number,
    context?: { triggerKind?: number; triggerCharacter?: string },
  ): Promise<unknown> {
    if (!this.isInitialized || !this.isRunning()) return null
    const uri = `file://${filePath}`
    const params: Record<string, unknown> = {
      textDocument: { uri },
      position: { line, character },
    }
    if (context) params.context = context
    return this.request('textDocument/completion', params)
  }

  async definition(filePath: string, line: number, character: number): Promise<unknown> {
    if (!this.isInitialized || !this.isRunning()) return null
    const uri = `file://${filePath}`
    return this.request('textDocument/definition', {
      textDocument: { uri },
      position: { line, character },
    })
  }

  async references(
    filePath: string,
    line: number,
    character: number,
    includeDeclaration = true,
  ): Promise<unknown> {
    if (!this.isInitialized || !this.isRunning()) return null
    const uri = `file://${filePath}`
    return this.request('textDocument/references', {
      textDocument: { uri },
      position: { line, character },
      context: { includeDeclaration },
    })
  }

  async documentSymbol(filePath: string): Promise<unknown> {
    if (!this.isInitialized || !this.isRunning()) return null
    const uri = `file://${filePath}`
    return this.request('textDocument/documentSymbol', { textDocument: { uri } })
  }

  async signatureHelp(filePath: string, line: number, character: number): Promise<unknown> {
    if (!this.isInitialized || !this.isRunning()) return null
    const uri = `file://${filePath}`
    return this.request('textDocument/signatureHelp', {
      textDocument: { uri },
      position: { line, character },
    })
  }

  async rename(filePath: string, line: number, character: number, newName: string): Promise<unknown> {
    if (!this.isInitialized || !this.isRunning()) return null
    const uri = `file://${filePath}`
    return this.request('textDocument/rename', {
      textDocument: { uri },
      position: { line, character },
      newName,
    })
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
      this.watchedFileRegistrations.clear()
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

/**
 * Merge the required `watchOptions.excludeDirectories` entries into the
 * tsconfig at `tsconfigPath` so tsserver doesn't walk `node_modules`/`dist`
 * during program load. No-op when the file is absent or already complete;
 * tolerant of malformed/commented tsconfigs (logged, never throws).
 *
 * Exported (and returns whether it wrote) so the workspace multi-tsconfig
 * behaviour can be unit-tested without standing up a tsserver.
 */
export function patchTsconfigWatchExclusions(tsconfigPath: string): boolean {
  const REQUIRED = ['**/node_modules', '**/dist', '**/.git', '**/.shogo']
  try {
    if (!existsSync(tsconfigPath)) return false
    const raw = readFileSync(tsconfigPath, 'utf-8')
    const config = JSON.parse(raw)

    const existing: string[] = Array.isArray(config.watchOptions?.excludeDirectories)
      ? config.watchOptions.excludeDirectories.filter((x: unknown): x is string => typeof x === 'string')
      : []
    const merged = Array.from(new Set([...existing, ...REQUIRED]))

    if (merged.length === existing.length) return false // nothing to add

    config.watchOptions = {
      ...config.watchOptions,
      excludeDirectories: merged,
    }
    writeFileSync(tsconfigPath, JSON.stringify(config, null, 2) + '\n', 'utf-8')
    console.log(`[LSP-TS] Merged watchOptions.excludeDirectories in ${tsconfigPath}:`, merged)
    return true
  } catch {
    // Non-fatal — tsconfig may have comments or be malformed
    return false
  }
}

export interface WorkspaceLSPManagerOptions {
  projectDir: string
  tsServerBin?: string
  /** Path to the pyright CLI binary (not pyright-langserver) */
  pyrightBin?: string
  /**
   * Extra directories whose `tsconfig.json` should also get the
   * `watchOptions.excludeDirectories` patch on startup. In a workspace
   * runtime `projectDir` is the merged-tree parent (usually with no
   * tsconfig); the real tsconfigs live in each attached `<projectId>/`
   * subfolder. The gateway passes those subfolder paths here so every
   * project's tsserver program load skips `node_modules`/`dist` the same
   * way a single-project runtime does. Unset for single-project runtimes.
   */
  tsconfigDirs?: string[]
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
  private tsconfigDirs: string[]

  constructor(opts: WorkspaceLSPManagerOptions) {
    this.projectDir = resolve(opts.projectDir)
    this.tsServerBin = opts.tsServerBin
    this.pyrightBin = opts.pyrightBin
    this.tsconfigDirs = (opts.tsconfigDirs ?? []).map((d) => resolve(d))
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
        // Belt-and-suspenders: even with `workspace/didChangeWatchedFiles`
        // delegation working (see TSLanguageServer.notifyWatchedFileEvent),
        // tsserver still keeps a small baseline of native watches for
        // tsconfig.json / package.json / ambient .d.ts lookup roots.
        // These prevent that baseline from descending into the dep tree
        // again. We deliberately do NOT set `watchFile: 'fixedChunkSizePolling'`
        // or other polling modes — polling burns CPU and the LSP delegation
        // already gives us the events we need.
        watchOptions: {
          excludeDirectories: [
            '**/node_modules',
            '**/dist',
            '**/dist.canvas.staging',
            '**/dist.staging',
            '**/dist.prev',
            '**/build',
            '**/.git',
            '**/.shogo',
            '**/.next',
            '**/.turbo',
            '**/.cache',
          ],
          excludeFiles: ['**/*.lock', '**/*.lockb', '**/*.log'],
        },
      },
    })
    await this.tsServer.start()
    await this.tsServer.initialize()
  }

  /**
   * Ensure the workspace tsconfig.json has watchOptions.excludeDirectories
   * so tsserver doesn't walk node_modules during program load (separate
   * concern from runtime watching, which is delegated via LSP — see
   * `TSLanguageServer.notifyWatchedFileEvent`).
   *
   * Merges with whatever the user already set rather than early-returning.
   * Pre-fix this skipped any project that already had `excludeDirectories`
   * populated (even with a single unrelated entry like `["**\/dist"]`),
   * which is how staging projects shipped with `**\/node_modules` missing
   * for over a month before the 2026-05 incident.
   */
  private ensureTsconfigWatchExclusions(): void {
    // Single-project: patch the one tsconfig at the project root. Workspace
    // runtime: `projectDir` is the merged-tree parent (typically no
    // tsconfig), so also patch each attached `<projectId>/tsconfig.json`
    // supplied via `tsconfigDirs`. De-duped in case a caller overlaps.
    const dirs = Array.from(new Set([this.projectDir, ...this.tsconfigDirs]))
    for (const dir of dirs) {
      patchTsconfigWatchExclusions(join(dir, 'tsconfig.json'))
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
   * Bridge a workspace filesystem event into the TS LSP as
   * `workspace/didChangeWatchedFiles`. Called from the agent-runtime
   * canvas watcher so chokidar is the only inotify consumer in the pod
   * (tsserver delegates watching to us via the LSP capability handshake).
   *
   * Filtered to TS-relevant extensions because Python diagnostics go
   * through the pyright CLI path, not LSP-watched files.
   */
  notifyWatchedFileEvent(absPath: string, kind: WatchedFileEventKind): void {
    const ext = extOf(absPath)
    // tsserver also asks to watch tsconfig.json / package.json / .d.ts —
    // accept any extension and let the registered glob filter inside
    // TSLanguageServer decide. We only short-circuit for paths that
    // obviously can't be anything tsserver cares about (binaries, lock
    // files, etc.) to keep the per-event hot path cheap.
    if (
      TS_EXTENSIONS.has(ext) ||
      ext === '.json' ||
      ext === '.cjs' ||
      ext === '.mjs' ||
      absPath.endsWith('.d.ts') ||
      absPath.endsWith('/tsconfig.json') ||
      absPath.endsWith('/package.json')
    ) {
      this.tsServer?.notifyWatchedFileEvent(absPath, kind)
    }
  }

  // -------------------------------------------------------------------------
  // IDE-driven document sync — explicit didOpen/didChange/didClose so the
  // Monaco-side LSP adapter can keep tsserver in sync with the live editor
  // buffer (separate from `notifyFileChanged`, which is used by the
  // workspace file-watcher to track on-disk changes).
  // -------------------------------------------------------------------------
  didOpenDocument(filePath: string, languageId: string, version: number, text: string): void {
    const ext = extOf(filePath)
    if (!TS_EXTENSIONS.has(ext)) return
    this.tsServer?.didOpenDocument(filePath, languageId, version, text)
  }

  didChangeDocument(filePath: string, version: number, text: string): void {
    const ext = extOf(filePath)
    if (!TS_EXTENSIONS.has(ext)) return
    this.tsServer?.didChangeDocument(filePath, version, text)
  }

  didCloseDocument(filePath: string): void {
    const ext = extOf(filePath)
    if (!TS_EXTENSIONS.has(ext)) return
    this.tsServer?.didCloseDocument(filePath)
  }

  // -------------------------------------------------------------------------
  // Typed request helpers — only TS files are routed; non-TS extensions
  // return null so the caller doesn't need to switch on language.
  // -------------------------------------------------------------------------

  async hover(filePath: string, line: number, character: number): Promise<unknown> {
    const ext = extOf(filePath)
    if (!TS_EXTENSIONS.has(ext)) return null
    return this.tsServer?.hover(filePath, line, character) ?? null
  }

  async completion(
    filePath: string,
    line: number,
    character: number,
    context?: { triggerKind?: number; triggerCharacter?: string },
  ): Promise<unknown> {
    const ext = extOf(filePath)
    if (!TS_EXTENSIONS.has(ext)) return null
    return this.tsServer?.completion(filePath, line, character, context) ?? null
  }

  async definition(filePath: string, line: number, character: number): Promise<unknown> {
    const ext = extOf(filePath)
    if (!TS_EXTENSIONS.has(ext)) return null
    return this.tsServer?.definition(filePath, line, character) ?? null
  }

  async references(
    filePath: string,
    line: number,
    character: number,
    includeDeclaration = true,
  ): Promise<unknown> {
    const ext = extOf(filePath)
    if (!TS_EXTENSIONS.has(ext)) return null
    return this.tsServer?.references(filePath, line, character, includeDeclaration) ?? null
  }

  async documentSymbol(filePath: string): Promise<unknown> {
    const ext = extOf(filePath)
    if (!TS_EXTENSIONS.has(ext)) return null
    return this.tsServer?.documentSymbol(filePath) ?? null
  }

  async signatureHelp(filePath: string, line: number, character: number): Promise<unknown> {
    const ext = extOf(filePath)
    if (!TS_EXTENSIONS.has(ext)) return null
    return this.tsServer?.signatureHelp(filePath, line, character) ?? null
  }

  async rename(filePath: string, line: number, character: number, newName: string): Promise<unknown> {
    const ext = extOf(filePath)
    if (!TS_EXTENSIONS.has(ext)) return null
    return this.tsServer?.rename(filePath, line, character, newName) ?? null
  }

  /** Returns true once the TS LSP has finished its warmup pass. */
  isTSReady(): boolean {
    return !!this.tsServer?.isRunning()
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
