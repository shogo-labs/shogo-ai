// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Cluster detection for the daily abuse check.
 *
 * A cluster is ≥5 free accounts created within 48h of each other that share
 * a signup ipPrefix, deviceId, or the same normalised first user message
 * (sha256 of lowercased text with whitespace collapsed). The cluster key is
 * stored on each AbuseFlag row so an admin can see the whole group at once.
 */

import { createHash } from 'node:crypto'
import { ABUSE_CLUSTER_MIN_SIZE, ABUSE_CLUSTER_WINDOW_HOURS } from '../../config/abuse-config'

/** sha256 of the normalised text. */
function messageHash(text: string): string {
  const normalised = text.toLowerCase().replace(/\s+/g, ' ').trim()
  return createHash('sha256').update(normalised).digest('hex').slice(0, 32)
}

/**
 * Returns a map of userId → clusterKey for every user that belongs to a
 * cluster of at least ABUSE_CLUSTER_MIN_SIZE free accounts.
 *
 * We look at signup_risk_assessments for ipPrefix / deviceId similarity and at
 * proxy_turns for shared first user messages.
 */
export async function detectClusters(
  db: any,
  since: Date,
  windowHours: number = ABUSE_CLUSTER_WINDOW_HOURS,
): Promise<Map<string, string>> {
  const windowStart = new Date(since.getTime() - windowHours * 60 * 60 * 1000)

  type FreeUser = {
    userId: string
    createdAt: Date
    ipPrefix: string | null
    deviceId: string | null
  }

  // Free accounts created in the cluster window.
  // Falls back gracefully when the migration hasn't been applied yet (pre-migration
  // prod: `u."bannedAt"` doesn't exist — PG error 42703).
  let freeUsers: FreeUser[]
  try {
    freeUsers = await db.$queryRaw`
      SELECT
        sra."userId",
        u."createdAt",
        sra."ipPrefix",
        sra."deviceId"
      FROM signup_risk_assessments sra
      JOIN users u ON u.id = sra."userId"
      WHERE
        u."createdAt" >= ${windowStart}
        AND u."bannedAt" IS NULL
        AND u.role = 'user'
        AND u.email NOT ILIKE '%@shogo.ai'
        AND u.email NOT ILIKE '%@getodin.ai'
        AND NOT EXISTS (
          SELECT 1 FROM members m
          JOIN subscriptions s ON s."workspaceId" = m."workspaceId"
          WHERE m."userId" = sra."userId"
            AND s.status IN ('active','trialing','past_due')
        )
    `
  } catch (err: any) {
    const pgMsg = String(err?.meta?.driverAdapterError?.cause?.originalMessage ?? err?.message ?? '')
    if (err?.code === 'P2010' && (err?.meta?.driverAdapterError?.cause?.kind === 'ColumnNotFound' || pgMsg.includes('bannedAt'))) {
      freeUsers = await db.$queryRaw`
        SELECT
          sra."userId",
          u."createdAt",
          sra."ipPrefix",
          sra."deviceId"
        FROM signup_risk_assessments sra
        JOIN users u ON u.id = sra."userId"
        WHERE
          u."createdAt" >= ${windowStart}
          AND u.role = 'user'
          AND u.email NOT ILIKE '%@shogo.ai'
          AND u.email NOT ILIKE '%@getodin.ai'
          AND NOT EXISTS (
            SELECT 1 FROM members m
            JOIN subscriptions s ON s."workspaceId" = m."workspaceId"
            WHERE m."userId" = sra."userId"
              AND s.status IN ('active','trialing','past_due')
          )
      `
    } else {
      throw err
    }
  }

  // Group by ipPrefix then by deviceId.
  const ipGroups = new Map<string, string[]>()
  const deviceGroups = new Map<string, string[]>()

  for (const u of freeUsers) {
    if (u.ipPrefix) {
      const g = ipGroups.get(u.ipPrefix) ?? []
      g.push(u.userId)
      ipGroups.set(u.ipPrefix, g)
    }
    if (u.deviceId) {
      const g = deviceGroups.get(u.deviceId) ?? []
      g.push(u.userId)
      deviceGroups.set(u.deviceId, g)
    }
  }

  // Also look at first user messages in proxy_turns.
  const firstMessages: Array<{ userId: string; userText: string }> = await db.$queryRaw`
    SELECT DISTINCT ON ("userId") "userId", LEFT("userText", 500) as "userText"
    FROM proxy_turns
    WHERE "firstAt" >= ${windowStart}
      AND "userText" IS NOT NULL
      AND "userId" IS NOT NULL
    ORDER BY "userId", "firstAt" ASC
  `

  const msgGroups = new Map<string, string[]>()
  for (const m of firstMessages) {
    if (!m.userText?.trim()) continue
    const h = messageHash(m.userText)
    const g = msgGroups.get(h) ?? []
    g.push(m.userId)
    msgGroups.set(h, g)
  }

  const result = new Map<string, string>()

  function applyGroup(prefix: string, groups: Map<string, string[]>) {
    for (const [key, userIds] of groups) {
      if (userIds.length < ABUSE_CLUSTER_MIN_SIZE) continue
      const clusterKey = `${prefix}:${key}`
      for (const uid of userIds) result.set(uid, clusterKey)
    }
  }

  applyGroup('ip', ipGroups)
  applyGroup('dev', deviceGroups)
  applyGroup('msg', msgGroups)

  return result
}
