import { randomUUID } from 'node:crypto'
import { prisma } from '../prisma'
import { shouldCapture } from './consent'
import { enqueueArchiveRecord, enqueueBlob, enqueueMedia } from './archive-writer'
import { normalizeCapture, scrubHeaders } from './normalize'
import { wrapCaptureStream } from './reassemble'
import type {
  CaptureFormat,
  CaptureResponse,
  ProxyCaptureHandle,
  ProxyCaptureMetadata,
  CaptureUsage,
} from './types'

const MAX_PAYLOAD_BYTES = Number(process.env.PROXY_CAPTURE_MAX_BYTES || 5 * 1024 * 1024)

function bytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value))
  } catch {
    return 0
  }
}

function archivePrefix(now = new Date()): string {
  const region = process.env.REGION_ID || process.env.S3_REGION || process.env.AWS_REGION || 'unknown'
  return `v1/region=${region}/date=${now.toISOString().slice(0, 10)}/hour=${now.toISOString().slice(11, 13)}`
}

function usageValue(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value || 0)) : 0
}

async function writeTurnSummary(
  normalized: ReturnType<typeof normalizeCapture>,
  metadata: ProxyCaptureMetadata,
  usage: CaptureUsage | undefined,
  errorType: string | null | undefined,
  truncated: boolean,
): Promise<void> {
  const db = (prisma as any).proxyTurn
  if (!db) return
  const now = new Date()
  const data = {
    source: normalized.source,
    workspaceId: metadata.tokenPayload.workspaceId,
    projectId: metadata.tokenPayload.projectId && !['api-key', 'system', 'workspace'].includes(metadata.tokenPayload.projectId)
      ? metadata.tokenPayload.projectId
      : null,
    userId: metadata.tokenPayload.userId || null,
    chatSessionId: metadata.chatSessionId || null,
    turnKey: normalized.turnKey,
    resolvedModel: normalized.resolvedModel,
    llmCalls: 1,
    inputTokens: usageValue(usage?.inputTokens),
    outputTokens: usageValue(usage?.outputTokens),
    cachedInputTokens: usageValue(usage?.cachedInputTokens),
    cacheWriteTokens: usageValue(usage?.cacheWriteTokens),
    reasoningTokens: usageValue(usage?.reasoningTokens),
    errorCount: errorType ? 1 : 0,
    userText: normalized.userText?.slice(0, 8_000) || null,
    assistantText: normalized.assistantText?.slice(0, 16_000) || null,
    toolNames: normalized.toolNames,
    archivePrefix: archivePrefix(now),
    hadError: Boolean(errorType),
    truncated,
  }
  await db.upsert({
    where: { workspaceId_turnKey: { workspaceId: data.workspaceId, turnKey: data.turnKey } },
    create: data,
    update: {
      lastAt: now,
      resolvedModel: data.resolvedModel,
      llmCalls: { increment: data.llmCalls },
      inputTokens: { increment: data.inputTokens },
      outputTokens: { increment: data.outputTokens },
      cachedInputTokens: { increment: data.cachedInputTokens },
      cacheWriteTokens: { increment: data.cacheWriteTokens },
      reasoningTokens: { increment: data.reasoningTokens },
      errorCount: { increment: data.errorCount },
      ...(data.userText ? { userText: data.userText } : {}),
      ...(data.assistantText ? { assistantText: data.assistantText } : {}),
      toolNames: data.toolNames,
      ...(data.hadError ? { hadError: true } : {}),
      ...(data.truncated ? { truncated: true } : {}),
      archivePrefix: data.archivePrefix,
    },
  })
}

export async function beginCapture(metadata: ProxyCaptureMetadata): Promise<ProxyCaptureHandle | null> {
  if (!(await shouldCapture(metadata.tokenPayload))) return null

  const startedAt = Date.now()
  let response: CaptureResponse | null = null
  let finished = false

  const persist = (capture: CaptureResponse): void => {
    if (finished) return
    finished = true
    const now = new Date()
    const normalized = normalizeCapture(
      {
        authKind: metadata.tokenPayload.authKind,
        client: metadata.client,
        internal: metadata.internal,
        workspaceId: metadata.tokenPayload.workspaceId,
        chatSessionId: metadata.chatSessionId,
        endpoint: metadata.endpoint,
        requestedModel: metadata.requestedModel,
        resolvedModel: metadata.resolvedModel,
        provider: metadata.provider,
      },
      metadata.requestBody,
      capture.body,
      enqueueBlob,
    )
    for (const item of normalized.media) enqueueMedia(item.hash, item.mime, item.bytes)

    const requestBytes = bytes(metadata.requestBody)
    const responseBytes = bytes(capture.body)
    const tooLarge = requestBytes + responseBytes > MAX_PAYLOAD_BYTES
    const record = {
      id: randomUUID(),
      ts: now.toISOString(),
      source: normalized.source,
      workspaceId: metadata.tokenPayload.workspaceId,
      projectId: metadata.tokenPayload.projectId,
      userId: metadata.tokenPayload.userId || null,
      authKind: metadata.tokenPayload.authKind || null,
      chatSessionId: metadata.chatSessionId || null,
      turnKey: normalized.turnKey,
      endpoint: metadata.endpoint,
      provider: normalized.provider,
      requestedModel: normalized.requestedModel,
      resolvedModel: normalized.resolvedModel,
      stream: Boolean(metadata.stream),
      httpStatus: capture.status,
      errorType: capture.errorType || null,
      usage: capture.usage || null,
      requestHeaders: scrubHeaders(metadata.requestHeaders || {}),
      responseHeaders: scrubHeaders(capture.headers || {}),
      reasoningEffort: normalized.reasoningEffort,
      latencyMs: Math.max(0, Date.now() - startedAt),
      request: normalized.request,
      response: normalized.response,
      truncated: Boolean(capture.truncated || tooLarge),
    }

    if (tooLarge) {
      record.request = { truncated: true, bytes: requestBytes }
      record.response = { truncated: true, bytes: responseBytes }
    }
    enqueueArchiveRecord(record, now)
    void writeTurnSummary(normalized, metadata, capture.usage, capture.errorType, Boolean(capture.truncated || tooLarge))
      .catch((error) => console.error('[ProxyCapture] ProxyTurn write failed:', error))
  }

  return {
    recordResponse(capture) {
      response = capture
      persist(capture)
    },
    wrapStream(upstream, format) {
      return wrapCaptureStream(upstream, format, persist)
    },
    finish(extra) {
      if (finished) return
      persist({
        status: response?.status || 200,
        body: response?.body || null,
        format: response?.format || 'json',
        usage: extra?.usage || response?.usage,
        errorType: extra?.errorType || response?.errorType,
        truncated: extra?.truncated || response?.truncated,
      })
    },
  }
}

export async function updateTurnFeedback(
  chatSessionId: string,
  messageAt: Date,
  feedback: string | null,
): Promise<void> {
  const db = (prisma as any).proxyTurn
  if (!db) return
  const start = new Date(messageAt.getTime() - 10 * 60_000)
  const end = new Date(messageAt.getTime() + 2 * 60_000)
  await db.updateMany({
    where: { chatSessionId, lastAt: { gte: start, lte: end } },
    data: { feedback },
  })
}

export async function markProjectTurnsReverted(projectId: string, since: Date): Promise<void> {
  const db = (prisma as any).proxyTurn
  if (!db) return
  await db.updateMany({
    where: { projectId, lastAt: { gt: since } },
    data: { revertedAt: new Date() },
  })
}

export { clearConsentCache, shouldCapture } from './consent'
export { flushAndStopArchive, getArchiveWriterStats } from './archive-writer'
export { pruneProxyTurns, startProxyCaptureRetention, stopProxyCaptureRetention } from './retention'
export { normalizeCapture, responseText, extractUserText, extractToolNames, sourceFor } from './normalize'
export { wrapCaptureStream } from './reassemble'
export type { CaptureEndpoint, CaptureFormat, CaptureResponse, ProxyCaptureHandle, ProxyCaptureMetadata, CaptureUsage } from './types'
