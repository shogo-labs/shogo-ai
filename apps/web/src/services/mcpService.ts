export interface MCPToolCall {
  jsonrpc: '2.0'
  id: number
  method: 'tools/call'
  params: {
    name: string
    arguments: Record<string, any>
  }
}

export interface MCPResponse<T = any> {
  jsonrpc: '2.0'
  id: number
  result?: {
    content: Array<{ type: string; text: string }>
  }
  error?: {
    code: number
    message: string
  }
}

export class MCPService {
  private baseUrl = `${import.meta.env.VITE_MCP_URL || 'http://localhost:3100'}/mcp`
  private requestId = 0
  private mcpSessionId: string | null = null  // Track MCP session for stateful mode
  private sseReader: ReadableStreamDefaultReader<Uint8Array> | null = null
  private notificationHandler: ((data: any) => void) | null = null

  // Session management helpers
  getMcpSessionId(): string | null { return this.mcpSessionId }
  clearSession(): void {
    this.stopSSEListener()
    this.mcpSessionId = null
  }

  // Notification handler for streaming events
  onNotification(handler: (data: any) => void): void {
    this.notificationHandler = handler
  }

  /**
   * Start persistent GET SSE listener for notifications (stateful mode)
   * Notifications from context.streamContent() arrive on this stream
   */
  async startSSEListener(): Promise<void> {
    if (!this.mcpSessionId) {
      throw new Error('Must initialize session before starting SSE listener')
    }
    if (this.sseReader) return  // Already listening

    const response = await fetch(this.baseUrl, {
      method: 'GET',
      headers: {
        'Accept': 'text/event-stream',
        'mcp-session-id': this.mcpSessionId,
      },
    })

    if (!response.ok) {
      throw new Error(`SSE listener failed: ${response.statusText}`)
    }

    this.sseReader = response.body?.getReader() || null
    if (!this.sseReader) return

    const decoder = new TextDecoder()
    let buffer = ''

      // Process SSE stream in background (async IIFE)
      ; (async () => {
        try {
          while (this.sseReader) {
            const { done, value } = await this.sseReader.read()
            if (done) break

            buffer += decoder.decode(value, { stream: true })
            const events = buffer.split('\n\n')
            buffer = events.pop() || ''

            for (const event of events) {
              if (!event.trim()) continue
              const lines = event.split('\n')
              for (const line of lines) {
                if (line.startsWith('data: ')) {
                  try {
                    const data = JSON.parse(line.slice(6))
                    // Route streaming notifications to handler
                    if (data.method === 'notifications/tool/streamContent') {
                      this.notificationHandler?.(data)
                    }
                  } catch (e) { /* skip non-JSON */ }
                }
              }
            }
          }
        } catch (e) {
          console.debug('SSE listener ended:', e)
        }
      })()
  }

  stopSSEListener(): void {
    this.sseReader?.cancel()
    this.sseReader = null
  }

  /**
   * Initialize MCP session (required in stateful mode before tool calls)
   */
  async initializeSession(): Promise<void> {
    if (this.mcpSessionId) return  // Already initialized

    const request = {
      jsonrpc: '2.0',
      id: ++this.requestId,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'wavesmith-client', version: '1.0.0' }
      }
    }

    const response = await fetch(this.baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
      },
      body: JSON.stringify(request),
    })

    if (!response.ok) {
      throw new Error(`MCP initialize failed: ${response.statusText}`)
    }

    // Capture session ID from response header
    const sessionId = response.headers.get('mcp-session-id')
    if (sessionId) {
      this.mcpSessionId = sessionId
    }

    // Consume response body
    await response.text()
  }

  /**
   * Parse SSE-formatted response to extract final JSON-RPC result
   * SSE format: "event: message\ndata: {json}\n\n"
   * With streaming, there may be multiple data: lines - we want the one with `result`
   * Falls back to parsing entire text as JSON if not SSE format
   */
  private parseSSEResponse<T = any>(text: string): MCPResponse<T> {
    const lines = text.split('\n')
    let lastValidResponse: MCPResponse<T> | null = null

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        try {
          const parsed = JSON.parse(line.slice(6))
          // Look for the final result (has `result` or `error` field, not a notification)
          if (parsed.result || parsed.error) {
            lastValidResponse = parsed
          }
        } catch {
          continue
        }
      }
    }

    if (lastValidResponse) {
      return lastValidResponse
    }

    // Fallback: try parsing entire text as JSON (in case server returns JSON directly)
    return JSON.parse(text)
  }

  async callTool<T = any>(
    toolName: string,
    args: Record<string, any>
  ): Promise<T> {
    const request: MCPToolCall = {
      jsonrpc: '2.0',
      id: ++this.requestId,
      method: 'tools/call',
      params: {
        name: toolName,
        arguments: args,
      },
    }

    const headers: HeadersInit = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream'
    }

    // Include session ID if available (stateful MCP server)
    if (this.mcpSessionId) {
      headers['mcp-session-id'] = this.mcpSessionId
    }

    const response = await fetch(this.baseUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(request),
    })

    if (!response.ok) {
      throw new Error(`MCP request failed: ${response.statusText}`)
    }

    // Parse SSE response format (stateful mode returns SSE even for simple calls)
    const text = await response.text()
    const data: MCPResponse<T> = this.parseSSEResponse(text)

    if (data.error) {
      throw new Error(`MCP tool error: ${data.error.message}`)
    }

    if (!data.result?.content?.[0]?.text) {
      console.error('[mcpService.callTool] Invalid response format, data:', data)
      throw new Error('Invalid MCP response format')
    }

    const parsed = JSON.parse(data.result.content[0].text)
    return parsed
  }

  async generateSchema(intent: string, options?: {
    workspace?: string
    validateReferences?: boolean
    autoSave?: boolean
  }): Promise<{
    ok: boolean
    schemaName?: string
    message?: string
    error?: { code: string; message: string }
  }> {
    return this.callTool('agent.generateSchema', {
      intent,
      options: {
        autoSave: true,
        validateReferences: false,
        ...options,
      },
    })
  }

  async listSchemas(): Promise<string[]> {
    const result = await this.callTool('schema.list', {})
    // Result.schemas is array of {name, id, createdAt, path} objects - extract names
    return (result.schemas || []).map((s: any) => s.name)
  }

  async loadSchema(schemaName: string, workspace?: string): Promise<any> {
    return this.callTool('schema.load', {
      name: schemaName,
      workspace
    })
  }

  async chat(message: string, sessionId?: string): Promise<{
    ok: boolean
    sessionId?: string
    response?: string
    toolCalls?: Array<{ tool: string; args: any; result?: string }>
    error?: { code: string; message: string }
  }> {
    const result = await this.callTool('agent.chat', {
      message,
      ...(sessionId && { sessionId }),
    })
    return result
  }

  /**
   * Stream chat responses via SSE.
   * Text deltas arrive via onDelta callback, final metadata via onComplete.
   */
  async streamChat(
    message: string,
    sessionId: string | null,
    onDelta: (text: string) => void,
    onComplete: (result: { ok: boolean; sessionId?: string; toolCalls?: any[]; error?: any }) => void,
    onError: (error: Error) => void
  ): Promise<void> {
    // Initialize session first if needed (stateful mode)
    try {
      await this.initializeSession()
    } catch (initError: any) {
      onError(initError)
      return
    }

    const request: MCPToolCall = {
      jsonrpc: '2.0',
      id: ++this.requestId,
      method: 'tools/call',
      params: {
        name: 'agent.chat',
        arguments: { message, ...(sessionId && { sessionId }) },
      },
    }

    try {
      const headers: HeadersInit = {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
      }

      // Include MCP session ID on subsequent requests (stateful mode)
      if (this.mcpSessionId) {
        headers['mcp-session-id'] = this.mcpSessionId
      }

      const response = await fetch(this.baseUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(request),
      })

      if (!response.ok) {
        throw new Error(`MCP request failed: ${response.statusText}`)
      }

      // Capture MCP session ID from response header
      const responseSessionId = response.headers.get('mcp-session-id')
      if (responseSessionId) {
        this.mcpSessionId = responseSessionId
      }

      const reader = response.body?.getReader()
      if (!reader) {
        throw new Error('No response body reader available')
      }

      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })

        // Process complete SSE events (separated by double newlines)
        const events = buffer.split('\n\n')
        buffer = events.pop() || '' // Keep incomplete event in buffer

        for (const event of events) {
          if (!event.trim()) continue

          // Parse SSE event lines
          const lines = event.split('\n')
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                const data = JSON.parse(line.slice(6))

                // Handle streamed content notification
                if (data.method === 'notifications/tool/streamContent') {
                  const contentArray = data.params?.content
                  if (Array.isArray(contentArray)) {
                    for (const item of contentArray) {
                      if (item?.type === 'text' && item?.text) {
                        onDelta(item.text)
                      }
                    }
                  }
                }

                // Handle final result
                if (data.result?.content?.[0]?.text) {
                  const result = JSON.parse(data.result.content[0].text)
                  onComplete(result)
                }

                // Handle error response
                if (data.error) {
                  onError(new Error(data.error.message || 'MCP error'))
                }
              } catch (parseError) {
                // Skip non-JSON lines (like event: or id: lines)
                console.debug('SSE parse skip:', line)
              }
            }
          }
        }
      }
    } catch (error: any) {
      onError(error)
    }
  }
}

export const mcpService = new MCPService()
