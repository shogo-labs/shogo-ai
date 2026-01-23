/**
 * LSP Client for Monaco Editor
 * 
 * Connects Monaco editor to a TypeScript Language Server via WebSocket.
 * Provides full IntelliSense, diagnostics, go-to-definition, etc.
 */

import type { Monaco } from '@monaco-editor/react'

// WebSocket connection state
type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error'

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
 * Monaco LSP Client - bridges Monaco to a Language Server via WebSocket
 */
export class MonacoLSPClient {
  private ws: WebSocket | null = null
  private monaco: Monaco | null = null
  private projectId: string
  private state: ConnectionState = 'disconnected'
  private requestId = 0
  private pendingRequests = new Map<number | string, {
    resolve: (result: unknown) => void
    reject: (error: Error) => void
  }>()
  private disposables: Array<{ dispose(): void }> = []
  private reconnectTimer: NodeJS.Timeout | null = null
  private openDocuments = new Map<string, number>() // uri -> version
  private isInitialized = false

  constructor(projectId: string) {
    this.projectId = projectId
  }

  /**
   * Connect to the LSP server and initialize Monaco integration
   */
  async connect(monaco: Monaco): Promise<void> {
    if (this.state === 'connected' || this.state === 'connecting') {
      return
    }

    this.monaco = monaco
    this.state = 'connecting'

    return new Promise(async (resolve, reject) => {
      try {
        // First, get the runtime's direct URL from the API
        const runtimeResponse = await fetch(`/api/projects/${this.projectId}/runtime/status`)
        if (!runtimeResponse.ok) {
          throw new Error('Runtime not available')
        }
        
        const runtimeData = await runtimeResponse.json()
        if (runtimeData.status !== 'running' || !runtimeData.url) {
          throw new Error('Runtime not running')
        }

        // Extract host and port from runtime URL (e.g., "http://localhost:8081")
        const runtimeUrl = new URL(runtimeData.url)
        const wsProtocol = runtimeUrl.protocol === 'https:' ? 'wss:' : 'ws:'
        const wsUrl = `${wsProtocol}//${runtimeUrl.host}/lsp`

        console.log('[LSP Client] Connecting to runtime LSP:', wsUrl)

        this.ws = new WebSocket(wsUrl)

        this.ws.onopen = () => {
          console.log('[LSP Client] Connected')
          this.state = 'connected'
          this.initialize().then(resolve).catch(reject)
        }

        this.ws.onmessage = (event) => {
          try {
            const message = JSON.parse(event.data) as LSPMessage
            this.handleMessage(message)
          } catch (error) {
            console.error('[LSP Client] Failed to parse message:', error)
          }
        }

        this.ws.onerror = (error) => {
          console.error('[LSP Client] WebSocket error:', error)
          this.state = 'error'
          reject(new Error('WebSocket connection failed'))
        }

        this.ws.onclose = () => {
          console.log('[LSP Client] Disconnected')
          this.state = 'disconnected'
          this.cleanup()
          
          // Auto-reconnect after 5 seconds
          if (!this.reconnectTimer) {
            this.reconnectTimer = setTimeout(() => {
              this.reconnectTimer = null
              if (this.monaco) {
                this.connect(this.monaco).catch(console.error)
              }
            }, 5000)
          }
        }

        // Timeout after 10 seconds
        setTimeout(() => {
          if (this.state === 'connecting') {
            this.ws?.close()
            reject(new Error('Connection timeout'))
          }
        }, 10000)
      } catch (error) {
        this.state = 'error'
        reject(error)
      }
    })
  }

  /**
   * Initialize the language server connection
   */
  private async initialize(): Promise<void> {
    if (this.isInitialized || !this.monaco) return

    console.log('[LSP Client] Initializing Monaco integration...')

    // The server handles the LSP initialize request
    // We just need to set up Monaco to forward requests

    // Register completion provider
    this.registerCompletionProvider()
    
    // Register hover provider
    this.registerHoverProvider()
    
    // Register signature help provider
    this.registerSignatureHelpProvider()
    
    // Register definition provider
    this.registerDefinitionProvider()
    
    // Register references provider
    this.registerReferencesProvider()

    // Watch for model changes (file opens/closes)
    this.disposables.push(
      this.monaco.editor.onDidCreateModel((model) => {
        this.didOpenTextDocument(model.uri.toString(), model.getLanguageId(), model.getValue())
      })
    )

    this.disposables.push(
      this.monaco.editor.onWillDisposeModel((model) => {
        this.didCloseTextDocument(model.uri.toString())
      })
    )

    this.isInitialized = true
    console.log('[LSP Client] Monaco integration initialized')
  }

  /**
   * Send an LSP request and wait for response
   */
  private async request(method: string, params?: unknown): Promise<unknown> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Not connected to LSP server')
    }

    const id = ++this.requestId

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject })

      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id)
        reject(new Error(`Request timeout: ${method}`))
      }, 10000)

      // Wrap resolve to clear timeout
      const originalResolve = this.pendingRequests.get(id)!.resolve
      this.pendingRequests.get(id)!.resolve = (result) => {
        clearTimeout(timeout)
        originalResolve(result)
      }

      this.ws!.send(JSON.stringify({
        jsonrpc: '2.0',
        id,
        method,
        params,
      }))
    })
  }

  /**
   * Send an LSP notification (no response expected)
   */
  private notify(method: string, params?: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn('[LSP Client] Cannot send notification, not connected')
      return
    }

    this.ws.send(JSON.stringify({
      jsonrpc: '2.0',
      method,
      params,
    }))
  }

  /**
   * Handle incoming LSP message
   */
  private handleMessage(message: LSPMessage): void {
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
      return
    }

    // Handle server notifications/requests
    if (message.method) {
      this.handleServerMessage(message.method, message.params)
    }
  }

  /**
   * Handle server-initiated messages (diagnostics, etc.)
   */
  private handleServerMessage(method: string, params: unknown): void {
    switch (method) {
      case 'textDocument/publishDiagnostics':
        this.handleDiagnostics(params as { uri: string; diagnostics: unknown[] })
        break
      // Add more handlers as needed
    }
  }

  /**
   * Handle diagnostics from the server
   */
  private handleDiagnostics(params: { uri: string; diagnostics: unknown[] }): void {
    if (!this.monaco) return

    const model = this.monaco.editor.getModels().find(m => m.uri.toString() === params.uri)
    if (!model) return

    // Convert LSP diagnostics to Monaco markers
    const markers = params.diagnostics.map((d: any) => ({
      severity: this.convertSeverity(d.severity),
      startLineNumber: d.range.start.line + 1,
      startColumn: d.range.start.character + 1,
      endLineNumber: d.range.end.line + 1,
      endColumn: d.range.end.character + 1,
      message: d.message,
      source: d.source || 'typescript',
    }))

    this.monaco.editor.setModelMarkers(model, 'typescript', markers)
  }

  /**
   * Convert LSP severity to Monaco severity
   */
  private convertSeverity(severity?: number): number {
    // Monaco MarkerSeverity: 1=Hint, 2=Info, 4=Warning, 8=Error
    switch (severity) {
      case 1: return 8 // Error
      case 2: return 4 // Warning
      case 3: return 2 // Info
      case 4: return 1 // Hint
      default: return 2
    }
  }

  /**
   * Register Monaco completion provider
   */
  private registerCompletionProvider(): void {
    if (!this.monaco) return

    const provider = this.monaco.languages.registerCompletionItemProvider(
      ['typescript', 'javascript', 'typescriptreact', 'javascriptreact'],
      {
        triggerCharacters: ['.', '"', "'", '/', '@', '<'],
        provideCompletionItems: async (model, position, context) => {
          try {
            const result = await this.request('textDocument/completion', {
              textDocument: { uri: model.uri.toString() },
              position: { line: position.lineNumber - 1, character: position.column - 1 },
              context: {
                triggerKind: context.triggerKind,
                triggerCharacter: context.triggerCharacter,
              },
            })

            if (!result) return { suggestions: [] }

            const items = Array.isArray(result) ? result : (result as any).items || []
            
            return {
              suggestions: items.map((item: any) => ({
                label: item.label,
                kind: this.convertCompletionKind(item.kind),
                detail: item.detail,
                documentation: item.documentation,
                insertText: item.insertText || item.label,
                insertTextRules: item.insertTextFormat === 2 
                  ? this.monaco!.languages.CompletionItemInsertTextRule.InsertAsSnippet 
                  : undefined,
                range: {
                  startLineNumber: position.lineNumber,
                  startColumn: position.column - (item.textEdit?.range?.start?.character || 0),
                  endLineNumber: position.lineNumber,
                  endColumn: position.column,
                },
              })),
            }
          } catch (error) {
            console.error('[LSP Client] Completion error:', error)
            return { suggestions: [] }
          }
        },
      }
    )

    this.disposables.push(provider)
  }

  /**
   * Convert LSP completion kind to Monaco
   */
  private convertCompletionKind(kind?: number): number {
    // LSP CompletionItemKind to Monaco CompletionItemKind
    const kindMap: Record<number, number> = {
      1: 4,   // Text -> Method (close enough)
      2: 0,   // Method -> Method
      3: 1,   // Function -> Function
      4: 4,   // Constructor -> Constructor
      5: 4,   // Field -> Field
      6: 5,   // Variable -> Variable
      7: 7,   // Class -> Class
      8: 8,   // Interface -> Interface
      9: 9,   // Module -> Module
      10: 10, // Property -> Property
      11: 11, // Unit -> Unit
      12: 12, // Value -> Value
      13: 13, // Enum -> Enum
      14: 14, // Keyword -> Keyword
      15: 15, // Snippet -> Snippet
      16: 16, // Color -> Color
      17: 17, // File -> File
      18: 18, // Reference -> Reference
      19: 19, // Folder -> Folder
      20: 20, // EnumMember -> EnumMember
      21: 21, // Constant -> Constant
      22: 22, // Struct -> Struct
      23: 23, // Event -> Event
      24: 24, // Operator -> Operator
      25: 25, // TypeParameter -> TypeParameter
    }
    return kindMap[kind || 1] || 4
  }

  /**
   * Register Monaco hover provider
   */
  private registerHoverProvider(): void {
    if (!this.monaco) return

    const provider = this.monaco.languages.registerHoverProvider(
      ['typescript', 'javascript', 'typescriptreact', 'javascriptreact'],
      {
        provideHover: async (model, position) => {
          try {
            const result = await this.request('textDocument/hover', {
              textDocument: { uri: model.uri.toString() },
              position: { line: position.lineNumber - 1, character: position.column - 1 },
            }) as any

            if (!result) return null

            return {
              contents: Array.isArray(result.contents)
                ? result.contents.map((c: any) => ({
                    value: typeof c === 'string' ? c : c.value,
                    isTrusted: true,
                  }))
                : [{ value: typeof result.contents === 'string' ? result.contents : result.contents.value }],
              range: result.range ? {
                startLineNumber: result.range.start.line + 1,
                startColumn: result.range.start.character + 1,
                endLineNumber: result.range.end.line + 1,
                endColumn: result.range.end.character + 1,
              } : undefined,
            }
          } catch (error) {
            console.error('[LSP Client] Hover error:', error)
            return null
          }
        },
      }
    )

    this.disposables.push(provider)
  }

  /**
   * Register Monaco signature help provider
   */
  private registerSignatureHelpProvider(): void {
    if (!this.monaco) return

    const provider = this.monaco.languages.registerSignatureHelpProvider(
      ['typescript', 'javascript', 'typescriptreact', 'javascriptreact'],
      {
        signatureHelpTriggerCharacters: ['(', ','],
        provideSignatureHelp: async (model, position) => {
          try {
            const result = await this.request('textDocument/signatureHelp', {
              textDocument: { uri: model.uri.toString() },
              position: { line: position.lineNumber - 1, character: position.column - 1 },
            }) as any

            if (!result) return null

            return {
              value: {
                signatures: result.signatures.map((sig: any) => ({
                  label: sig.label,
                  documentation: sig.documentation,
                  parameters: sig.parameters?.map((p: any) => ({
                    label: p.label,
                    documentation: p.documentation,
                  })) || [],
                })),
                activeSignature: result.activeSignature || 0,
                activeParameter: result.activeParameter || 0,
              },
              dispose: () => {},
            }
          } catch (error) {
            console.error('[LSP Client] Signature help error:', error)
            return null
          }
        },
      }
    )

    this.disposables.push(provider)
  }

  /**
   * Register Monaco definition provider
   */
  private registerDefinitionProvider(): void {
    if (!this.monaco) return

    const provider = this.monaco.languages.registerDefinitionProvider(
      ['typescript', 'javascript', 'typescriptreact', 'javascriptreact'],
      {
        provideDefinition: async (model, position) => {
          try {
            const result = await this.request('textDocument/definition', {
              textDocument: { uri: model.uri.toString() },
              position: { line: position.lineNumber - 1, character: position.column - 1 },
            }) as any

            if (!result) return null

            const locations = Array.isArray(result) ? result : [result]
            
            return locations.map((loc: any) => ({
              uri: this.monaco!.Uri.parse(loc.uri),
              range: {
                startLineNumber: loc.range.start.line + 1,
                startColumn: loc.range.start.character + 1,
                endLineNumber: loc.range.end.line + 1,
                endColumn: loc.range.end.character + 1,
              },
            }))
          } catch (error) {
            console.error('[LSP Client] Definition error:', error)
            return null
          }
        },
      }
    )

    this.disposables.push(provider)
  }

  /**
   * Register Monaco references provider
   */
  private registerReferencesProvider(): void {
    if (!this.monaco) return

    const provider = this.monaco.languages.registerReferenceProvider(
      ['typescript', 'javascript', 'typescriptreact', 'javascriptreact'],
      {
        provideReferences: async (model, position, context) => {
          try {
            const result = await this.request('textDocument/references', {
              textDocument: { uri: model.uri.toString() },
              position: { line: position.lineNumber - 1, character: position.column - 1 },
              context: { includeDeclaration: context.includeDeclaration },
            }) as any[]

            if (!result) return null

            return result.map((loc: any) => ({
              uri: this.monaco!.Uri.parse(loc.uri),
              range: {
                startLineNumber: loc.range.start.line + 1,
                startColumn: loc.range.start.character + 1,
                endLineNumber: loc.range.end.line + 1,
                endColumn: loc.range.end.character + 1,
              },
            }))
          } catch (error) {
            console.error('[LSP Client] References error:', error)
            return null
          }
        },
      }
    )

    this.disposables.push(provider)
  }

  /**
   * Notify server that a document was opened
   */
  didOpenTextDocument(uri: string, languageId: string, text: string): void {
    if (this.openDocuments.has(uri)) return

    this.openDocuments.set(uri, 1)
    this.notify('textDocument/didOpen', {
      textDocument: {
        uri,
        languageId,
        version: 1,
        text,
      },
    })
  }

  /**
   * Notify server that a document was changed
   */
  didChangeTextDocument(uri: string, text: string): void {
    const version = (this.openDocuments.get(uri) || 0) + 1
    this.openDocuments.set(uri, version)

    this.notify('textDocument/didChange', {
      textDocument: { uri, version },
      contentChanges: [{ text }],
    })
  }

  /**
   * Notify server that a document was closed
   */
  didCloseTextDocument(uri: string): void {
    if (!this.openDocuments.has(uri)) return

    this.openDocuments.delete(uri)
    this.notify('textDocument/didClose', {
      textDocument: { uri },
    })
  }

  /**
   * Cleanup resources
   */
  private cleanup(): void {
    for (const disposable of this.disposables) {
      disposable.dispose()
    }
    this.disposables = []
    this.isInitialized = false
  }

  /**
   * Disconnect from the LSP server
   */
  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }

    if (this.ws) {
      this.ws.close()
      this.ws = null
    }

    this.cleanup()
    this.state = 'disconnected'
  }

  /**
   * Get current connection state
   */
  getState(): ConnectionState {
    return this.state
  }
}

// Cache of LSP clients per project
const lspClients = new Map<string, MonacoLSPClient>()

/**
 * Get or create an LSP client for a project
 */
export function getLSPClient(projectId: string): MonacoLSPClient {
  let client = lspClients.get(projectId)
  if (!client) {
    client = new MonacoLSPClient(projectId)
    lspClients.set(projectId, client)
  }
  return client
}

/**
 * Disconnect all LSP clients
 */
export function disconnectAllLSPClients(): void {
  for (const client of lspClients.values()) {
    client.disconnect()
  }
  lspClients.clear()
}
