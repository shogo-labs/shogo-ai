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

function deduplicateRequest(value: any, writeBlob: BlobWriter, media: NormalizedCapture['media']): any {
  const clone = collectMedia(value, media) as any
  if (clone && typeof clone === 'object') {
    if (Array.isArray(clone.system) && clone.system.length > 0) {
      const hash = sha256(stableStringify(clone.system))
      const key = `v1/blobs/${hash}.json.gz`
      writeBlob(key, clone.system)
      clone.system = { $ref: key, kind: 'system' }
    }
    if (Array.isArray(clone.tools) && clone.tools.length > 0) {
      const hash = sha256(stableStringify(clone.tools))
      const key = `v1/blobs/${hash}.json.gz`
      writeBlob(key, clone.tools)
      clone.tools = { $ref: key, kind: 'tools' }
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

export function responseText(response: any): string | null {
  if (!response) return null
  if (typeof response === 'string') return response
  if (typeof response.output_text === 'string') return response.output_text
  if (typeof response.content === 'string') return response.content
  if (Array.isArray(response.content)) {
    const text = response.content.map((part: any) => part?.text || '').filter(Boolean).join('')
    if (text) return text
  }
  if (Array.isArray(response.choices)) {
    const text = response.choices
      .map((choice: any) => choice?.message?.content || choice?.text || '')
      .filter(Boolean)
      .join('')
    if (text) return text
  }
  return null
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
  const turnKey = sha256(`${metadata.workspaceId}\0${metadata.chatSessionId || ''}\0${userText || ''}`)
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
