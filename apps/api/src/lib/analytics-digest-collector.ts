// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Analytics Digest Collector
 *
 * Runs daily to collect platform metrics and analyze user chat conversations
 * using Claude. Stores results in the analytics_digests table for historical
 * trend analysis and the admin AI Insights panel.
 *
 * Follows the same in-process setInterval pattern as infra-metrics-collector.ts.
 */

import type { PrismaClient } from './prisma'
import {
  getUserFunnel,
  getUserActivityTable,
  getTemplateEngagement,
  getChatConversations,
  getSourceBreakdown,
  type ConversationThread,
} from '../services/analytics.service'
import { getMaxOutputTokens } from '@shogo/model-catalog'

const MAX_TOKENS_PER_CHUNK = 100_000
const MAX_CHUNKS = 3
const CHARS_PER_TOKEN = 4
const DIGEST_HOUR = parseInt(process.env.ANALYTICS_DIGEST_HOUR || '8', 10)

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

async function analyzeWithClaude(
  conversationText: string,
  metricsContext: string
): Promise<ChunkAnalysis> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    console.warn('[AnalyticsDigest] No ANTHROPIC_API_KEY — skipping AI analysis')
    return { takeaways: ['AI analysis skipped: no API key'], intents: [], painPoints: [], securityFlags: [] }
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
Return ONLY valid JSON, no markdown fences.`

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: getMaxOutputTokens('claude-sonnet-4-20250514'),
        messages: [{ role: 'user', content: prompt }],
      }),
    })

    if (!response.ok) {
      const err = await response.text()
      console.error('[AnalyticsDigest] Claude API error:', err)
      return { takeaways: [`AI analysis failed: ${response.status}`], intents: [], painPoints: [], securityFlags: [] }
    }

    const data = await response.json() as any
    const text = data.content?.[0]?.text || ''
    return JSON.parse(text) as ChunkAnalysis
  } catch (err: any) {
    console.error('[AnalyticsDigest] Claude analysis error:', err.message)
    return { takeaways: [`AI analysis error: ${err.message}`], intents: [], painPoints: [], securityFlags: [] }
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

  console.log('[AnalyticsDigest] Generating digest for', dateOnly.toISOString().split('T')[0])

  const [funnel, activityResult, templates, sourceData, convos] = await Promise.all([
    getUserFunnel('30d', true),
    getUserActivityTable('30d', { page: 1, limit: 100, excludeInternal: true }),
    getTemplateEngagement(true),
    getSourceBreakdown('30d', true),
    getChatConversations(since, true),
  ])

  const totalCreditsUsed = activityResult.users.reduce((s, u) => s + u.creditsUsed, 0)
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
      chunks.map(chunk => analyzeWithClaude(chunk, metricsContext))
    )
    aiInsights = mergeAnalyses(chunkResults)
  }

  const digest = await prisma.analyticsDigest.upsert({
    where: { date_period: { date: dateOnly, period: '24h' } },
    create: {
      date: dateOnly,
      period: '24h',
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
      totalCreditsUsed,
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
      totalCreditsUsed,
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
