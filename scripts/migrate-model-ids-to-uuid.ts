// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * One-off migration: switch DB-defined model ids (`model_definitions.id`) from
 * the upstream provider slug to a generated UUID.
 *
 * Why: the canonical model id is the value clients send and the key billing,
 * routing, and analytics use. Historically it WAS the provider slug (e.g.
 * `mimo-v2.5`), which coupled the public id to the upstream model name and
 * prevented two catalog entries from pointing at the same upstream model. We
 * decouple them: `id` becomes an opaque UUID, the provider slug moves to (and
 * stays in) `apiModel` + `aliases`.
 *
 * What it does, per `model_definitions` row whose id is not already a UUID:
 *   1. Generate a UUID, recording `oldId -> newId`.
 *   2. Ensure the old slug is preserved in `aliases` (so any reference that
 *      still holds it keeps resolving via the registry's alias map — the
 *      safety net for data this script can't reach, e.g. per-project
 *      `config.json` files or client-cached selections).
 *   3. Backfill every DB column that stores a model id by value:
 *        - agent_configs.modelName            (project/agent default model)
 *        - project_agents.model
 *        - subagent_model_overrides.model
 *        - agent_cost_metrics.model           (analytics)
 *        - agent_eval_results.model
 *        - eval_runs.model
 *        - model_experiments.modelA / modelB
 *        - usage_events.actionMetadata.model  (JSON; batched scan)
 *        - platform_settings `models.visible` (catalogIds JSON array)
 *   4. Update `model_definitions.id` to the UUID.
 *
 * Idempotent: rows already keyed by a UUID are skipped, so re-running is safe.
 * Works on both Postgres (cloud) and SQLite (desktop/local) via the same
 * Prisma client — no raw SQL, so JSON handling stays portable.
 *
 * Usage:
 *   # local / sqlite
 *   SHOGO_LOCAL_MODE=true bun scripts/migrate-model-ids-to-uuid.ts
 *   # hosted / postgres
 *   DATABASE_URL=postgres://... bun scripts/migrate-model-ids-to-uuid.ts
 *
 *   Add `--dry-run` to print the planned id swaps + reference counts without
 *   writing anything.
 */

import { randomUUID } from 'node:crypto'
import { prisma } from '../apps/api/src/lib/prisma'

const DRY_RUN = process.argv.includes('--dry-run')
const VISIBLE_MODELS_KEY = 'models.visible'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const isUuid = (s: string): boolean => UUID_RE.test(s)

/** Run an updateMany, tolerating a deployment where the table is absent. */
async function safeUpdateMany(
  label: string,
  fn: () => Promise<{ count: number }>,
): Promise<number> {
  try {
    const { count } = await fn()
    return count
  } catch (err: any) {
    // Missing table/column on a given schema variant — skip, don't abort.
    if (err?.code === 'P2021' || err?.code === 'P2022') {
      console.warn(`[migrate-model-ids]   (skip ${label}: ${err.code})`)
      return 0
    }
    throw err
  }
}

interface IdSwap {
  oldId: string
  newId: string
  apiModel: string
}

export async function planSwaps(): Promise<IdSwap[]> {
  const rows = (await (prisma as any).modelDefinition.findMany()) as Array<{
    id: string
    apiModel: string
    aliases: unknown
  }>
  return rows
    .filter((r) => !isUuid(r.id))
    .map((r) => ({ oldId: r.id, newId: randomUUID(), apiModel: r.apiModel }))
}

/** Backfill the simple String columns + this row's aliases/id for one swap.
 *  Runs against a transaction client (`tx`) so the whole row re-key is atomic. */
async function applySwap(tx: any, swap: IdSwap, existingAliases: string[]): Promise<void> {
  const { oldId, newId } = swap
  const where = (field: string) => ({ where: { [field]: oldId }, data: { [field]: newId } })

  const counts: Record<string, number> = {}
  counts['agent_configs.modelName'] = await safeUpdateMany('agent_configs', () =>
    tx.agentConfig.updateMany({ where: { modelName: oldId }, data: { modelName: newId } }),
  )
  counts['project_agents.model'] = await safeUpdateMany('project_agents', () =>
    tx.projectAgent.updateMany(where('model')),
  )
  counts['subagent_model_overrides.model'] = await safeUpdateMany('subagent_model_overrides', () =>
    tx.subagentModelOverride.updateMany(where('model')),
  )
  counts['agent_cost_metrics.model'] = await safeUpdateMany('agent_cost_metrics', () =>
    tx.agentCostMetric.updateMany(where('model')),
  )
  counts['agent_eval_results.model'] = await safeUpdateMany('agent_eval_results', () =>
    tx.agentEvalResult.updateMany(where('model')),
  )
  counts['eval_runs.model'] = await safeUpdateMany('eval_runs', () =>
    tx.evalRun.updateMany(where('model')),
  )
  counts['model_experiments.modelA'] = await safeUpdateMany('model_experiments.modelA', () =>
    tx.modelExperiment.updateMany({ where: { modelA: oldId }, data: { modelA: newId } }),
  )
  counts['model_experiments.modelB'] = await safeUpdateMany('model_experiments.modelB', () =>
    tx.modelExperiment.updateMany({ where: { modelB: oldId }, data: { modelB: newId } }),
  )

  // Preserve the old slug as an alias so anything we can't reach still resolves.
  const aliases = Array.from(new Set([...existingAliases, oldId]))
  await tx.modelDefinition.update({
    where: { id: oldId },
    data: { id: newId, aliases },
  })

  const summary = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k}=${n}`)
    .join(', ')
  console.log(`[migrate-model-ids]   ${oldId} -> ${newId}${summary ? ` (${summary})` : ''}`)
}

/** Rewrite the `models.visible` allowlist's catalogIds in place. */
export async function migrateVisibleModelsConfig(map: Map<string, string>, dryRun = DRY_RUN): Promise<void> {
  let row: { value: string } | null = null
  try {
    row = await (prisma as any).platformSetting.findUnique({ where: { key: VISIBLE_MODELS_KEY } })
  } catch {
    return
  }
  if (!row?.value) return
  let parsed: any
  try {
    parsed = JSON.parse(row.value)
  } catch {
    return
  }
  if (!Array.isArray(parsed?.catalogIds)) return
  let changed = false
  const next = parsed.catalogIds.map((id: unknown) => {
    if (typeof id === 'string' && map.has(id)) {
      changed = true
      return map.get(id)!
    }
    return id
  })
  if (!changed) return
  console.log(`[migrate-model-ids]   platform_settings.${VISIBLE_MODELS_KEY}: remapped ${next.length} catalogIds`)
  if (dryRun) return
  await (prisma as any).platformSetting.update({
    where: { key: VISIBLE_MODELS_KEY },
    data: { value: JSON.stringify({ ...parsed, catalogIds: next }) },
  })
}

/**
 * Rewrite `usage_events.actionMetadata.model` for migrated ids. Batched cursor
 * scan so it stays bounded on large audit tables; only rows whose embedded
 * model id was migrated are written.
 */
export async function migrateUsageEvents(map: Map<string, string>, dryRun = DRY_RUN): Promise<void> {
  const BATCH = 500
  let cursor: string | undefined
  let scanned = 0
  let updated = 0
  for (;;) {
    let rows: Array<{ id: string; actionMetadata: any }>
    try {
      rows = await (prisma as any).usageEvent.findMany({
        take: BATCH,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        orderBy: { id: 'asc' },
        select: { id: true, actionMetadata: true },
      })
    } catch (err: any) {
      if (err?.code === 'P2021' || err?.code === 'P2022') return
      throw err
    }
    if (rows.length === 0) break
    scanned += rows.length
    cursor = rows[rows.length - 1].id

    for (const row of rows) {
      // SQLite returns Json columns as strings; Postgres as parsed objects.
      let meta = row.actionMetadata
      if (typeof meta === 'string') {
        try {
          meta = JSON.parse(meta)
        } catch {
          continue
        }
      }
      if (!meta || typeof meta !== 'object') continue
      const model = (meta as any).model
      if (typeof model !== 'string' || !map.has(model)) continue
      const nextMeta = { ...(meta as any), model: map.get(model)! }
      updated++
      if (!dryRun) {
        await (prisma as any).usageEvent.update({
          where: { id: row.id },
          data: { actionMetadata: nextMeta },
        })
      }
    }
    if (rows.length < BATCH) break
  }
  if (scanned > 0) {
    console.log(`[migrate-model-ids]   usage_events: scanned ${scanned}, remapped ${updated}`)
  }
}

export async function runMigration(dryRun = DRY_RUN): Promise<{ migrated: number }> {
  console.log(`[migrate-model-ids] Starting${dryRun ? ' (dry run)' : ''}…`)
  const swaps = await planSwaps()
  if (swaps.length === 0) {
    console.log('[migrate-model-ids] No slug-keyed model_definitions found — nothing to do.')
    return { migrated: 0 }
  }
  const map = new Map(swaps.map((s) => [s.oldId, s.newId]))
  console.log(`[migrate-model-ids] ${swaps.length} model(s) to re-key:`)

  if (dryRun) {
    for (const s of swaps) console.log(`[migrate-model-ids]   ${s.oldId} (apiModel=${s.apiModel}) -> ${s.newId}`)
    await migrateVisibleModelsConfig(map, dryRun)
    await migrateUsageEvents(map, dryRun)
    console.log('[migrate-model-ids] Dry run complete — no changes written.')
    return { migrated: 0 }
  }

  // Re-key each model + its simple references atomically.
  for (const swap of swaps) {
    const row = (await (prisma as any).modelDefinition.findUnique({ where: { id: swap.oldId } })) as
      | { aliases: unknown }
      | null
    if (!row) continue
    const existingAliases = Array.isArray(row.aliases)
      ? (row.aliases as unknown[]).filter((x): x is string => typeof x === 'string')
      : []
    await (prisma as any).$transaction(async (tx: any) => {
      await applySwap(tx, swap, existingAliases)
    })
  }

  // Global rewrites (span all migrated ids): visible-models config + usage audit.
  await migrateVisibleModelsConfig(map)
  await migrateUsageEvents(map)

  console.log('[migrate-model-ids] Done.')
  return { migrated: swaps.length }
}

// Only run when invoked directly (`bun scripts/migrate-model-ids-to-uuid.ts`),
// so the helpers can be imported by tests without side effects.
if (import.meta.main) {
  runMigration()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[migrate-model-ids] Failed:', err)
      process.exit(1)
    })
}
