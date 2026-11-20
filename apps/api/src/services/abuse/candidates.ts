// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Free-account candidate selection for the daily abuse check.
 *
 * "Free" means: no active/trialing/past_due subscription on any workspace
 * the user is a member of, no unexpired workspace_grant, role = user, not
 * banned, and not an internal email (shogo.ai / getodin.ai / super_admin).
 */

import { Prisma } from '../../generated/prisma-pg/client'
import { ABUSE_CANDIDATE_CAP, ABUSE_JUDGE_MAX_TURNS, ABUSE_JUDGE_WINDOW_DAYS } from '../../config/abuse-config'
import { redactSecrets } from '../../lib/redact-secrets'

/** Keyword weights used in the pre-filter score. */
const KEYWORD_WEIGHTS: Array<{ pattern: RegExp; weight: number; category: string }> = [
  // offensive × 3
  { pattern: /\b(sqli|sql\s+injection|lfi|rfi|xss|rce|exploit|payload|reverse\s+shell|admin\s+panel|\.php\?.*=|%27|%3B|union\s+select|information_schema|passwd|shadow)\b/i, weight: 3, category: 'offensive_third_party' },
  // account farming × 2
  { pattern: /\b(captcha\s+solver|temp\s+mail|sms\s+bom|ip\s+rotat|proxy\s+list|vpn\s+rotate|account\s+creat|bulk\s+signup|referral\s+farm|airdrop\s+bot)\b/i, weight: 2, category: 'account_farming' },
  // credit relay × 2
  { pattern: /\b(openrouter|reverse\s+proxy|resell\s+api|api\s+resell|free\s+tier\s+abuse|relay\s+gpt|relay\s+claude|unlimited\s+key)\b/i, weight: 2, category: 'credit_relay' },
  // license circumvention × 2
  { pattern: /\b(crack|keygen|serial\s+key|license\s+bypass|activation\s+bypass|patch\s+exe|qoderbox|koderbox)\b/i, weight: 2, category: 'license_circumvention' },
]

export interface CandidateTurn {
  id: string
  userId: string
  source: string
  createdAt: Date
  userText: string
  assistantText: string
}

export interface AbuseCandidate {
  userId: string
  email: string
  createdAt: Date
  ipPrefix: string | null
  deviceId: string | null
  keywordScore: number
  turns: CandidateTurn[]
  /** Set when this candidate belongs to a cluster. */
  clusterKey?: string
}

function keywordScore(text: string): number {
  let score = 0
  for (const kw of KEYWORD_WEIGHTS) {
    if (kw.pattern.test(text)) score += kw.weight
  }
  return score
}

/**
 * Gather free-account candidates from the last 24h of proxy_turns.
 *
 * `hasBannedAt` controls whether the query filters out already-banned users.
 * Pass `false` only in dry-run mode against a pre-migration database; the
 * caller (`runAbuseCheckCore`) refuses `--apply` when it is `false`.
 *
 * Returns up to ABUSE_CANDIDATE_CAP accounts, highest keyword score first.
 * Each candidate's `turns` are drawn from the last ABUSE_JUDGE_WINDOW_DAYS days
 * (up to ABUSE_JUDGE_MAX_TURNS) so the judge has enough context even for
 * accounts that were only lightly active on the trigger day.
 */
export async function gatherCandidates(
  db: any,
  since: Date,
  clusterKeys: Map<string, string>,
  hasBannedAt: boolean,
): Promise<AbuseCandidate[]> {
  type TurnRow = {
    userId: string
    userText: string | null
    assistantText: string | null
    id: string
    source: string
    createdAt: Date
  }

  // Conditionally include the bannedAt filter (omit on pre-migration DB in dry-run).
  const bannedFilter = hasBannedAt ? Prisma.sql`AND u."bannedAt" IS NULL` : Prisma.empty

  // 1. Users who had turns in the last 24h, excluding banned, internal and paid.
  const activeTurns = await db.$queryRaw<TurnRow[]>`
    SELECT
      pt."userId",
      pt."id",
      pt."source",
      pt."firstAt" as "createdAt",
      LEFT(pt."userText", 2000) as "userText",
      RIGHT(pt."assistantText", 1500) as "assistantText"
    FROM proxy_turns pt
    JOIN users u ON u.id = pt."userId"
    WHERE
      pt."firstAt" >= ${since}
      AND pt."userId" IS NOT NULL
      ${bannedFilter}
      AND u.role = 'user'
      AND u.email NOT ILIKE '%@shogo.ai'
      AND u.email NOT ILIKE '%@getodin.ai'
      AND NOT EXISTS (
        SELECT 1 FROM members m
        JOIN subscriptions s ON s."workspaceId" = m."workspaceId"
        WHERE m."userId" = pt."userId"
          AND s.status IN ('active','trialing','past_due')
      )
      AND NOT EXISTS (
        SELECT 1 FROM workspace_grants wg
        JOIN members mwg ON mwg."workspaceId" = wg."workspaceId"
        WHERE mwg."userId" = pt."userId"
          AND (wg."expiresAt" IS NULL OR wg."expiresAt" > NOW())
      )
    ORDER BY pt."firstAt" DESC
  `

  // 2. Group turns by userId.
  const byUser = new Map<
    string,
    { turns: CandidateTurn[]; rawScore: number }
  >()

  for (const row of activeTurns) {
    if (!row.userId) continue
    const combined = `${row.userText ?? ''} ${row.assistantText ?? ''}`
    const redacted = redactSecrets(combined)
    const score = keywordScore(redacted)
    const existing = byUser.get(row.userId)
    if (existing) {
      existing.turns.push({
        id: row.id,
        userId: row.userId,
        source: row.source,
        createdAt: row.createdAt,
        userText: redactSecrets(row.userText ?? ''),
        assistantText: redactSecrets(row.assistantText ?? ''),
      })
      existing.rawScore += score
    } else {
      byUser.set(row.userId, {
        turns: [
          {
            id: row.id,
            userId: row.userId,
            source: row.source,
            createdAt: row.createdAt,
            userText: redactSecrets(row.userText ?? ''),
            assistantText: redactSecrets(row.assistantText ?? ''),
          },
        ],
        rawScore: score,
      })
    }
  }

  // 3. Fetch user rows for matched accounts.
  const userIds = [...byUser.keys()]
  if (userIds.length === 0) return []

  const users: Array<{
    id: string
    email: string
    createdAt: Date
    ipPrefix: string | null
    deviceId: string | null
  }> = await db.signupRiskAssessment.findMany({
    where: { userId: { in: userIds } },
    select: {
      userId: true,
      ipPrefix: true,
      deviceId: true,
    },
  }).then((rows: any[]) => {
    const riskMap = new Map(rows.map((r: any) => [r.userId, r]))
    return db.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, email: true, createdAt: true },
    }).then((us: any[]) =>
      us.map((u: any) => ({
        id: u.id,
        email: u.email,
        createdAt: u.createdAt,
        ipPrefix: riskMap.get(u.id)?.ipPrefix ?? null,
        deviceId: riskMap.get(u.id)?.deviceId ?? null,
      })),
    )
  })

  const preFilterCandidates: Array<{
    userId: string; email: string; createdAt: Date
    ipPrefix: string | null; deviceId: string | null
    keywordScore: number; clusterKey?: string
  }> = []

  for (const user of users) {
    const data = byUser.get(user.id)
    if (!data) continue
    const inCluster = clusterKeys.has(user.id)
    const score = data.rawScore

    // Pre-filter: include only if keyword score ≥ 6 OR in a cluster.
    if (score < 6 && !inCluster) continue

    preFilterCandidates.push({
      userId: user.id,
      email: user.email,
      createdAt: user.createdAt,
      ipPrefix: user.ipPrefix,
      deviceId: user.deviceId,
      keywordScore: score,
      clusterKey: clusterKeys.get(user.id),
    })
  }

  // Sort by keyword score desc, cap.
  preFilterCandidates.sort((a, b) => b.keywordScore - a.keywordScore)
  const dropped = Math.max(0, preFilterCandidates.length - ABUSE_CANDIDATE_CAP)
  if (dropped > 0) {
    console.log(`[abuse-check] Pre-filter: ${preFilterCandidates.length} candidates, dropping ${dropped} at cap`)
  }
  const capped = preFilterCandidates.slice(0, ABUSE_CANDIDATE_CAP)

  if (capped.length === 0) return []

  // 4. Fetch judge turns: last ABUSE_JUDGE_WINDOW_DAYS days (not just the
  //    trigger 24h), up to ABUSE_JUDGE_MAX_TURNS per candidate. This avoids
  //    the false-negative where an account has few turns yesterday but many
  //    indicative turns across the past week.
  const judgeWindowStart = new Date(since.getTime() - (ABUSE_JUDGE_WINDOW_DAYS - 1) * 24 * 60 * 60 * 1000)
  const cappedIds = capped.map((c) => c.userId)

  const judgeTurns = await db.$queryRaw<TurnRow[]>`
    SELECT
      pt."userId",
      pt."id",
      pt."source",
      pt."firstAt" as "createdAt",
      LEFT(pt."userText", 2000) as "userText",
      RIGHT(pt."assistantText", 1500) as "assistantText"
    FROM (
      SELECT *,
        ROW_NUMBER() OVER (PARTITION BY "userId" ORDER BY "firstAt" DESC) as rn
      FROM proxy_turns
      WHERE "userId" = ANY(${cappedIds})
        AND "firstAt" >= ${judgeWindowStart}
        AND "userText" IS NOT NULL
    ) pt
    WHERE pt.rn <= ${ABUSE_JUDGE_MAX_TURNS}
    ORDER BY pt."userId", pt."firstAt" DESC
  `

  // Group judge turns by userId.
  const judgeTurnsByUser = new Map<string, CandidateTurn[]>()
  for (const row of judgeTurns) {
    if (!row.userId) continue
    const list = judgeTurnsByUser.get(row.userId) ?? []
    list.push({
      id: row.id,
      userId: row.userId,
      source: row.source,
      createdAt: row.createdAt,
      userText: redactSecrets(row.userText ?? ''),
      assistantText: redactSecrets(row.assistantText ?? ''),
    })
    judgeTurnsByUser.set(row.userId, list)
  }

  // Build final candidates with 7-day turns.
  const candidates: AbuseCandidate[] = capped.map((c) => ({
    ...c,
    turns: judgeTurnsByUser.get(c.userId) ?? byUser.get(c.userId)?.turns ?? [],
  }))

  return candidates
}
