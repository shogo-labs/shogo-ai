// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * LLM judge for the daily abuse check.
 *
 * One call per candidate (or cluster). The model receives up to
 * ABUSE_JUDGE_MAX_TURNS turns, each pre-redacted, and returns a JSON verdict.
 * turnIds that were not in the input are dropped so they can never satisfy
 * the 2-turn evidence rule.
 */

import { generateText } from 'ai'
import { z } from 'zod'
import { resolveAgentModeDefault } from '@shogo/model-catalog'
import { resolveLanguageModel } from '../../lib/resolve-language-model'
import {
  ABUSE_JUDGE_MAX_TURNS,
  ABUSE_JUDGE_ASSISTANT_TAIL,
  ABUSE_EVIDENCE_QUOTE_LIMIT,
  type AbuseCategory,
  type AbuseConfidence,
} from '../../config/abuse-config'
import { redactSecrets } from '../../lib/redact-secrets'
import type { CandidateTurn } from './candidates'

const ABUSE_RUBRIC = `
You are an abuse analyst for Shogo, an AI agent builder platform. Classify whether this account is abusing the platform.

ABUSE — flag when the account:
- Attacks, probes or extracts data from real third-party systems it does not own (SQLi, LFI, admin-panel hits, DB/FTP credential stuffing against external hosts)
- Creates or rotates accounts, keys, IPs or identities to bypass plan limits (captcha solvers, temp-mail bots, SMS farms, key rotation scripts)
- Obtains AI credit and relays or resells it to others (reverse proxies, credit farming, resale)
- Bypasses software licences or activation (cracks, keygens, serial extraction, keygen scripts)
- Forges documents or commits payment fraud

NOT ABUSE — do NOT flag:
- Pasting their own secrets or keys (the content is about their own systems)
- Building defensive security tools (scanners, CVE feeds, audit scripts) for their own systems
- Testing their own systems or working on a Capture The Flag challenge
- Writing about security concepts or doing security research
- Working on legitimate software projects that mention hacking tangentially

For each category of abuse present, return a verdict. Omit categories with no evidence.
`

export interface JudgeVerdict {
  category: AbuseCategory
  severity: number
  confidence: AbuseConfidence
  summary: string
  turnIds: string[]
}

export interface JudgeResult {
  verdicts: JudgeVerdict[]
  model: string
}

const VerdictSchema = z.object({
  verdicts: z.array(
    z.object({
      category: z.enum([
        'offensive_third_party',
        'account_farming',
        'credit_relay',
        'license_circumvention',
        'fraud',
      ]),
      severity: z.number().int().min(0).max(100),
      confidence: z.enum(['low', 'medium', 'high']),
      summary: z.string(),
      turnIds: z.array(z.string()),
    }),
  ),
})

function formatTurns(turns: CandidateTurn[], inputTurnIds: Set<string>): string {
  return turns
    .slice(0, ABUSE_JUDGE_MAX_TURNS)
    .map((t) => {
      inputTurnIds.add(t.id)
      const assistant =
        t.assistantText.length > ABUSE_JUDGE_ASSISTANT_TAIL
          ? t.assistantText.slice(-ABUSE_JUDGE_ASSISTANT_TAIL)
          : t.assistantText
      return `[${t.id}] user: ${t.userText}\nassistant: ${assistant}`
    })
    .join('\n---\n')
}

function tryParseVerdicts(text: string): JudgeVerdict[] | null {
  let t = text.trim().replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  if (fence) t = fence[1].trim()
  const start = t.indexOf('{')
  const end = t.lastIndexOf('}')
  if (start !== -1 && end > start) t = t.slice(start, end + 1)
  try {
    const parsed = VerdictSchema.parse(JSON.parse(t))
    return parsed.verdicts
  } catch {
    return null
  }
}

/**
 * Ask the model to judge a candidate's turns. Returns null when the model
 * returns malformed JSON on both attempts (the candidate is skipped, not
 * banned).
 */
export async function judgeCandidate(
  turns: CandidateTurn[],
  clusterNote?: string,
): Promise<JudgeResult | null> {
  const modelId = resolveAgentModeDefault('basic')
  const resolved = resolveLanguageModel(modelId, {
    headers: { 'x-shogo-usage-tag': 'abuse_check' },
  })
  if (!resolved) {
    console.warn('[abuse-check] No model transport — skipping judge call')
    return null
  }

  const inputTurnIds = new Set<string>()
  const transcript = formatTurns(turns, inputTurnIds)

  const userPrompt = [
    clusterNote ? `Note: ${clusterNote}` : '',
    'Here are the account turns to analyse:',
    '',
    transcript,
    '',
    'Return JSON: { "verdicts": [{ "category", "severity" (0-100), "confidence", "summary", "turnIds" }] }',
    'Only include categories with actual evidence. turnIds must be from the turns above.',
  ]
    .filter(Boolean)
    .join('\n')

  async function attempt(): Promise<string> {
    const result = await generateText({
      model: resolved!.model,
      system: ABUSE_RUBRIC,
      prompt: userPrompt,
      maxOutputTokens: 1024,
    })
    return result.text
  }

  let raw: string
  try {
    raw = await attempt()
  } catch (err) {
    console.warn('[abuse-check] judge first attempt threw', err instanceof Error ? err.message : err)
    return null
  }

  let verdicts = tryParseVerdicts(raw)
  if (!verdicts) {
    // Single retry.
    try {
      raw = await attempt()
      verdicts = tryParseVerdicts(raw)
    } catch {
      // fall through
    }
  }

  if (!verdicts) {
    console.warn('[abuse-check] judge returned malformed JSON on both attempts — skipping candidate')
    return null
  }

  // Drop any turnId the model invented that wasn't in the input.
  const cleaned = verdicts.map((v) => ({
    ...v,
    turnIds: v.turnIds.filter((id) => inputTurnIds.has(id)),
  }))

  return { verdicts: cleaned, model: modelId }
}

/** Build the evidence array stored on the AbuseFlag row. */
export function buildEvidence(
  turnIds: string[],
  turns: CandidateTurn[],
): Array<{ turnId: string; source: string; createdAt: string; quote: string }> {
  const turnMap = new Map(turns.map((t) => [t.id, t]))
  return turnIds
    .map((id) => {
      const t = turnMap.get(id)
      if (!t) return null
      const raw = `${t.userText} ${t.assistantText}`
      const quote = redactSecrets(raw.slice(0, ABUSE_EVIDENCE_QUOTE_LIMIT))
      return { turnId: id, source: t.source, createdAt: t.createdAt.toISOString(), quote }
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
}
