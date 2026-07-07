// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Analytics Digest Collector
 *
 * Runs daily to collect platform metrics and analyze user chat conversations
 * with the platform "basic" model (resolved through the shared multi-provider
 * resolver, so it works regardless of which provider that default points at).
 * Stores results in the analytics_digests table for historical trend analysis
 * and the admin AI Insights panel.
 *
 * Follows the same in-process setInterval pattern as infra-metrics-collector.ts.
 */

import { generateText } from 'ai'
import type { PrismaClient } from './prisma'
import {
  getUserFunnel,
  getUserActivityTable,
  getTemplateEngagement,
  getChatConversations,
  getSourceBreakdown,
  type ConversationThread,
} from '../services/analytics.service'
import { getMaxOutputTokens, resolveAgentModeDefault } from '@shogo/model-catalog'
import { resolveLanguageModel } from './resolve-language-model'

const MAX_TOKENS_PER_CHUNK = 100_000
const MAX_CHUNKS = 3
const CHARS_PER_TOKEN = 4
const DIGEST_HOUR = parseInt(process.env.ANALYTICS_DIGEST_HOUR || '8', 10)

// The daily digest is the platform-wide "AI Insights" run, and it operates
// over GLOBAL (logically-replicated) analytics data — every region sees the
// same numbers. We only want ONE authoritative scheduled run per day.
//
// Before the 2026-05-22 multi-region rollout this was effectively single
// region. After the rollout both API regions (US/EU) booted this
// scheduler, so each wrote its own `(date, '24h', REGION_ID)` row against the
// same global data — producing near-identical duplicate "AI Insights/day" rows.
//
// Pin the scheduled run to the main region (US, `us-ashburn-1`) — the same
// primary region that owns DB migrations — so only one row is produced per
// day. `region` stays in the unique key (see `generateDigest`) as a
// defense-in-depth backstop, because the manual admin trigger can still run
// `generateDigest` in any region and local/dev runs leave REGION_ID unset.
const MAIN_REGION_ID = 'us-ashburn-1'

/**
 * Whether this process should run the *scheduled* daily digest.
 *
 * True for the main region in production, and true whenever `REGION_ID` is
 * unset (local/dev/test, where there is only one process) so the collector
 * keeps working off-cluster. EU production replicas return false.
 */
function shouldScheduleDigest(): boolean {
  const region = process.env.REGION_ID
  return !region || region === MAIN_REGION_ID
}

let digestTimer: ReturnType<typeof setTimeout> | null = null

function formatThread(thread: ConversationThread): string {
  const header = `[${thread.userName || 'Unknown'} / ${thread.projectName}${thread.templateId ? ` (template: ${thread.templateId})` : ''}]`
  const msgs = thread.messages
    .map(m => `${m.role}: ${m.content}`)
    .join('\n')
  return `${header}\n${msgs}`
}

export function chunkConversations(threads: ConversationThread[]): string[] {
  const chunks: string[] = []
  let current = ''
  for (const thread of threads) {
    const serialized = formatThread(thread)
    if (current.length > 0 && (current.length + serialized.length) / CHARS_PER_TOKEN > MAX_TOKENS_PER_CHUNK) {
      chunks.push(current)
      current = serialized
      if (chunks.length >= MAX_CHUNKS) break
    } else {
      current += (current ? '\n---\n' : '') + serialized
    }
  }
  if (current && chunks.length < MAX_CHUNKS) chunks.push(current)
  return chunks
}

interface ChunkAnalysis {
  takeaways: string[]
  intents: { category: string; count: number; examples: string[] }[]
  painPoints: string[]
  securityFlags: string[]
}

/**
 * Best-effort extraction of the digest JSON body from a model completion.
 *
 * The default "basic" model (Hoshi / MiMo) intermittently returns JSON that
 * `JSON.parse` rejects. Measured against the live model on real prod data
 * (~6% of chunks), the dominant failure is NOT prose/fence wrapping or
 * truncation — it's the result being split into two *sibling* objects:
 *
 *   {"takeaways":[...],"intents":[...]} , {"painPoints":[...],"securityFlags":[...]}
 *
 * which is invalid JSON and previously dropped a whole chunk's insights
 * (surfacing as `AI analysis error: JSON Parse error: Unexpected identifier`).
 * Naive `{`…`}` extraction does not recover it, and `jsonrepair` "fixes" it
 * into the wrong shape (`{"0":…,"1":…}`). Wrapping the siblings in an array
 * and merging them back into one object faithfully reconstructs the result.
 */
function parseLooseDigestJson(text: string): unknown {
  let t = text.trim().replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
  // Prefer a fenced block when present (any / no language tag).
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  if (fence) t = fence[1].trim()
  // Strip any prose around the JSON body.
  const start = t.indexOf('{')
  const end = t.lastIndexOf('}')
  if (start !== -1 && end > start) t = t.slice(start, end + 1)

  try {
    return JSON.parse(t)
  } catch {
    // Sibling-objects case: wrap in an array and merge into a single object.
    const parts = JSON.parse(`[${t}]`)
    return Array.isArray(parts) ? Object.assign({}, ...parts) : parts
  }
}

/**
 * Parse a digest analysis completion into a normalized `ChunkAnalysis`.
 * Throws when the output can't be parsed into an object carrying at least one
 * of the expected keys — the caller uses that to trigger a single retry before
 * falling back to an error placeholder. Exported for regression testing.
 */
export function tolerantParseDigest(text: string): ChunkAnalysis {
  const parsed = parseLooseDigestJson(text) as Record<string, unknown> | null
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('digest analysis did not return a JSON object')
  }
  const EXPECTED = ['takeaways', 'intents', 'painPoints', 'securityFlags']
  if (!EXPECTED.some((k) => k in parsed)) {
    throw new Error('digest analysis JSON missing expected keys')
  }
  return {
    takeaways: Array.isArray(parsed.takeaways) ? (parsed.takeaways as string[]) : [],
    intents: Array.isArray(parsed.intents) ? (parsed.intents as ChunkAnalysis['intents']) : [],
    painPoints: Array.isArray(parsed.painPoints) ? (parsed.painPoints as string[]) : [],
    securityFlags: Array.isArray(parsed.securityFlags) ? (parsed.securityFlags as string[]) : [],
  }
}

async function analyzeConversations(
  conversationText: string,
  metricsContext: string
): Promise<ChunkAnalysis> {
  // Route through the shared multi-provider resolver — the same path the chat,
  // voice, and title-generation surfaces use — so the digest follows whatever
  // the admin-overridable "basic" default points at (Anthropic, OpenAI, Gemini,
  // or a custom OpenAI-compatible model) instead of being pinned to
  // api.anthropic.com. The proxy resolves the id and meters usage server-side;
  // the `analytics_digest` tag records it as internal admin cost (non-billable).
  const modelId = resolveAgentModeDefault('basic')
  const resolved = resolveLanguageModel(modelId, {
    headers: { 'x-shogo-usage-tag': 'analytics_digest' },
  })
  if (!resolved) {
    console.warn('[AnalyticsDigest] No model transport configured — skipping AI analysis')
    return { takeaways: ['AI analysis skipped: no model transport'], intents: [], painPoints: [], securityFlags: [] }
  }

  const prompt = `You are analyzing user conversations from an AI-powered agent builder platform called Shogo. 
Here are the platform metrics for the last 24 hours:
${metricsContext}

Below are user conversations (user messages in full, assistant messages truncated to last 1000 chars):

${conversationText}

Analyze these conversations and return a JSON object with exactly this structure:
{
  "takeaways": ["3-5 key insights about what users are doing and how well it's working"],
  "intents": [{"category": "string", "count": number, "examples": ["brief example"]}],
  "painPoints": ["specific issues users encountered"],
  "securityFlags": ["any concerning content like credential sharing, abuse, etc. Empty array if none."]
}

Focus on: what users are trying to build, whether they're succeeding, common patterns of confusion, and feature gaps.
Return ONLY valid JSON, no markdown fences. Output a SINGLE JSON object with exactly these four keys — do not split the response into multiple objects.`

  // One generate+parse attempt. Parse failures are retried once because the
  // basic model (MiMo) occasionally emits malformed JSON; `tolerantParseDigest`
  // already recovers the common sibling-objects case, and the retry covers the
  // rarer one-off malformations rather than dropping the whole chunk.
  const runOnce = async (): Promise<ChunkAnalysis> => {
    const result = await generateText({
      model: resolved.model,
      maxOutputTokens: getMaxOutputTokens(resolved.billingModelId),
      prompt,
    })
    return tolerantParseDigest(result.text || '')
  }

  try {
    return await runOnce()
  } catch (firstErr: any) {
    console.warn(
      '[AnalyticsDigest] analysis attempt failed, retrying once:',
      firstErr?.message ?? firstErr,
    )
    try {
      return await runOnce()
    } catch (err: any) {
      console.error('[AnalyticsDigest] AI analysis error:', err?.message ?? err)
      return { takeaways: [`AI analysis error: ${err?.message ?? err}`], intents: [], painPoints: [], securityFlags: [] }
    }
  }
}

export function mergeAnalyses(results: ChunkAnalysis[]): ChunkAnalysis {
  const merged: ChunkAnalysis = { takeaways: [], intents: [], painPoints: [], securityFlags: [] }

  for (const r of results) {
    merged.takeaways.push(...r.takeaways)
    merged.painPoints.push(...r.painPoints)
    merged.securityFlags.push(...r.securityFlags)

    for (const intent of r.intents) {
      const existing = merged.intents.find(i => i.category === intent.category)
      if (existing) {
        existing.count += intent.count
        existing.examples.push(...intent.examples)
      } else {
        merged.intents.push({ ...intent, examples: [...intent.examples] })
      }
    }
  }

  merged.takeaways = [...new Set(merged.takeaways)].slice(0, 5)
  merged.painPoints = [...new Set(merged.painPoints)]
  merged.securityFlags = [...new Set(merged.securityFlags)]
  for (const intent of merged.intents) {
    intent.examples = intent.examples.slice(0, 3)
  }

  return merged
}

export async function generateDigest(prisma: PrismaClient) {
  const now = new Date()
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000)
  const dateOnly = new Date(now.toISOString().split('T')[0])
  // Region that produced this digest, folded into the `analytics_digests`
  // unique key. The scheduled daily run is pinned to the main region (see
  // `shouldScheduleDigest`), so in steady state only `us-ashburn-1` writes.
  // `region` nevertheless stays in the unique key as a defense-in-depth
  // backstop against the cross-region poison-pill: the manual admin trigger
  // (`POST /analytics/ai-digest/generate`) can invoke `generateDigest` in
  // any region, and keeping `region` in the key means such a write lands on
  // its own row rather than colliding with the main region's row after it
  // replicates in via logical replication. Defaulting to `'unknown'` (rather
  // than throwing) keeps local/dev/test runs working where REGION_ID isn't
  // set — that string is distinct from every real region tag so it can't
  // accidentally collide with a production row.
  const region = process.env.REGION_ID || 'unknown'

  console.log(
    `[AnalyticsDigest] Generating digest for ${dateOnly.toISOString().split('T')[0]} (region=${region})`,
  )

  const [funnel, activityResult, templates, sourceData, convos] = await Promise.all([
    getUserFunnel('30d', true),
    getUserActivityTable('30d', { page: 1, limit: 100, excludeInternal: true }),
    getTemplateEngagement(true),
    getSourceBreakdown('30d', true),
    getChatConversations(since, true),
  ])

  const totalSpendUsd = activityResult.users.reduce((s, u) => s + u.spendUsd, 0)
  const totalToolCalls = activityResult.users.reduce((s, u) => s + u.toolCalls, 0)
  const totalMessages = activityResult.users.reduce((s, u) => s + u.messages, 0)
  const totalSessions = activityResult.users.reduce((s, u) => s + u.sessions, 0)

  let aiInsights: ChunkAnalysis | null = null
  let chunksProcessed = 0
  const userMessageCount = convos.conversations.reduce(
    (s, c) => s + c.messages.filter(m => m.role === 'user').length, 0
  )

  if (convos.conversations.length > 0) {
    const recentFirst = [...convos.conversations].reverse()
    const chunks = chunkConversations(recentFirst)
    chunksProcessed = chunks.length

    const metricsContext = [
      `Signups: ${funnel.signups}, Onboarded: ${funnel.onboarded}, Created Project: ${funnel.createdProject}`,
      `Sent Message: ${funnel.sentMessage}, Engaged (5+): ${funnel.engaged}`,
      `Active Users: ${activityResult.total}, Total Messages: ${totalMessages}`,
      `Source breakdown: ${sourceData.sources.map(s => `${s.tag}=${s.count}`).join(', ')}`,
    ].join('\n')

    const chunkResults = await Promise.all(
      chunks.map(chunk => analyzeConversations(chunk, metricsContext))
    )
    aiInsights = mergeAnalyses(chunkResults)
  }

  const digest = await prisma.analyticsDigest.upsert({
    where: { date_period_region: { date: dateOnly, period: '24h', region } },
    create: {
      date: dateOnly,
      period: '24h',
      region,
      funnelSignups: funnel.signups,
      funnelOnboarded: funnel.onboarded,
      funnelCreatedProject: funnel.createdProject,
      funnelSentMessage: funnel.sentMessage,
      funnelEngaged: funnel.engaged,
      avgMinToFirstProject: funnel.avgMinToFirstProject,
      avgMinToFirstMessage: funnel.avgMinToFirstMessage,
      activeUsers: activityResult.total,
      totalMessages,
      totalSessions,
      totalToolCalls,
      totalSpendUsd,
      templateStats: templates.templates as any,
      chunksProcessed,
      messagesAnalyzed: userMessageCount,
      aiInsights: aiInsights as any,
    },
    update: {
      funnelSignups: funnel.signups,
      funnelOnboarded: funnel.onboarded,
      funnelCreatedProject: funnel.createdProject,
      funnelSentMessage: funnel.sentMessage,
      funnelEngaged: funnel.engaged,
      avgMinToFirstProject: funnel.avgMinToFirstProject,
      avgMinToFirstMessage: funnel.avgMinToFirstMessage,
      activeUsers: activityResult.total,
      totalMessages,
      totalSessions,
      totalToolCalls,
      totalSpendUsd,
      templateStats: templates.templates as any,
      chunksProcessed,
      messagesAnalyzed: userMessageCount,
      aiInsights: aiInsights as any,
    },
  })

  console.log(`[AnalyticsDigest] Digest saved: ${digest.id} (${chunksProcessed} chunks, ${userMessageCount} messages)`)
  return digest
}

function msUntilNextRun(): number {
  const now = new Date()
  const target = new Date(now)
  target.setUTCHours(DIGEST_HOUR, 0, 0, 0)
  if (target <= now) target.setDate(target.getDate() + 1)
  return target.getTime() - now.getTime()
}

export function startAnalyticsDigestCollector(prisma: PrismaClient): void {
  if (!shouldScheduleDigest()) {
    console.log(
      `[AnalyticsDigest] Not the main region (REGION_ID=${process.env.REGION_ID}); ` +
        `daily digest runs only in ${MAIN_REGION_ID}. Scheduler not started.`,
    )
    return
  }

  function scheduleNext() {
    const delay = msUntilNextRun()
    const nextRun = new Date(Date.now() + delay)
    console.log(`[AnalyticsDigest] Next digest at ${nextRun.toISOString()} (in ${Math.round(delay / 60000)}m)`)

    digestTimer = setTimeout(async () => {
      try {
        await generateDigest(prisma)
      } catch (err: any) {
        console.error('[AnalyticsDigest] Digest generation failed:', err.message)
      }
      scheduleNext()
    }, delay)
  }

  scheduleNext()
  console.log('[AnalyticsDigest] Collector started')
}

export function stopAnalyticsDigestCollector(): void {
  if (digestTimer) {
    clearTimeout(digestTimer)
    digestTimer = null
  }
}
