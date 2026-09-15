import type { UIMessage } from 'ai'

export type ChatTransport = 'persona' | 'runtime'
export type ChatStatus = 'ready' | 'submitted' | 'streaming' | 'error'

export interface ChatVisitor {
  id?: string
  name?: string
  email?: string
  metadata?: Record<string, unknown>
}

export interface ChatStorage {
  getItem(key: string): string | null | Promise<string | null>
  setItem(key: string, value: string): void | Promise<void>
}

export interface ChatClientConfig {
  apiUrl: string
  projectId: string
  publishableKey?: string
  widgetKey?: string
  transport?: ChatTransport
  agentName?: string
  visitor?: ChatVisitor
  visitorId?: string
  embedOrigin?: string
  storage?: ChatStorage
  fetch?: typeof globalThis.fetch
  apiPath?: string
}

export interface ChatClientEvents {
  delta: { delta: string }
  message: { message: UIMessage }
  'tool-call': { name: string; input: unknown }
  error: { error: unknown }
  status: { status: ChatStatus }
}

export type ChatEventName = keyof ChatClientEvents
export type ChatEventListener<K extends ChatEventName> = (event: ChatClientEvents[K]) => void

export interface ChatClientSnapshot {
  messages: UIMessage[]
  status: ChatStatus
  visitorId: string
  config: Record<string, unknown> | null
  error: unknown
}

const VISITOR_KEY = 'shogo:chat:visitor-id'

export class ChatClient {
  private readonly config: ChatClientConfig
  private readonly fetchImpl: typeof globalThis.fetch
  private readonly storage?: ChatStorage
  private readonly listeners = new Map<ChatEventName, Set<(event: any) => void>>()
  private readonly snapshot: ChatClientSnapshot
  private messageList: UIMessage[] = []
  private runtimeSession: { id: string; token: string } | null = null
  private runtimeEvents: EventSource | null = null
  private persistenceKey = ''

  constructor(config: ChatClientConfig) {
    if (!config.apiUrl) throw new Error('ChatClient requires apiUrl')
    if (!config.projectId) throw new Error('ChatClient requires projectId')
    this.config = { transport: 'persona', ...config }
    this.fetchImpl = config.fetch || globalThis.fetch.bind(globalThis)
    this.storage = config.storage || browserStorage()
    const visitorId = config.visitorId || config.visitor?.id || createVisitorId()
    this.snapshot = {
      messages: this.messageList,
      status: 'ready',
      visitorId,
      config: null,
      error: null,
    }
    this.persistenceKey = `${VISITOR_KEY}:${config.projectId}:${visitorId}`
    void this.restore()
  }

  getSnapshot = (): ChatClientSnapshot => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    const set = this.listenersFor('status')
    set.add(listener as any)
    return () => set.delete(listener as any)
  }

  on<K extends ChatEventName>(event: K, listener: ChatEventListener<K>): () => void {
    const set = this.listenersFor(event)
    set.add(listener as any)
    return () => set.delete(listener as any)
  }

  get messages(): UIMessage[] {
    return this.messagesValue()
  }

  identify(visitor: ChatVisitor): void {
    this.config.visitor = { ...this.config.visitor, ...visitor }
    if (visitor.id) this.snapshot.visitorId = visitor.id
    void this.persist()
    this.emit('status', { status: this.snapshot.status })
  }

  async send(text: string): Promise<void> {
    const value = text.trim()
    if (!value || this.snapshot.status === 'streaming' || this.snapshot.status === 'submitted') return

    const userMessage = createMessage('user', value)
    this.messageList.push(userMessage)
    this.snapshot.messages = this.messageList
    this.snapshot.error = null
    this.setStatus('submitted')

    try {
      const assistant = createMessage('assistant', '')
      this.messageList.push(assistant)
      this.snapshot.messages = this.messageList
      this.setStatus('streaming')
      const response = this.config.transport === 'runtime'
        ? await this.sendRuntime(value)
        : await this.sendPersona()
      await consumeUIStream(response, {
        onEvent: (event) => this.applyStreamEvent(assistant, event),
      })
      const onlyEmptyTextPart =
        assistant.parts.length === 1 &&
        assistant.parts[0]?.type === 'text' &&
        !String((assistant.parts[0] as any).text || '')
      if (onlyEmptyTextPart) {
        this.messageList = this.messageList.filter((message) => message !== assistant)
      }
      this.snapshot.messages = this.messageList
      await this.persist()
      this.emit('message', { message: assistant })
      this.setStatus('ready')
    } catch (error) {
      this.snapshot.error = error
      this.setStatus('error')
      this.emit('error', { error })
    }
  }

  async loadConfig(): Promise<Record<string, unknown> | null> {
    if (this.config.transport !== 'runtime') return null
    const response = await this.runtimeFetch('/config', { headers: this.runtimeAuthHeaders() })
    if (!response.ok) throw await responseError(response)
    const config = await response.json() as Record<string, unknown>
    this.snapshot.config = config
    this.emit('status', { status: this.snapshot.status })
    return config
  }

  async stop(): Promise<void> {
    if (this.config.transport !== 'runtime' || !this.runtimeSession) return
    await this.runtimeFetch('/stop', {
      method: 'POST',
      headers: this.runtimeSessionHeaders(),
    })
  }

  async destroy(): Promise<void> {
    this.runtimeEvents?.close()
    this.runtimeEvents = null
  }

  async initRuntime(): Promise<void> {
    if (this.config.transport !== 'runtime') return
    await this.ensureRuntimeSession()
    await Promise.all([this.loadConfig(), this.loadRuntimeHistory()])
    this.connectRuntimeEvents()
  }

  private async sendPersona(): Promise<Response> {
    const url = new URL(this.config.apiPath || '/api/chat/turn', this.config.apiUrl)
    url.searchParams.set('projectId', this.config.projectId)
    if (this.config.agentName) url.searchParams.set('agentName', this.config.agentName)
    const headers = this.authHeaders()
    headers.set('x-shogo-visitor-id', this.snapshot.visitorId)
    return this.fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        messages: this.messageList.slice(0, -1),
        projectId: this.config.projectId,
        agentName: this.config.agentName,
        visitorId: this.snapshot.visitorId,
        visitor: this.config.visitor,
      }),
    })
  }

  private async sendRuntime(text: string): Promise<Response> {
    await this.ensureRuntimeSession()
    const init: RequestInit = {
      method: 'POST',
      headers: {
        ...this.runtimeSessionHeaders(),
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({
        message: text,
        sessionId: this.runtimeSession!.id,
        visitorId: this.snapshot.visitorId,
        visitor: this.config.visitor,
      }),
    }
    let response = await this.runtimeFetch('/message', init)
    if (response.status === 403) {
      this.runtimeSession = null
      await this.ensureRuntimeSession()
      response = await this.runtimeFetch('/message', {
        ...init,
        headers: {
          ...this.runtimeSessionHeaders(),
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
        body: JSON.stringify({
          message: text,
          sessionId: this.runtimeSession!.id,
          visitorId: this.snapshot.visitorId,
          visitor: this.config.visitor,
        }),
      })
    }
    return response
  }

  private async ensureRuntimeSession(): Promise<void> {
    if (this.runtimeSession) return
    const sessionId = await this.storage?.getItem(`${this.persistenceKey}:session`) || undefined
    const response = await this.runtimeFetch('/session', {
      method: 'POST',
      headers: {
        ...this.runtimeAuthHeaders(),
        'Content-Type': 'application/json',
        ...(sessionId ? { 'X-WebChat-Session': sessionId } : {}),
      },
      body: JSON.stringify({
        visitorId: this.snapshot.visitorId,
        visitor: this.config.visitor,
      }),
    })
    if (!response.ok) throw await responseError(response)
    const data = await response.json() as { sessionId: string; sessionToken: string }
    this.runtimeSession = { id: data.sessionId, token: data.sessionToken }
    await this.storage?.setItem(`${this.persistenceKey}:session`, data.sessionId)
  }

  private async loadRuntimeHistory(): Promise<void> {
    if (!this.runtimeSession) return
    const response = await this.runtimeFetch(
      `/history?sessionId=${encodeURIComponent(this.runtimeSession.id)}`,
      { headers: this.runtimeSessionHeaders() },
    )
    if (!response.ok) return
    const data = await response.json() as { messages?: UIMessage[] }
    if (Array.isArray(data.messages)) {
      this.messageList = data.messages
      this.snapshot.messages = this.messageList
      this.emit('status', { status: this.snapshot.status })
    }
  }

  private connectRuntimeEvents(): void {
    if (typeof EventSource === 'undefined' || !this.runtimeSession) return
    this.runtimeEvents?.close()
    const url = new URL(
      `/agent/channels/webchat/events/${encodeURIComponent(this.runtimeSession.id)}`,
      this.runtimeBaseUrl(),
    )
    url.searchParams.set('sessionToken', this.runtimeSession.token)
    if (this.config.publishableKey) url.searchParams.set('pk', this.config.publishableKey)
    this.runtimeEvents = new EventSource(url)
    this.runtimeEvents.addEventListener('typing', () => this.emit('status', { status: 'streaming' }))
    this.runtimeEvents.addEventListener('message', (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data)
        if (data.type === 'agent_message') this.emit('delta', { delta: data.content || '' })
      } catch {
        // Ignore malformed push events.
      }
    })
  }

  private runtimeFetch(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers)
    if (this.config.publishableKey) headers.set('Authorization', `Bearer ${this.config.publishableKey}`)
    if (this.config.widgetKey) headers.set('X-WebChat-Widget-Key', this.config.widgetKey)
    return this.fetchImpl(`${this.runtimeBaseUrl()}${path}`, { ...init, headers })
  }

  private runtimeBaseUrl(): string {
    const base = this.config.apiUrl.replace(/\/+$/, '')
    if (base.endsWith('/agent-proxy')) return `${base}/agent/channels/webchat`
    return `${base}/api/projects/${encodeURIComponent(this.config.projectId)}/agent-proxy/agent/channels/webchat`
  }

  private authHeaders(): Headers {
    const headers = new Headers({ 'Content-Type': 'application/json', Accept: 'text/event-stream' })
    if (this.config.publishableKey) headers.set('Authorization', `Bearer ${this.config.publishableKey}`)
    if (this.config.embedOrigin) headers.set('X-Shogo-Embed-Origin', this.config.embedOrigin)
    return headers
  }

  private runtimeAuthHeaders(): Record<string, string> {
    const headers: Record<string, string> = {}
    if (this.config.publishableKey) headers.Authorization = `Bearer ${this.config.publishableKey}`
    if (this.config.embedOrigin) headers['X-Shogo-Embed-Origin'] = this.config.embedOrigin
    return headers
  }

  private runtimeSessionHeaders(): Record<string, string> {
    return {
      ...this.runtimeAuthHeaders(),
      'X-WebChat-Session-Token': this.runtimeSession?.token || '',
      'X-WebChat-Session': this.runtimeSession?.id || '',
    }
  }

  private applyStreamEvent(message: UIMessage, event: Record<string, any>): void {
    if (event.type === 'text-delta' || event.type === 'text') {
      const delta = String(event.delta ?? event.text ?? '')
      appendText(message, delta)
      this.emit('delta', { delta })
    } else if (event.type === 'tool-input-start') {
      message.parts.push({
        type: 'dynamic-tool',
        toolCallId: event.toolCallId,
        toolName: event.toolName || event.tool || 'tool',
        state: 'input-streaming',
        input: '',
      } as any)
      this.emit('tool-call', {
        name: String(event.toolName || event.tool || 'tool'),
        input: event.input,
      })
    } else if (event.type === 'tool-input-delta') {
      const part = findToolPart(message, event.toolCallId)
      if (part) part.input = `${part.input || ''}${event.delta || ''}`
    } else if (event.type === 'tool-input-available') {
      const part = findToolPart(message, event.toolCallId)
      if (part) {
        part.state = 'input-available'
        part.input = event.input
      }
    } else if (event.type === 'tool-output-available') {
      const part = findToolPart(message, event.toolCallId)
      if (part) {
        part.state = 'output-available'
        part.output = event.output
      }
    } else if (event.type === 'error') {
      throw new Error(String(event.errorText || event.error || 'Chat stream failed'))
    }
    this.snapshot.messages = this.messageList
    this.emit('status', { status: this.snapshot.status })
  }

  private async restore(): Promise<void> {
    const stored = await this.storage?.getItem(this.persistenceKey)
    if (!stored) return
    try {
      const messages = JSON.parse(stored)
      if (Array.isArray(messages)) {
        this.messageList = messages
        this.snapshot.messages = messages
        this.emit('status', { status: this.snapshot.status })
      }
    } catch {
      // Ignore corrupted local history and start a fresh thread.
    }
  }

  private async persist(): Promise<void> {
    await this.storage?.setItem(this.persistenceKey, JSON.stringify(this.messageList.slice(-100)))
  }

  private setStatus(status: ChatStatus): void {
    this.snapshot.status = status
    this.emit('status', { status })
  }

  private emit<K extends ChatEventName>(event: K, value: ChatClientEvents[K]): void {
    for (const listener of this.listenersFor(event)) listener(value)
  }

  private listenersFor(event: ChatEventName): Set<(event: any) => void> {
    let listeners = this.listeners.get(event)
    if (!listeners) {
      listeners = new Set()
      this.listeners.set(event, listeners)
    }
    return listeners
  }

  private messagesValue(): UIMessage[] {
    return this.messageList
  }
}

export function createChatClient(config: ChatClientConfig): ChatClient {
  return new ChatClient(config)
}

export function createVisitorId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `visitor-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function browserStorage(): ChatStorage | undefined {
  if (typeof localStorage === 'undefined') return undefined
  return {
    getItem: (key) => localStorage.getItem(key),
    setItem: (key, value) => localStorage.setItem(key, value),
  }
}

function createMessage(role: 'user' | 'assistant', text: string): UIMessage {
  return {
    id: `${role}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    role,
    parts: [{ type: 'text', text }],
  } as UIMessage
}

function appendText(message: UIMessage, delta: string): void {
  const parts = message.parts as Array<Record<string, any>>
  const last = parts[parts.length - 1]
  if (last?.type === 'text') last.text = `${last.text || ''}${delta}`
  else parts.push({ type: 'text', text: delta })
}

function findToolPart(
  message: UIMessage,
  toolCallId: string | undefined,
): Record<string, any> | undefined {
  return (message.parts as Array<Record<string, any>>).find(
    (part) =>
      (part.type === 'dynamic-tool' || part.type === 'tool-invocation') &&
      part.toolCallId === toolCallId,
  )
}

function getMessageText(message: UIMessage): string {
  return (message.parts as Array<Record<string, any>>)
    .filter((part) => part.type === 'text')
    .map((part) => String(part.text || ''))
    .join('')
}

async function responseError(response: Response): Promise<Error> {
  let detail = response.statusText
  try {
    const body = await response.json()
    detail = body?.error?.message || body?.error || detail
  } catch {
    // Keep the status text.
  }
  return new Error(`Chat request failed (${response.status}): ${detail}`)
}

async function consumeUIStream(
  response: Response,
  handlers: { onEvent: (event: Record<string, any>) => void },
): Promise<void> {
  if (!response.ok) throw await responseError(response)
  if (!response.body) return
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const frames = buffer.split(/\r?\n\r?\n/)
    buffer = frames.pop() || ''
    for (const frame of frames) {
      const line = frame.split(/\r?\n/).find((item) => item.startsWith('data:'))
      if (!line) continue
      const payload = line.slice(5).trim()
      if (!payload || payload === '[DONE]') continue
      try {
        handlers.onEvent(JSON.parse(payload))
      } catch {
        // AI SDK streams can contain non-JSON control frames. Ignore them.
      }
    }
  }
  if (buffer.startsWith('data:')) {
    const payload = buffer.slice(5).trim()
    if (payload && payload !== '[DONE]') {
      try { handlers.onEvent(JSON.parse(payload)) } catch {}
    }
  }
}
