// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Desktop: reprice stored usage once real per-token rates are known.
 *
 * Cloud-only models carry their rates in the cloud catalog. Until the catalog
 * served them, desktops priced these models at a guessed bucket (sonnet, later
 * the family bucket), and rows recorded while rates are unavailable carry
 * `pricingUnknown: true` with a cost of 0. After each model-registry load:
 *
 * - rows marked `pricingUnknown` are repriced for every model with rates;
 * - the first time a cloud model's rates arrive, all of its history is
 *   repriced (none of it was ever priced from real rates), then a
 *   `local_config` flag stops it from repeating.
 *
 * SQLite only (desktop). Updates `agent_cost_metrics.creditCost` and
 * `usage_events.rawUsd` (+ the cost fields in `actionMetadata`).
 */
import { prisma, Prisma } from './prisma'
import { MARKUP_MULTIPLIER } from './usage-cost'
import type { DbModelPricing } from './db-model-pricing'

const FLAG_PREFIX = 'usage-repriced:'

let inflight: Promise<void> | null = null

export function repriceLocalUsage(
  pricing: ReadonlyMap<string, DbModelPricing>,
  cloudIds: ReadonlySet<string>,
): Promise<void> {
  if (process.env.SHOGO_LOCAL_MODE !== 'true' || pricing.size === 0) return Promise.resolve()
  if (inflight) return inflight
  inflight = run(pricing, cloudIds)
    .catch((err) => console.warn('[LocalUsageRepricing] failed:', err?.message ?? err))
    .finally(() => {
      inflight = null
    })
  return inflight
}

async function run(pricing: ReadonlyMap<string, DbModelPricing>, cloudIds: ReadonlySet<string>): Promise<void> {
  const db = prisma as any
  const flagged = new Set<string>(
    (await db.localConfig.findMany({ where: { key: { startsWith: FLAG_PREFIX } }, select: { key: true } }))
      .map((r: { key: string }) => r.key.slice(FLAG_PREFIX.length)),
  )

  const unknown = new Set<string>(
    (await db.$queryRaw(Prisma.sql`
      SELECT DISTINCT "model" AS "model" FROM "agent_cost_metrics" WHERE "metadata" LIKE '%"pricingUnknown"%'
      UNION
      SELECT DISTINCT json_extract("actionMetadata", '$.model') FROM "usage_events"
      WHERE "actionMetadata" LIKE '%"pricingUnknown"%' AND json_valid("actionMetadata")
    `) as Array<{ model: string | null }>).flatMap((r) => (r.model ? [r.model] : [])),
  )

  for (const [modelId, rates] of pricing) {
    const allRows = cloudIds.has(modelId) && !flagged.has(modelId)
    if (!allRows && !unknown.has(modelId)) continue
    const metrics = await db.$executeRaw(repriceMetricsSql(modelId, rates, allRows))
    const events = await db.$executeRaw(repriceEventsSql(modelId, rates, allRows))
    if (allRows) {
      await db.localConfig.upsert({
        where: { key: FLAG_PREFIX + modelId },
        create: { key: FLAG_PREFIX + modelId, value: JSON.stringify(rates) },
        update: { value: JSON.stringify(rates) },
      })
    }
    if (metrics > 0 || events > 0) {
      console.log(`[LocalUsageRepricing] repriced ${metrics} cost metric(s) and ${events} usage event(s) for ${modelId}`)
    }
  }
}

function costSql(rates: DbModelPricing, tokens: (field: string) => Prisma.Sql): Prisma.Sql {
  return Prisma.sql`((${tokens('inputTokens')} * ${rates.inputPerMillion}
    + ${tokens('cachedInputTokens')} * ${rates.cachedInputPerMillion}
    + ${tokens('cacheWriteTokens')} * ${rates.cacheWritePerMillion}
    + ${tokens('outputTokens')} * ${rates.outputPerMillion}) / 1000000.0)`
}

export function repriceMetricsSql(modelId: string, rates: DbModelPricing, allRows: boolean): Prisma.Sql {
  const unknown = Prisma.sql`(json_valid("metadata") AND json_extract("metadata", '$.pricingUnknown') = 1)`
  return Prisma.sql`
    UPDATE "agent_cost_metrics" SET
      "creditCost" = ${costSql(rates, (f) => Prisma.raw(`"${f}"`))},
      "metadata" = CASE WHEN ${unknown} THEN json_remove("metadata", '$.pricingUnknown') ELSE "metadata" END
    WHERE "model" = ${modelId}
      AND ("inputTokens" + "cachedInputTokens" + "cacheWriteTokens" + "outputTokens") > 0
      AND (${allRows ? 1 : 0} = 1 OR ${unknown})`
}

export function repriceEventsSql(modelId: string, rates: DbModelPricing, allRows: boolean): Prisma.Sql {
  const meta = (path: string) => Prisma.raw(`COALESCE(json_extract("actionMetadata", '$.${path}'), 0)`)
  const cost = costSql(rates, meta)
  return Prisma.sql`
    UPDATE "usage_events" SET
      "rawUsd" = ${cost},
      "actionMetadata" = json_replace(
        json_set(json_remove("actionMetadata", '$.pricingUnknown'), '$.rawUsd', ${cost}),
        '$.tokenRawUsd', ${cost},
        '$.tokenBilledUsd', ${cost} * ${MARKUP_MULTIPLIER}
      )
    WHERE json_valid("actionMetadata")
      AND json_extract("actionMetadata", '$.model') = ${modelId}
      AND json_extract("actionMetadata", '$.inputTokens') IS NOT NULL
      AND (${allRows ? 1 : 0} = 1 OR json_extract("actionMetadata", '$.pricingUnknown') = 1)`
}
