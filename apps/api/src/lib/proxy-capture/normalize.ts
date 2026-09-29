import { createHash } from 'node:crypto'

const DATA_URL_RE = /^data:([^;,]+)(?:;[^,]*)?,([A-Za-z0-9+/=\s]+)$/i
const SECRET_HEADER_RE = /^(authorization|x-api-key|api-key|cookie|set-cookie)$/i

export interface NormalizedCapture {
  request: unknown
  response?: unknown
  source: 'desktop_proxy' | 'cloud_runtime' | 'api_key' | 'internal'
  provider: string
  requestedModel: string | null
  resolvedModel: string | null
  turnKey: string
  userText: string | null
  assistantText: string | null
  toolNames: string[]
  media: Array<{ hash: string; mime: string; bytes: Buffer }>
  reasoningEffort: string | null
}

type BlobWriter = (key: string, value: unknown) => void

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function collectMedia(value: unknown, media: NormalizedCapture['media']): unknown {
  if (typeof value === 'string') {
    const match = DATA_URL_RE.exec(value)
    if (!match) return value
    const bytes = Buffer.from(match[2].replace(/\s/g, ''), 'base64')
    const hash = sha256(bytes)
    if (!media.some((item) => item.hash === hash)) {
      media.push({ hash, mime: match[1], bytes })
    }
    return { $media: hash, mime: match[1] }
  }
  if (Array.isArray(value)) return value.map((item) => collectMedia(item, media))
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      collectMedia(item, media),
    ]),
  )
}

function toBlobRef(value: unknown, kind: string, writeBlob: BlobWriter): { $ref: string; kind: string } {
  const key = `v1/blobs/${sha256(stableStringify(value))}.json.gz`
  writeBlob(key, value)
  return { $ref: key, kind }
}

function isDedupable(value: unknown): boolean {
  return (Array.isArray(value) && value.length > 0) || (typeof value === 'string' && value.length > 0)
}

function deduplicateRequest(value: any, writeBlob: BlobWriter, media: NormalizedCapture['media']): any {
  const clone = collectMedia(value, media) as any
  if (clone && typeof clone === 'object') {
    if (isDedupable(clone.system)) clone.system = toBlobRef(clone.system, 'system', writeBlob)
    if (isDedupable(clone.instructions)) clone.instructions = toBlobRef(clone.instructions, 'system', writeBlob)
    if (Array.isArray(clone.tools) && clone.tools.length > 0) clone.tools = toBlobRef(clone.tools, 'tools', writeBlob)
    for (const listKey of ['messages', 'input']) {
      const list = clone[listKey]
      if (!Array.isArray(list)) continue
      for (const message of list) {
        if (!message || (message.role !== 'system' && message.role !== 'developer')) break
        if (isDedupable(message.content)) message.content = toBlobRef(message.content, 'system', writeBlob)
      }
    }
  }
  return clone
}

function messageText(message: any): string {
  if (typeof message?.content === 'string') return message.content
  if (!Array.isArray(message?.content)) return ''
  return message.content
    .map((part: any) => part?.text || part?.content || '')
    .filter(Boolean)
    .join('\n')
}

function getMessages(request: any): any[] {
  if (Array.isArray(request?.messages)) return request.messages
  if (Array.isArray(request?.input)) {
    return request.input.filter((item: any) => item && typeof item === 'object')
  }
  return []
}

export function extractUserText(request: any): string | null {
  if (typeof request?.input === 'string') return request.input.trim() || null
  const messages = getMessages(request)
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') {
      const text = messageText(messages[index]).trim()
      if (text) return text
    }
  }
  return null
}

export function extractToolNames(request: any): string[] {
  const names = new Set<string>()
  const tools = Array.isArray(request?.tools) ? request.tools : []
  for (const tool of tools) {
    const name = tool?.function?.name || tool?.name
    if (typeof name === 'string' && name) names.add(name)
  }
  for (const message of getMessages(request)) {
    for (const call of message?.tool_calls || []) {
      const name = call?.function?.name || call?.name
      if (typeof name === 'string' && name) names.add(name)
    }
    for (const block of message?.content || []) {
      const name = block?.name
      if (block?.type === 'tool_use' && typeof name === 'string') names.add(name)
    }
  }
  return [...names]
}

function responseToolNames(response: any): string[] {
  const names: unknown[] = [
    ...(Array.isArray(response.tool_calls) ? response.tool_calls.map((call: any) => call?.function?.name || call?.name) : []),
    ...(Array.isArray(response.content) ? response.content.filter((part: any) => part?.type === 'tool_use').map((part: any) => part.name) : []),
    ...(Array.isArray(response.output) ? response.output.filter((item: any) => item?.type === 'function_call').map((item: any) => item.name) : []),
    ...(Array.isArray(response.choices)
      ? response.choices.flatMap((choice: any) => (choice?.message?.tool_calls || []).map((call: any) => call?.function?.name))
      : []),
  ]
  return names.filter((name): name is string => typeof name === 'string' && name.length > 0)
}

function responseBodyText(response: any): string {
  if (typeof response.output_text === 'string') return response.output_text
  if (typeof response.content === 'string') return response.content
  if (Array.isArray(response.content)) {
    return response.content.map((part: any) => (part?.type === 'text' || !part?.type ? part?.text || '' : '')).join('')
  }
  if (Array.isArray(response.output)) {
    return response.output
      .filter((item: any) => item?.type === 'message')
      .flatMap((item: any) => item.content || [])
      .map((part: any) => part?.text || '')
      .join('')
  }
  if (Array.isArray(response.choices)) {
    return response.choices.map((choice: any) => choice?.message?.content || choice?.text || '').join('')
  }
  return ''
}

export function responseText(response: any): string | null {
  if (!response) return null
  if (typeof response === 'string') return response
  const text = responseBodyText(response)
  const tools = responseToolNames(response).map((name) => `[tool call: ${name}]`)
  const combined = [text, ...tools].filter(Boolean).join('\n')
  return combined || null
}

export function sourceFor(
  authKind: string | undefined,
  client: string | null | undefined,
  internal: boolean | undefined,
): NormalizedCapture['source'] {
  if (internal) return 'internal'
  if (client?.toLowerCase() === 'desktop') return 'desktop_proxy'
  if (authKind === 'api-key') return 'api_key'
  return 'cloud_runtime'
}

export function scrubHeaders(headers: Headers | Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {}
  const entries = headers instanceof Headers ? headers.entries() : Object.entries(headers)
  for (const [key, value] of entries) {
    if (SECRET_HEADER_RE.test(key)) continue
    if (key.toLowerCase().startsWith('anthropic-') || key.toLowerCase() === 'content-type') {
      result[key] = value
    }
  }
  return result
}

export function normalizeCapture(
  metadata: {
    authKind?: string
    client?: string | null
    internal?: boolean
    workspaceId: string
    chatSessionId?: string | null
    endpoint: string
    requestedModel?: string | null
    resolvedModel?: string | null
    provider?: string | null
  },
  requestBody: unknown,
  responseBody: unknown,
  writeBlob: BlobWriter,
): NormalizedCapture {
  const media: NormalizedCapture['media'] = []
  const request = deduplicateRequest(requestBody, (key, value) => writeBlob(key, value), media)
  const response = collectMedia(responseBody, media)
  const userText = extractUserText(requestBody)
  const assistantText = responseText(responseBody)
  // /api/ai/* is exempt from home-region routing, so one turn can be served by
  // several regions. The region keeps (workspaceId, turnKey) region-disjoint,
  // which logical replication requires of every non-PK unique key.
  const region = process.env.REGION_ID || ''
  const turnKey = sha256(`${region}\0${metadata.workspaceId}\0${metadata.chatSessionId || ''}\0${userText || ''}`)
  const reasoningEffort =
    (requestBody as any)?.reasoning_effort ||
    (requestBody as any)?.reasoning?.effort ||
    (requestBody as any)?.thinking?.budget_tokens?.toString() ||
    null

  return {
    request,
    response,
    source: sourceFor(metadata.authKind, metadata.client, metadata.internal),
    provider: metadata.provider || 'unknown',
    requestedModel: metadata.requestedModel || null,
    resolvedModel: metadata.resolvedModel || null,
    turnKey,
    userText,
    assistantText,
    toolNames: extractToolNames(requestBody),
    media,
    reasoningEffort,
  }
}
