// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Compact, diffable fingerprints for the prompt-cache prefix.
 *
 * The Anthropic prompt cache keys on the exact bytes of (tools, system,
 * messages_prefix). If cache-read is unexpectedly low on subsequent turns,
 * something in one of those three is changing. These helpers emit short
 * deterministic hashes so two turns' logs can be pasted side-by-side and
 * the shifted segment located instantly — no diffing of 50k-char blobs.
 *
 * The hash is FNV-1a 32-bit, hex-encoded, truncated to 6 chars. Collisions
 * are irrelevant for change-detection: what matters is that identical
 * bytes ALWAYS produce the identical string. We never pattern-match on the
 * hash value, only compare it to the previous call's hash.
 *
 * All helpers return strings; no console calls here. Callers decide
 * whether / how to log.
 */
import type {
  Message,
  TextContent,
  ToolCall,
  ToolResultMessage,
  UserMessage,
  AssistantMessage,
} from '@mariozechner/pi-ai'
import type { AgentTool } from '@mariozechner/pi-agent-core'

// ---------------------------------------------------------------------------
// Primitive hash
// ---------------------------------------------------------------------------

const FNV_OFFSET = 0x811c9dc5
const FNV_PRIME = 0x01000193

function fnv1a(str: string): number {
  let h = FNV_OFFSET
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, FNV_PRIME)
  }
  return h >>> 0
}

export function shortHash(str: string): string {
  return fnv1a(str).toString(16).padStart(8, '0').slice(0, 6)
}

// ---------------------------------------------------------------------------
// System prompt fingerprint
// ---------------------------------------------------------------------------

const CACHE_BOUNDARY = '\n\n<|CACHE_BOUNDARY|>\n\n'

/**
 * Split the system string on the boundary marker and return separate hashes
 * for the stable (cached) prefix and the dynamic (per-turn) suffix. A shift
 * in the stable hash between turns = wasted cache; a shift in the dynamic
 * hash is expected.
 */
export function fingerprintSystem(system: string | undefined): {
  stableHash: string
  dynamicHash: string
  stableChars: number
  dynamicChars: number
} {
  if (!system) {
    return { stableHash: '------', dynamicHash: '------', stableChars: 0, dynamicChars: 0 }
  }
  const idx = system.indexOf(CACHE_BOUNDARY)
  const stable = idx >= 0 ? system.slice(0, idx) : system
  const dynamic = idx >= 0 ? system.slice(idx + CACHE_BOUNDARY.length) : ''
  return {
    stableHash: shortHash(stable),
    dynamicHash: shortHash(dynamic),
    stableChars: stable.length,
    dynamicChars: dynamic.length,
  }
}

// ---------------------------------------------------------------------------
// Tools fingerprint
// ---------------------------------------------------------------------------

/**
 * Hash the full ordered tool list. Anthropic caches tools alongside system,
 * so a shift here silently invalidates the entire cache. Includes the JSON
 * schema because parameter changes matter too.
 */
export function fingerprintTools(tools: readonly AgentTool[] | undefined): {
  hash: string
  count: number
} {
  if (!tools || tools.length === 0) return { hash: '------', count: 0 }
  const canon = tools
    .map((t) => `${t.name}:${t.description ?? ''}:${JSON.stringify(t.parameters ?? {})}`)
    .join('\n')
  return { hash: shortHash(canon), count: tools.length }
}

// ---------------------------------------------------------------------------
// Per-message fingerprint
// ---------------------------------------------------------------------------

/**
 * Compact, position-aware per-message tag. Designed to be readable inline
 * and to make any byte shift visible. Format:
 *   u:HHHHHH              user text
 *   a:HHHHHH              assistant text-only
 *   a:HHHHHH(tc=ID1,ID2)  assistant with tool_calls (first 8 chars of each id)
 *   tr:ID:HHHHHH          tool_result (first 8 chars of id, hash of text)
 *   tr:ID:HHHHHH!         tool_result that is_error=true
 */
function tagForMessage(msg: Message): string {
  if (msg.role === 'user') {
    const text = extractUserText(msg as UserMessage)
    return `u:${shortHash(text)}`
  }
  if (msg.role === 'assistant') {
    const am = msg as AssistantMessage
    const textParts: string[] = []
    const toolIds: string[] = []
    for (const block of am.content) {
      if (block.type === 'text') {
        textParts.push((block as TextContent).text)
      } else if (block.type === 'toolCall') {
        const tc = block as ToolCall
        textParts.push(`[tc:${tc.name}]`)
        toolIds.push(shortHash(tc.id))
      } else if ((block as any).type === 'thinking') {
        textParts.push(`[thinking:${shortHash((block as any).thinking ?? '')}]`)
      }
    }
    const text = textParts.join('|')
    const tcSuffix = toolIds.length ? `(tc=${toolIds.join(',')})` : ''
    return `a:${shortHash(text)}${tcSuffix}`
  }
  if (msg.role === 'toolResult') {
    const tr = msg as ToolResultMessage
    const text = tr.content
      .filter((c): c is TextContent => c.type === 'text')
      .map((c) => c.text)
      .join('')
    const err = (tr as any).isError ? '!' : ''
    // tool_call_ids from Anthropic all share the `toolu_01` prefix; hash the
    // full id so each tool call gets a distinct short tag we can diff across
    // turns.
    return `tr:${shortHash(tr.toolCallId)}:${shortHash(text)}${err}`
  }
  return `?:${(msg as any).role ?? 'unknown'}`
}

function extractUserText(msg: UserMessage): string {
  if (typeof msg.content === 'string') return msg.content
  if (!Array.isArray(msg.content)) return ''
  return msg.content
    .map((block: any) => {
      if (block.type === 'text') return block.text ?? ''
      if (block.type === 'image') return `[img:${shortHash(block.source?.data ?? block.image ?? '')}]`
      return ''
    })
    .join('')
}

// ---------------------------------------------------------------------------
// Message-list fingerprint
// ---------------------------------------------------------------------------

/**
 * Fingerprint the entire outgoing message list. Returns:
 *   - `aggregate`: hash of the concatenated per-message tags (cheap
 *     "did anything at all change in the prefix" signal)
 *   - `positions`: array of per-message tags for readable diffing
 *   - `totalChars`: sum of text content across messages (approx wire size)
 */
export function fingerprintMessages(messages: readonly Message[]): {
  aggregate: string
  positions: string[]
  totalChars: number
  count: number
} {
  const positions: string[] = []
  let totalChars = 0
  for (const msg of messages) {
    positions.push(tagForMessage(msg))
    totalChars += approxMessageChars(msg)
  }
  return {
    aggregate: shortHash(positions.join('|')),
    positions,
    totalChars,
    count: messages.length,
  }
}

function approxMessageChars(msg: Message): number {
  if (msg.role === 'user') return extractUserText(msg as UserMessage).length
  if (msg.role === 'assistant') {
    let total = 0
    for (const block of (msg as AssistantMessage).content) {
      if (block.type === 'text') total += (block as TextContent).text.length
      else if (block.type === 'toolCall') total += JSON.stringify((block as ToolCall).arguments ?? {}).length
      else if ((block as any).type === 'thinking') total += ((block as any).thinking ?? '').length
    }
    return total
  }
  if (msg.role === 'toolResult') {
    let total = 0
    for (const c of (msg as ToolResultMessage).content) {
      if (c.type === 'text') total += c.text.length
    }
    return total
  }
  return 0
}

// ---------------------------------------------------------------------------
// Pretty-print a one-line summary
// ---------------------------------------------------------------------------

/**
 * Render the per-position tags as a single wrapped-ish line. Truncates the
 * middle of the list if there are many messages so the log line stays
 * scannable while still showing head and tail.
 */
export function formatPositions(positions: readonly string[], headTail = 6): string {
  if (positions.length <= headTail * 2 + 1) return positions.join('|')
  const head = positions.slice(0, headTail).join('|')
  const tail = positions.slice(-headTail).join('|')
  const omitted = positions.length - headTail * 2
  return `${head}|...${omitted} omitted...|${tail}`
}
