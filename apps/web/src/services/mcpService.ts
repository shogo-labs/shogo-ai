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

/** Batch tool call request */
export interface BatchToolCall {
  name: string
  arguments: Record<string, any>
}

export class MCPService {
  // Use relative /mcp path by default (proxied by nginx in k8s, Vite in dev)
  // Only use VITE_MCP_URL if explicitly set to a non-empty value
  private baseUrl = import.meta.env.VITE_MCP_URL
    ? `${import.meta.env.VITE_MCP_URL}/mcp`
    : '/mcp'
  private requestId = 0
  private mcpSessionId: string | null = null  // Track MCP session for stateful mode
  private projectId: string | null = null     // Current project ID for schema isolation
  private sseReader: ReadableStreamDefaultReader<Uint8Array> | null = null
  private notificationHandler: ((data: any) => void) | null = null
  private initPromise: Promise<void> | null = null  // Track initialization state

  // Session management helpers
  getMcpSessionId(): string | null { return this.mcpSessionId }
  getProjectId(): string | null { return this.projectId }
  
  /** Set the current project ID - used for schema isolation in all MCP calls */
  setProjectId(projectId: string | null): void {
    this.projectId = projectId
  }
  
  clearSession(): void {
    this.stopSSEListener()
    this.mcpSessionId = null
    this.initPromise = null  // Allow re-initialization
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
   * Ensure session is initialized before making tool calls.
   * Uses a shared promise to prevent multiple concurrent initialization attempts.
   */
  private async ensureInitialized(): Promise<void> {
    if (this.mcpSessionId) return  // Already initialized

    if (!this.initPromise) {
      this.initPromise = this.doInitialize()
    }
    await this.initPromise
  }

  /**
   * Actually perform the MCP session initialization.
   */
  private async doInitialize(): Promise<void> {
    const request = {
      jsonrpc: '2.0',
      id: ++this.requestId,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'shogo-client', version: '1.0.0' }
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
      // Clear the promise so future calls can retry
      this.initPromise = null
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
   * Initialize MCP session (required in stateful mode before tool calls)
   * @deprecated Use ensureInitialized() internally - this is kept for backward compatibility
   */
  async initializeSession(): Promise<void> {
    await this.ensureInitialized()
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
    // Ensure session is initialized before making any tool calls
    await this.ensureInitialized()

    // Inject projectId as workspace if not already provided
    const argsWithWorkspace = this.projectId && !args.workspace
      ? { ...args, workspace: this.projectId }
      : args
    
    const request: MCPToolCall = {
      jsonrpc: '2.0',
      id: ++this.requestId,
      method: 'tools/call',
      params: {
        name: toolName,
        arguments: argsWithWorkspace,
      },
    }

    const headers: HeadersInit = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream'
    }

    // Include session ID (guaranteed to exist after ensureInitialized)
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

  /**
   * Call multiple MCP tools in a single HTTP request using JSON-RPC batch.
   * Returns results in the same order as the input calls.
   *
   * @param calls - Array of tool calls to execute
   * @returns Array of results (or errors) in same order as input
   */
  async callToolsBatch<T = any>(calls: BatchToolCall[]): Promise<Array<{ ok: true; result: T } | { ok: false; error: string }>> {
    if (calls.length === 0) return []

    // Ensure session is initialized before making any tool calls
    await this.ensureInitialized()

    // Build batch request - array of JSON-RPC requests
    // Inject projectId as workspace if not already provided
    const requests = calls.map((call) => ({
      jsonrpc: '2.0' as const,
      id: ++this.requestId,
      method: 'tools/call' as const,
      params: {
        name: call.name,
        arguments: this.projectId && !call.arguments.workspace
          ? { ...call.arguments, workspace: this.projectId }
          : call.arguments,
      },
    }))

    const headers: HeadersInit = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream'
    }

    // Include session ID (guaranteed to exist after ensureInitialized)
    if (this.mcpSessionId) {
      headers['mcp-session-id'] = this.mcpSessionId
    }

    const response = await fetch(this.baseUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(requests),
    })

    if (!response.ok) {
      throw new Error(`MCP batch request failed: ${response.statusText}`)
    }

    const text = await response.text()

    // Parse batch response - could be SSE formatted or plain JSON array
    let responses: MCPResponse<T>[]

    // Try to parse as SSE first (each response on its own line)
    if (text.includes('data: ')) {
      responses = []
      const lines = text.split('\n')
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const parsed = JSON.parse(line.slice(6))
            if (parsed.result || parsed.error) {
              responses.push(parsed)
            }
          } catch { /* skip */ }
        }
      }
    } else {
      // Try plain JSON array
      try {
        responses = JSON.parse(text)
        if (!Array.isArray(responses)) {
          responses = [responses]
        }
      } catch {
        throw new Error('Invalid batch response format')
      }
    }

    // Map responses back by id to maintain order
    const responseById = new Map<number, MCPResponse<T>>()
    for (const resp of responses) {
      responseById.set(resp.id, resp)
    }

    return requests.map((req) => {
      const resp = responseById.get(req.id)
      if (!resp) {
        return { ok: false as const, error: `No response for request ${req.id}` }
      }
      if (resp.error) {
        return { ok: false as const, error: resp.error.message }
      }
      if (!resp.result?.content?.[0]?.text) {
        return { ok: false as const, error: 'Invalid response format' }
      }
      try {
        const parsed = JSON.parse(resp.result.content[0].text)
        return { ok: true as const, result: parsed as T }
      } catch {
        return { ok: false as const, error: 'Failed to parse response' }
      }
    })
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
