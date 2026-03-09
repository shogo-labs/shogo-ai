// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * TypeScript Language Server Service
 * 
 * Provides LSP (Language Server Protocol) support for Monaco editor.
 * Uses typescript-language-server which wraps tsserver with a proper LSP interface.
 * 
 * Features:
 * - Spawns typescript-language-server with proper configuration
 * - Handles standard LSP JSON-RPC protocol over WebSocket
 * - Provides full IntelliSense, diagnostics, go-to-definition, etc.
 */

import { spawn, type Subprocess } from 'bun'
import { existsSync } from 'fs'
import { join, dirname } from 'path'

// LSP message types
interface LSPMessage {
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

/**
 * TypeScript Language Server instance
 */
export class TSLanguageServer {
  private process: Subprocess<'pipe', 'pipe', 'pipe'> | null = null
  private projectDir: string
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

  constructor(projectDir: string) {
    this.projectDir = projectDir
  }

  /**
   * Start the TypeScript language server
   */
  async start(): Promise<void> {
    if (this.process) {
      console.log('[LSP] Server already running')
      return
    }

    // Find typescript-language-server - check multiple locations
    const possiblePaths = [
      // Project's node_modules
      join(this.projectDir, 'node_modules', '.bin', 'typescript-language-server'),
      // project-runtime's node_modules (where we installed it)
      join(dirname(dirname(import.meta.path)), 'node_modules', '.bin', 'typescript-language-server'),
      // Global fallback
      'typescript-language-server',
    ]

    let serverPath = 'typescript-language-server'
    for (const path of possiblePaths) {
      if (path === 'typescript-language-server' || existsSync(path)) {
        serverPath = path
        break
      }
    }

    console.log(`[LSP] Starting TypeScript language server from: ${serverPath}`)
    console.log(`[LSP] Project directory: ${this.projectDir}`)

    try {
      // typescript-language-server uses --stdio for LSP communication
      // It will automatically find TypeScript from the project's node_modules
      const args = ['--stdio', '--log-level', '3']

      this.process = spawn([serverPath, ...args], {
        cwd: this.projectDir,
        env: {
          ...process.env,
          // Enable logging for debugging
          TSS_LOG: '-level verbose -file /tmp/tsserver.log',
        },
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      })

      // Read stdout for LSP responses
      this.readOutputStream()

      // Log stderr for debugging
      this.readErrorStream()

      // Wait for process to be ready
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Timeout waiting for typescript-language-server to start'))
        }, 10000)

        // Check if process started successfully
        if (this.process?.exitCode !== null) {
          clearTimeout(timeout)
          reject(new Error(`typescript-language-server exited with code ${this.process?.exitCode}`))
          return
        }

        // Process started, now initialize
        clearTimeout(timeout)
        resolve()
      })

      console.log('[LSP] TypeScript language server started successfully')
    } catch (error) {
      console.error('[LSP] Failed to start typescript-language-server:', error)
      this.process = null
      throw error
    }
  }

  /**
   * Read and parse LSP messages from stdout
   */
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
    } catch (error) {
      console.error('[LSP] Error reading stdout:', error)
    }
  }

  /**
   * Read and log stderr
   */
  private async readErrorStream() {
    if (!this.process?.stderr) return

    const reader = this.process.stderr.getReader()
    const decoder = new TextDecoder()

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        const text = decoder.decode(value, { stream: true })
        if (text.trim()) {
          console.log('[LSP stderr]', text.trim())
        }
      }
    } catch (error) {
      // Ignore stderr read errors
    }
  }

  /**
   * Process the message buffer for complete LSP messages
   */
  private processBuffer() {
    while (true) {
      // Parse Content-Length header if not yet parsed
      if (this.contentLength === -1) {
        const headerEnd = this.messageBuffer.indexOf('\r\n\r\n')
        if (headerEnd === -1) return

        const header = this.messageBuffer.substring(0, headerEnd)
        const match = header.match(/Content-Length:\s*(\d+)/i)
        if (!match) {
          console.error('[LSP] Invalid message header:', header)
          this.messageBuffer = this.messageBuffer.substring(headerEnd + 4)
          continue
        }

        this.contentLength = parseInt(match[1], 10)
        this.messageBuffer = this.messageBuffer.substring(headerEnd + 4)
      }

      // Check if we have the complete message body
      if (this.messageBuffer.length < this.contentLength) return

      // Extract and parse the message
      const messageText = this.messageBuffer.substring(0, this.contentLength)
      this.messageBuffer = this.messageBuffer.substring(this.contentLength)
      this.contentLength = -1

      try {
        const message = JSON.parse(messageText) as LSPMessage

        // Handle response to our request
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

        // Notify all handlers
        for (const handler of this.messageHandlers) {
          handler(message)
        }
      } catch (error) {
        console.error('[LSP] Failed to parse message:', error)
      }
    }
  }

  /**
   * Send a message to tsserver
   */
  send(message: LSPMessage): void {
    if (!this.process?.stdin) {
      throw new Error('tsserver not running')
    }

    const content = JSON.stringify(message)
    const header = `Content-Length: ${Buffer.byteLength(content)}\r\n\r\n`
    
    // Bun's stdin is a FileSink, use .write() directly
    this.process.stdin.write(header + content)
  }

  /**
   * Send a request and wait for response
   */
  async request(method: string, params?: unknown): Promise<unknown> {
    const id = ++this.requestId

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject })
      
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id)
        reject(new Error(`Request timeout: ${method}`))
      }, 30000)

      this.send({
        jsonrpc: '2.0',
        id,
        method,
        params,
      })

      // Wrap resolve to clear timeout
      const originalResolve = resolve
      this.pendingRequests.get(id)!.resolve = (result) => {
        clearTimeout(timeout)
        originalResolve(result)
      }
    })
  }

  /**
   * Initialize the language server with LSP initialize request
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) return
    if (this.initPromise) return this.initPromise

    this.initPromise = (async () => {
      console.log('[LSP] Initializing language server...')

      const initResult = await this.request('initialize', {
        processId: process.pid,
        rootUri: `file://${this.projectDir}`,
        rootPath: this.projectDir,
        capabilities: {
          textDocument: {
            synchronization: {
              dynamicRegistration: true,
              willSave: true,
              willSaveWaitUntil: true,
              didSave: true,
            },
            completion: {
              dynamicRegistration: true,
              completionItem: {
                snippetSupport: true,
                commitCharactersSupport: true,
                documentationFormat: ['markdown', 'plaintext'],
                deprecatedSupport: true,
                preselectSupport: true,
              },
              contextSupport: true,
            },
            hover: {
              dynamicRegistration: true,
              contentFormat: ['markdown', 'plaintext'],
            },
            signatureHelp: {
              dynamicRegistration: true,
              signatureInformation: {
                documentationFormat: ['markdown', 'plaintext'],
                parameterInformation: {
                  labelOffsetSupport: true,
                },
              },
            },
            definition: { dynamicRegistration: true },
            references: { dynamicRegistration: true },
            documentHighlight: { dynamicRegistration: true },
            documentSymbol: {
              dynamicRegistration: true,
              symbolKind: { valueSet: Array.from({ length: 26 }, (_, i) => i + 1) },
            },
            codeAction: {
              dynamicRegistration: true,
              codeActionLiteralSupport: {
                codeActionKind: {
                  valueSet: [
                    'quickfix',
                    'refactor',
                    'refactor.extract',
                    'refactor.inline',
                    'refactor.rewrite',
                    'source',
                    'source.organizeImports',
                  ],
                },
              },
            },
            rename: { dynamicRegistration: true, prepareSupport: true },
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
            symbol: {
              dynamicRegistration: true,
              symbolKind: { valueSet: Array.from({ length: 26 }, (_, i) => i + 1) },
            },
            workspaceFolders: true,
            configuration: true,
          },
        },
        initializationOptions: {
          preferences: {
            includeInlayParameterNameHints: 'all',
            includeInlayParameterNameHintsWhenArgumentMatchesName: true,
            includeInlayFunctionParameterTypeHints: true,
            includeInlayVariableTypeHints: true,
            includeInlayPropertyDeclarationTypeHints: true,
            includeInlayFunctionLikeReturnTypeHints: true,
          },
        },
      })

      console.log('[LSP] Initialize response:', JSON.stringify(initResult).substring(0, 200))

      // Send initialized notification
      this.send({
        jsonrpc: '2.0',
        method: 'initialized',
        params: {},
      })

      this.isInitialized = true
      console.log('[LSP] Language server initialized')
    })()

    return this.initPromise
  }

  /**
   * Add a message handler
   */
  onMessage(handler: (msg: LSPMessage) => void): () => void {
    this.messageHandlers.add(handler)
    return () => this.messageHandlers.delete(handler)
  }

  /**
   * Stop the language server
   */
  stop(): void {
    if (this.process) {
      console.log('[LSP] Stopping TypeScript language server')
      this.process.kill()
      this.process = null
      this.isInitialized = false
      this.initPromise = null
      this.messageBuffer = ''
      this.contentLength = -1
      this.pendingRequests.clear()
    }
  }

  /**
   * Check if the server is running
   */
  isRunning(): boolean {
    return this.process !== null && this.process.exitCode === null
  }
}

/**
 * LSP Server Manager - manages server instances per project
 */
class LSPServerManager {
  private servers = new Map<string, TSLanguageServer>()

  /**
   * Get or create a language server for a project
   * Note: Does NOT auto-initialize - client should send initialize request
   */
  async getServer(projectDir: string): Promise<TSLanguageServer> {
    let server = this.servers.get(projectDir)
    
    if (!server || !server.isRunning()) {
      server = new TSLanguageServer(projectDir)
      this.servers.set(projectDir, server)
      await server.start()
      // Don't initialize here - let the client send initialize request
      // This allows proper LSP handshake where client controls initialization
    }

    return server
  }

  /**
   * Stop a specific server
   */
  stopServer(projectDir: string): void {
    const server = this.servers.get(projectDir)
    if (server) {
      server.stop()
      this.servers.delete(projectDir)
    }
  }

  /**
   * Stop all servers
   */
  stopAll(): void {
    for (const [projectDir, server] of this.servers) {
      server.stop()
      this.servers.delete(projectDir)
    }
  }
}

// Export singleton manager
export const lspManager = new LSPServerManager()
