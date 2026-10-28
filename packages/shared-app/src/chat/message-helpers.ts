// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Shared chat message helpers.
 *
 * Platform-independent utilities for parsing and formatting chat messages.
 * Used by both web and mobile chat implementations.
 */

/**
 * Extract text content from a UIMessage.
 * Handles both legacy content-string format and v3 parts-array format.
 */
export function extractTextContent(message: { parts?: Array<{ type: string; text?: string }>; content?: string }): string {
  if (typeof message.content === 'string' && message.content) {
    return message.content
  }

  if (Array.isArray(message.parts)) {
    return message.parts
      .filter((part) => part.type === 'text')
      .map((part) => part.text || '')
      .join('')
  }

  return ''
}

/**
 * Friendly error code mapping for chat errors.
 */
export const ERROR_CODE_MESSAGES: Record<string, string> = {
  pod_unavailable: "We're having trouble starting your project environment. Please try again in a moment.",
  rate_limit_exceeded: "You're sending messages too quickly. Please wait a moment and try again.",
  usage_limit_reached: "Usage limit reached. Enable usage-based pricing, upgrade your plan, or check your AI provider settings.",
  // `insufficient_credits` is kept as a legacy alias of `usage_limit_reached`
  // so older clients (mobile builds shipped before the Cursor-style per-seat
  // migration) still render a friendly message when the API surfaces the old
  // error code. New code should emit `usage_limit_reached`.
  insufficient_credits: "Usage limit reached. Enable usage-based pricing, upgrade your plan, or check your AI provider settings.",
  // On-demand usage was turned on, but the paid entitlement backing it
  // (subscription or license grant) has since expired — distinct from
  // `usage_limit_reached` so the user isn't told to "enable" a toggle that's
  // already on (the bug this fixes: see `checkUsageBalance` in billing.service.ts).
  entitlement_expired: "Your on-demand billing entitlement has expired. Reactivate your subscription or license key to continue using on-demand usage.",
  // Overage is active, but the workspace's own spending cap is exhausted.
  overage_cap_reached: "You've reached your on-demand spending cap for this period. Raise your cap in Billing settings to continue.",
  // An on-demand usage block is invoiced but unpaid (declined card, or the
  // bank requires the customer to confirm the charge).
  overage_payment_pending: "Your latest on-demand usage charge hasn't been paid yet. Pay or confirm the open invoice in Billing settings to continue.",
  session_expired: 'Your session has expired. Please refresh the page.',
  internal_error: 'Something went wrong on our end. Please try again.',
  shutting_down: 'A server update is in progress. Please retry in a few seconds.',
  offline: 'Your machine is offline. Reconnect it, or continue in the cloud.',
}

/**
 * Parse potentially JSON error messages into user-friendly text.
 */
const CONNECTION_ERROR_PATTERNS = [
  /network/i, /fetch failed/i, /econnreset/i, /econnrefused/i,
  /terminated/i, /aborted/i, /socket hang up/i,
]

const TUNNEL_DISCONNECT_PATTERNS = [
  /tunnel disconnected/i, /instance is offline/i, /stream error/i,
  /stream timed out/i, /cross-pod.*relay.*timed out/i,
]

export function isTunnelDisconnectError(message: string): boolean {
  const raw = message
  try {
    const parsed = JSON.parse(raw)
    // Structured `{ error: { code: 'offline' } }` from /api/instances/:id/p/* proxy
    if (parsed?.error?.code === 'offline') return true
    const inner = parsed?.error?.message || parsed?.message || ''
    if (TUNNEL_DISCONNECT_PATTERNS.some((p) => p.test(inner))) return true
  } catch {}
  return TUNNEL_DISCONNECT_PATTERNS.some((p) => p.test(raw)) ||
    CONNECTION_ERROR_PATTERNS.some((p) => p.test(raw))
}

/**
 * Fetch-level "the request never reached a server" patterns — distinct from
 * `CONNECTION_ERROR_PATTERNS` above, which also matches mid-stream drops
 * reported *by* a server (tunnel relay timeouts, ECONNRESET forwarded from a
 * proxy, etc). This is specifically for the client's OWN `fetch()` throwing
 * before any response, which is what the offline send queue in `ChatPanel`
 * needs to distinguish "no internet, safe to queue and retry" from "the
 * server responded with a real error" (auth, usage limit, 500, ...).
 */
const CLIENT_NETWORK_FAILURE_PATTERNS = [
  /failed to fetch/i, // Chrome/V8
  /load failed/i, // Safari
  /network request failed/i, // React Native
  /networkerror/i, // Firefox
  /the internet connection appears to be offline/i, // WebKit/native
  /err_internet_disconnected/i,
  /err_network_changed/i,
  /err_connection_(refused|reset|closed|timed_out)/i,
]

/**
 * True when `err` is the client's `fetch()` itself failing to reach any
 * server (DNS failure, no route, connection refused/reset) — as opposed to
 * the server responding with an HTTP error status or a mid-stream failure.
 * Used to decide whether a failed send is safe to silently queue for
 * automatic retry (network-class) or should surface as a normal error
 * (everything else — the server DID respond, just unfavorably).
 */
export function isClientNetworkFailure(err: unknown): boolean {
  if (!err) return false
  const message = err instanceof Error ? err.message : String(err)
  if (CLIENT_NETWORK_FAILURE_PATTERNS.some((p) => p.test(message))) return true
  // A bare `TypeError` with no other classification is the DOM/RN fetch
  // spec's generic "network error" signature (no HTTP response was ever
  // received) — Chrome/Safari/RN all throw plain TypeErrors for this rather
  // than a more specific subclass.
  if (err instanceof TypeError && !/json|undefined|null|is not a function/i.test(message)) {
    return true
  }
  return false
}

/**
 * Internal retryability marker the AI proxy embeds in stream-error messages
 * (see `apps/api/src/routes/ai-proxy.ts` / `packages/agent/src/retry-classifier.ts`).
 * It is meant for the server-side retry classifier, never for users, so we
 * strip it before rendering any error text.
 */
const STREAM_ERROR_MARKER_PATTERN = /\s*\[shogo:retryable=[^\]]*\]/gi

export function stripInternalErrorMarkers(message: string): string {
  return message.replace(STREAM_ERROR_MARKER_PATTERN, '').trim()
}

/**
 * A channel run's user message carries this part so the session can show who
 * asked and where, instead of the wrapper prompt the model was given.
 */
export interface ChannelDispatch {
  conversationId: string
  conversationName: string | null
  threadRootId: string | null
  agentName: string
  trigger: { authorName: string; text: string }
  handedOffBy?: string
  contextMode: string
}

function messageParts(message: { parts?: unknown }): unknown[] | null {
  const parts = message?.parts
  if (Array.isArray(parts)) return parts
  if (typeof parts !== 'string' || !parts) return null
  try {
    const parsed = JSON.parse(parts)
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** The channel-dispatch card on a message, or null when it is an ordinary user message. */
export function channelDispatchOf(message: { parts?: unknown } | null | undefined): ChannelDispatch | null {
  const parts = message ? messageParts(message) : null
  if (!parts) return null
  const part = parts.find((entry) => !!entry && typeof entry === 'object' && (entry as { type?: unknown }).type === 'data-channel-dispatch') as
    | { data?: unknown }
    | undefined
  const data = part?.data
  if (!data || typeof data !== 'object') return null
  const record = data as Record<string, unknown>
  const trigger = record.trigger
  if (typeof record.conversationId !== 'string' || typeof record.agentName !== 'string') return null
  if (!trigger || typeof trigger !== 'object') return null
  const asked = trigger as Record<string, unknown>
  if (typeof asked.authorName !== 'string' || typeof asked.text !== 'string') return null
  return {
    conversationId: record.conversationId,
    conversationName: typeof record.conversationName === 'string' && record.conversationName.trim() ? record.conversationName : null,
    threadRootId: typeof record.threadRootId === 'string' && record.threadRootId ? record.threadRootId : null,
    agentName: record.agentName,
    trigger: { authorName: asked.authorName, text: asked.text },
    ...(typeof record.handedOffBy === 'string' && record.handedOffBy ? { handedOffBy: record.handedOffBy } : {}),
    contextMode: typeof record.contextMode === 'string' && record.contextMode ? record.contextMode : 'shared',
  }
}

/**
 * A `project_call` request recorded into the callee's chat carries this part;
 * the callee's reply is produced by the call, not by this chat.
 */
export interface ProjectCallPrompt {
  runId: string
  callerName: string | null
}

/** The project-call marker on a message, or null when it has none. */
export function projectCallOf(message: { parts?: unknown } | null | undefined): ProjectCallPrompt | null {
  const parts = message ? messageParts(message) : null
  if (!parts) return null
  const part = parts.find((entry) => !!entry && typeof entry === 'object' && (entry as { type?: unknown }).type === 'data-project-call') as
    | { data?: unknown }
    | undefined
  const data = part?.data
  if (!data || typeof data !== 'object') return null
  const record = data as Record<string, unknown>
  if (typeof record.runId !== 'string' || !record.runId) return null
  return {
    runId: record.runId,
    callerName: typeof record.callerName === 'string' && record.callerName.trim() ? record.callerName : null,
  }
}

/** One finished background task in a wake message. */
export interface TaskUpdateLine {
  taskId: string
  title: string
  /** e.g. "completed", "failed (exit code 1)", "was cancelled" */
  outcome: string
  /** Everything after the headline: output file and last output. */
  detail: string
}

export interface TaskNotification {
  taskIds: string[]
  updates: TaskUpdateLine[]
}

const TASK_UPDATE_RE = /^\[Task update\] (.*) \(([^()\s]+)\) (.+?)\.$/

/** Parse `[Task update] <title> (<id>) <outcome>.` blocks out of a wake message's text. */
export function parseTaskUpdates(text: string): TaskUpdateLine[] {
  const updates: TaskUpdateLine[] = []
  let current: TaskUpdateLine | null = null
  const detail: string[] = []
  const flush = () => {
    if (current) updates.push({ ...current, detail: detail.join('\n').trim() })
    detail.length = 0
  }
  for (const line of text.split('\n')) {
    const match = TASK_UPDATE_RE.exec(line)
    if (match) {
      flush()
      current = { title: match[1], taskId: match[2], outcome: match[3], detail: '' }
    } else if (current) {
      detail.push(line)
    }
  }
  flush()
  return updates
}

/** The wake message the system sends when background tasks finish, or null for any other message. */
export function taskNotificationOf(message: { parts?: unknown } | null | undefined): TaskNotification | null {
  const parts = message ? messageParts(message) : null
  if (!parts) return null
  const part = parts.find((entry) => !!entry && typeof entry === 'object' && (entry as { type?: unknown }).type === 'data-task-notification') as
    | { data?: { taskIds?: unknown } }
    | undefined
  if (!part) return null
  const taskIds = Array.isArray(part.data?.taskIds) ? part.data!.taskIds.filter((id): id is string => typeof id === 'string') : []
  const text = parts
    .filter((entry): entry is { type: 'text'; text: string } => !!entry && typeof entry === 'object' && (entry as any).type === 'text' && typeof (entry as any).text === 'string')
    .map((entry) => entry.text)
    .join('\n')
  return { taskIds, updates: parseTaskUpdates(text) }
}

export type UsageLimitCode =
  | 'usage_limit_reached'
  | 'entitlement_expired'
  | 'overage_cap_reached'
  | 'overage_payment_pending'

const USAGE_LIMIT_CODES: Record<string, UsageLimitCode> = {
  usage_limit_reached: 'usage_limit_reached',
  insufficient_credits: 'usage_limit_reached',
  entitlement_expired: 'entitlement_expired',
  overage_cap_reached: 'overage_cap_reached',
  overage_payment_pending: 'overage_payment_pending',
}

/**
 * The usage-limit detail of a chat request the API refused with a 402
 * (`{ error: { code, message, resetsAt? } }`), or null for any other error.
 */
export function parseUsageLimitError(
  rawMessage: string,
): { code: UsageLimitCode; resetsAt?: string } | null {
  let parsed: any
  try {
    parsed = JSON.parse(stripInternalErrorMarkers(rawMessage))
  } catch {
    return null
  }
  const code = typeof parsed?.error?.code === 'string' ? USAGE_LIMIT_CODES[parsed.error.code] : undefined
  if (!code) return null
  const resetsAt = parsed.error.resetsAt
  return typeof resetsAt === 'string' && resetsAt ? { code, resetsAt } : { code }
}

const GENERIC_REQUEST_FAILED = 'The request failed. Please tap Retry to try again.'

export function formatErrorMessage(rawMessage: string): string {
  const cleaned = stripInternalErrorMarkers(rawMessage)
  try {
    const parsed = JSON.parse(cleaned)
    if (parsed?.error?.code && ERROR_CODE_MESSAGES[parsed.error.code]) {
      return ERROR_CODE_MESSAGES[parsed.error.code]
    }
    if (parsed?.error?.message) {
      return stripInternalErrorMarkers(parsed.error.message)
    }
    if (parsed?.message) {
      return stripInternalErrorMarkers(parsed.message)
    }
    // An error envelope with nothing human-readable in it (e.g.
    // `{"error":{}}`) must not be rendered verbatim.
    if (parsed && typeof parsed === 'object' && 'error' in parsed) {
      if (typeof parsed.error === 'string' && parsed.error.trim()) {
        return stripInternalErrorMarkers(parsed.error)
      }
      if (typeof parsed.error?.code === 'string' && parsed.error.code) {
        return `${GENERIC_REQUEST_FAILED} (${parsed.error.code})`
      }
      return GENERIC_REQUEST_FAILED
    }
  } catch {
    // Not JSON
  }
  if (CONNECTION_ERROR_PATTERNS.some((p) => p.test(cleaned))) {
    return 'Connection interrupted. Please tap Retry to continue.'
  }
  return cleaned
}

/**
 * Format MCP tool names for display.
 * e.g., mcp__shogo__store_query -> shogo.store_query
 */
export function formatToolName(name: string): string {
  if (name.startsWith('mcp__')) {
    const parts = name.replace('mcp__', '').split('__')
    return parts.join('.')
  }
  return name
}

/**
 * Categorize a tool name for styling purposes.
 */
export function getToolCategory(name: string): 'mcp' | 'file' | 'skill' | 'other' {
  if (name.startsWith('mcp__')) return 'mcp'
  if (['Read', 'Write', 'Edit', 'Glob', 'Grep'].includes(name)) return 'file'
  if (['Skill', 'Task'].includes(name)) return 'skill'
  return 'other'
}
