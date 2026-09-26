import type { ProxyTokenPayload } from '../ai-proxy-token'

export type CaptureFormat = 'anthropic' | 'openai-chat' | 'openai-responses' | 'json'

export type CaptureEndpoint =
  | 'chat.completions'
  | 'responses'
  | 'anthropic.messages'
  | 'images.generations'
  | 'images.edits'
  | 'audio.transcriptions'

export interface ProxyCaptureMetadata {
  tokenPayload: ProxyTokenPayload
  endpoint: CaptureEndpoint
  requestBody: unknown
  requestedModel?: string | null
  resolvedModel?: string | null
  provider?: string | null
  stream?: boolean
  chatSessionId?: string | null
  internal?: boolean
  client?: string | null
  requestHeaders?: Headers | Record<string, string>
}

export interface CaptureUsage {
  inputTokens?: number
  outputTokens?: number
  cachedInputTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

export interface CaptureResponse {
  status: number
  body?: unknown
  format?: CaptureFormat
  usage?: CaptureUsage
  errorType?: string | null
  truncated?: boolean
  headers?: Headers | Record<string, string>
}

export interface ProxyCaptureHandle {
  recordResponse(response: CaptureResponse): void
  wrapStream(response: Response, format: Exclude<CaptureFormat, 'json'>): Response
  finish(extra?: { usage?: CaptureUsage; errorType?: string | null; truncated?: boolean }): void
}
