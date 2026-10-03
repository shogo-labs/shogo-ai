// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Decides whether a channel message deserves an unprompted agent reply.
 *
 * Agents with the `auto` trigger watch a channel but should stay quiet unless
 * a message is squarely theirs. One cheap model call picks at most one
 * responder from the channel's `auto` agents; a per-agent rate limit caps how
 * often they speak up unasked; `@agent mute` silences them outright. Explicit
 * @mentions and thread follow-ups never come through here.
 */

import { agentKey, type AgentTarget } from './conversation-mentions'
import { envInt } from './conversation-agent-chain'

export interface RelevanceCandidate {
  target: AgentTarget
  name: string
  /** What the agent is for (its role description), if known. */
  about: string | null
}

export interface RelevanceRequest {
  text: string
  /** Recent channel messages, oldest first, as plain text. */
  recent: string
  candidates: RelevanceCandidate[]
}

/** Returns the key (`agentKey`) of the one agent that should answer, or null to stay quiet. */
export type RelevanceDecider = (request: RelevanceRequest) => Promise<string | null>

/** Unprompted replies from one agent in one channel are at least this far apart. */
export const AUTO_REPLY_INTERVAL_MS = envInt('SHOGO_AUTO_REPLY_INTERVAL_MS', 10 * 60_000)
/** Messages shorter than this (ignoring mentions) are chatter, not requests. */
const MIN_AUTO_CHARS = 8
const MAX_MESSAGE_CHARS = 2_000

// ─── Rate limit ──────────────────────────────────────────────────────────────

// Per process. A second pod could answer within the window; that is rare and
// still bounded by the relevance gate.
const lastAutoReply = new Map<string, number>()

function limiterKey(conversationId: string, target: AgentTarget): string {
  return `${conversationId}:${agentKey(target)}`
}

export function autoReplyAllowed(conversationId: string, target: AgentTarget, now = Date.now()): boolean {
  const last = lastAutoReply.get(limiterKey(conversationId, target))
  return last === undefined || now - last >= AUTO_REPLY_INTERVAL_MS
}

export function recordAutoReply(conversationId: string, target: AgentTarget, now = Date.now()): void {
  lastAutoReply.set(limiterKey(conversationId, target), now)
}

export function resetAutoReplyLimits(): void {
  lastAutoReply.clear()
}

// ─── Gate ────────────────────────────────────────────────────────────────────

const MENTION_TOKEN_RE = /<(?:@[uag]:[A-Za-z0-9_:-]+|@a:ws|![a-z]+|#c:[A-Za-z0-9_-]+)>/g

/** The message without mention tokens, collapsed. */
export function plainText(text: string): string {
  return text.replace(MENTION_TOKEN_RE, ' ').replace(/\s+/g, ' ').trim()
}

/** Cheap checks before spending a model call. */
export function worthAsking(text: string): boolean {
  const plain = plainText(text)
  return plain.length >= MIN_AUTO_CHARS && /[\p{L}\p{N}]/u.test(plain)
}

const SYSTEM_PROMPT = `You route messages in a team chat. Several AI agents quietly watch the channel. Decide whether exactly one of them should reply to the newest message without being asked.

Choose an agent only when the message is a request, question, bug report or work item that clearly falls inside that agent's role, and nobody else in the conversation has already handled it. Stay quiet (null) for chatter between people, thanks, status talk, jokes, opinions, or anything outside every agent's role. When unsure, stay quiet.

Reply with JSON only: {"responder": "<agent key>"} or {"responder": null}.`

function buildRoutingPrompt(request: RelevanceRequest): string {
  const agents = request.candidates
    .map((c) => `- key: ${agentKey(c.target)}\n  name: ${c.name}\n  role: ${c.about?.trim() || 'not described'}`)
    .join('\n')
  return [
    `Agents:\n${agents}`,
    request.recent ? `Recent messages:\n${request.recent}` : '',
    `Newest message:\n${request.text.slice(0, MAX_MESSAGE_CHARS)}`,
  ].filter(Boolean).join('\n\n')
}

/** The agent key out of a model reply, or null when it names nobody valid. */
export function parseResponder(raw: string, validKeys: Set<string>): string | null {
  const match = raw.match(/\{[\s\S]*\}/)
  if (!match) return null
  try {
    const value = (JSON.parse(match[0]) as { responder?: unknown }).responder
    return typeof value === 'string' && validKeys.has(value) ? value : null
  } catch {
    return null
  }
}

/** Small, fast model used to pick a responder when the title model is unreachable. */
const RELEVANCE_FALLBACK_MODEL = 'claude-haiku-4-5-20251001'

const modelDecider: RelevanceDecider = async (request) => {
  const { generateTitleCompletion } = await import('../lib/title-model')
  const result = await generateTitleCompletion({
    system: SYSTEM_PROMPT,
    prompt: buildRoutingPrompt(request),
    maxTokens: 60,
    // A laptop with only provider keys cannot reach the default title model.
    fallbackModelIds: [RELEVANCE_FALLBACK_MODEL],
  })
  return parseResponder(result.text, new Set(request.candidates.map((c) => agentKey(c.target))))
}

let decider: RelevanceDecider = modelDecider

/** Test seam: replace the model call. Pass null to restore it. */
export function setRelevanceDecider(next: RelevanceDecider | null): void {
  decider = next ?? modelDecider
}

/**
 * The one `auto` agent that should answer `request.text`, or null. Skips agents
 * that spoke up unasked too recently, never asks the model for trivial text, and
 * stays quiet if the model call fails.
 */
export async function pickResponder(
  conversationId: string,
  request: RelevanceRequest,
  now = Date.now(),
): Promise<AgentTarget | null> {
  if (!worthAsking(request.text)) return null
  const candidates = request.candidates.filter((c) => autoReplyAllowed(conversationId, c.target, now))
  if (!candidates.length) return null
  let key: string | null
  try {
    key = await decider({ ...request, candidates })
  } catch (err) {
    console.warn('[ChannelAgent] relevance check failed:', (err as Error)?.message ?? err)
    return null
  }
  const chosen = candidates.find((c) => agentKey(c.target) === key)
  if (!chosen) return null
  recordAutoReply(conversationId, chosen.target, now)
  return chosen.target
}

// ─── Mute command ────────────────────────────────────────────────────────────

export interface MuteCommand {
  muted: boolean
  targets: AgentTarget[]
}

/**
 * `@agent mute` / `@agent unmute` (optionally "please"): the message is nothing
 * but agent mentions and that word.
 */
export function parseMuteCommand(text: string, mentioned: AgentTarget[]): MuteCommand | null {
  if (!mentioned.length) return null
  const rest = plainText(text).toLowerCase().replace(/[.!]+$/g, '').replace(/\bplease\b/g, '').replace(/\s+/g, ' ').trim()
  if (rest === 'mute') return { muted: true, targets: mentioned }
  if (rest === 'unmute') return { muted: false, targets: mentioned }
  return null
}
