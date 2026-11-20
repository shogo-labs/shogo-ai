// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Free-account candidate selection for the daily abuse check.
 *
 * "Free" means: no active/trialing/past_due subscription on any workspace
 * the user is a member of, no unexpired workspace_grant, role = user, not
 * banned, and not an internal email (shogo.ai / getodin.ai / super_admin).
 */

import { ABUSE_CANDIDATE_CAP } from '../../config/abuse-config'
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
 * Returns up to ABUSE_CANDIDATE_CAP accounts, highest keyword score first.
 */
export async function gatherCandidates(
  db: any,
  since: Date,
  clusterKeys: Map<string, string>,
): Promise<AbuseCandidate[]> {
  type TurnRow = {
    userId: string
    userText: string | null
    assistantText: string | null
    id: string
    source: string
    createdAt: Date
  }

  // 1. Users who had turns in the last 24h, excluding banned, internal and paid.
  // Falls back gracefully when the migration hasn't been applied yet (pre-migration
  // prod: `u."bannedAt"` doesn't exist — PG error 42703). The dry-run replay needs
  // to work against an unmigrated database; without --apply the results are read-only.
  let activeTurns: TurnRow[]
  try {
    activeTurns = await db.$queryRaw`
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
        AND u."bannedAt" IS NULL
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
  } catch (err: any) {
    // Pre-migration fallback: if the bannedAt column doesn't exist yet (42703),
    // retry without the filter. Already-banned users may appear as candidates in
    // dry-run mode, which is acceptable — they won't be re-banned.
    const pgMsg = String(err?.meta?.driverAdapterError?.cause?.originalMessage ?? err?.message ?? '')
    if (err?.code === 'P2010' && (err?.meta?.driverAdapterError?.cause?.kind === 'ColumnNotFound' || pgMsg.includes('bannedAt'))) {
      console.warn('[abuse-check] bannedAt column not found — running pre-migration fallback (dry-run only)')
      activeTurns = await db.$queryRaw`
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
    } else {
      throw err
    }
  }

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

  const candidates: AbuseCandidate[] = []

  for (const user of users) {
    const data = byUser.get(user.id)
    if (!data) continue
    const inCluster = clusterKeys.has(user.id)
    const score = data.rawScore

    // Pre-filter: include only if keyword score ≥ 6 OR in a cluster.
    if (score < 6 && !inCluster) continue

    candidates.push({
      userId: user.id,
      email: user.email,
      createdAt: user.createdAt,
      ipPrefix: user.ipPrefix,
      deviceId: user.deviceId,
      keywordScore: score,
      turns: data.turns,
      clusterKey: clusterKeys.get(user.id),
    })
  }

  // Sort by keyword score desc, cap.
  candidates.sort((a, b) => b.keywordScore - a.keywordScore)
  const dropped = Math.max(0, candidates.length - ABUSE_CANDIDATE_CAP)
  if (dropped > 0) {
    console.log(`[abuse-check] Pre-filter: ${candidates.length} candidates, dropping ${dropped} at cap`)
  }
  return candidates.slice(0, ABUSE_CANDIDATE_CAP)
}
