// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Seed the DB-defined model catalog (ModelDefinition / ModelProvider) with
 * models we ship (or backfill) without waiting on a full code release:
 *
 *   - Opus 4.8 (`claude-opus-4-8`) — native Anthropic, premium / opus /
 *     current, 128k output, opus-equivalent per-token pricing, alias `opus`.
 *   - Opus 5 (`claude-opus-5`) / Sonnet 5 (`claude-sonnet-5`) — native
 *     Anthropic, 128k output, opus/sonnet-equivalent per-token pricing.
 *     Sonnet 5 is `premium` tier (it now sits alongside Opus, not the
 *     older "standard" Sonnet bracket). These also landed in the static
 *     `MODEL_CATALOG` (see packages/agent/src/model-catalog/models.ts);
 *     the DB rows here let a deployment pick them up immediately, before
 *     the next image rollout.
 *   - Sonnet 4.6 (`claude-sonnet-4-6`) — explicit `legacy` row, mirroring
 *     the Opus 4.8 row below, so it's visible/manageable in the DB-backed
 *     admin model list rather than only existing implicitly via the
 *     static catalog fallback.
 *   - MiMo v2.5 (`mimo-v2.5`) — a custom OpenAI-compatible provider
 *     (xiaomimimo). Only seeded when the staging key is provided via the
 *     `MIMO_API_KEY` env var AND `SECRETS_ENCRYPTION_KEY` is configured, so the
 *     key is never committed to source. Otherwise add it from the super-admin
 *     "Custom Providers" form instead.
 *
 * Idempotent — safe to re-run (upserts by id / by provider label).
 *
 * Usage (local mode / sqlite):
 *   SHOGO_LOCAL_MODE=true SECRETS_ENCRYPTION_KEY=$(openssl rand -base64 32) \
 *     bun scripts/seed-db-models.ts
 *
 * Hosted / Postgres:
 *   DATABASE_URL=postgres://... SECRETS_ENCRYPTION_KEY=... MIMO_API_KEY=sk-... \
 *     bun scripts/seed-db-models.ts
 *
 * Note: the MiMo staging key shared during development MUST be rotated and set
 * via env / admin UI; do not hardcode it here.
 */

import { randomUUID } from 'node:crypto'
import { prisma } from '../apps/api/src/lib/prisma'
import { encryptSecret, isSecretCryptoConfigured } from '../apps/api/src/lib/secret-crypto'

const SEED_USER = 'seed:db-models'

/**
 * Upsert a model definition keyed on `(provider, apiModel)` rather than a
 * fixed primary key: the canonical `id` is an opaque UUID now, so re-runs must
 * match on the upstream slug to stay idempotent. The provider slug (`apiModel`)
 * is always kept in `aliases` so the model stays addressable by name.
 */
async function upsertModel(
  match: { provider: string; apiModel: string },
  create: Record<string, unknown>,
  update: Record<string, unknown>,
): Promise<void> {
  const existing = await (prisma as any).modelDefinition.findFirst({ where: match })
  if (existing) {
    await (prisma as any).modelDefinition.update({ where: { id: existing.id }, data: update })
  } else {
    await (prisma as any).modelDefinition.create({
      data: { id: randomUUID(), provider: match.provider, apiModel: match.apiModel, ...create },
    })
  }
}

async function seedOpus48(): Promise<void> {
  const common = {
    displayName: 'Claude Opus 4.8',
    shortDisplayName: 'Opus 4.8',
    tier: 'premium',
    family: 'opus',
    // Superseded by Opus 5 as the current-gen flagship — kept addressable by
    // its own id but no longer claims the shared `opus`/`claude-opus`
    // aliases (see seedOpus5 below), since aliasToId is a last-write-wins
    // map and those short aliases should point at the new flagship.
    generation: 'legacy',
    maxOutputTokens: 128_000,
    enabled: true,
    aliases: ['claude-opus-4-8'],
    capabilities: { subagentOrchestration: 'reliable' },
    // opus-equivalent per-1M-token list prices (see MODEL_DOLLAR_COSTS.opus).
    inputPerMillion: 5.0,
    cachedInputPerMillion: 0.5,
    cacheWritePerMillion: 6.25,
    outputPerMillion: 25.0,
    updatedBy: SEED_USER,
  }
  await upsertModel(
    { provider: 'anthropic', apiModel: 'claude-opus-4-8' },
    { providerId: null, sortOrder: 0, ...common },
    common,
  )
  console.log('[seed-db-models] Upserted Opus 4.8 (apiModel=claude-opus-4-8)')
}

async function seedOpus5(): Promise<void> {
  const common = {
    displayName: 'Claude Opus 5',
    shortDisplayName: 'Opus 5',
    tier: 'premium',
    family: 'opus',
    generation: 'current',
    maxOutputTokens: 128_000,
    enabled: true,
    aliases: ['claude-opus-5', 'opus', 'claude-opus'],
    // Not yet run through the subagent-smoke eval — leave capabilities unset
    // (unrated) until verified, per the ModelCapabilities doc comment.
    capabilities: null,
    // opus-equivalent per-1M-token list prices (see MODEL_DOLLAR_COSTS.opus).
    inputPerMillion: 5.0,
    cachedInputPerMillion: 0.5,
    cacheWritePerMillion: 6.25,
    outputPerMillion: 25.0,
    updatedBy: SEED_USER,
  }
  await upsertModel(
    { provider: 'anthropic', apiModel: 'claude-opus-5' },
    { providerId: null, sortOrder: 0, ...common },
    common,
  )
  console.log('[seed-db-models] Upserted Opus 5 (apiModel=claude-opus-5)')
}

async function seedSonnet5(): Promise<void> {
  const common = {
    displayName: 'Claude Sonnet 5',
    shortDisplayName: 'Sonnet 5',
    // Premium, not "standard" — Sonnet 5 sits alongside Opus 5 rather than
    // the older cheaper Sonnet bracket.
    tier: 'premium',
    family: 'sonnet',
    generation: 'current',
    maxOutputTokens: 128_000,
    enabled: true,
    aliases: ['claude-sonnet-5', 'sonnet', 'claude-sonnet'],
    capabilities: null,
    // sonnet-equivalent per-1M-token list prices (see MODEL_DOLLAR_COSTS.sonnet).
    inputPerMillion: 3.0,
    cachedInputPerMillion: 0.3,
    cacheWritePerMillion: 3.75,
    outputPerMillion: 15.0,
    updatedBy: SEED_USER,
  }
  await upsertModel(
    { provider: 'anthropic', apiModel: 'claude-sonnet-5' },
    { providerId: null, sortOrder: 1, ...common },
    common,
  )
  console.log('[seed-db-models] Upserted Sonnet 5 (apiModel=claude-sonnet-5)')
}

async function seedSonnet46(): Promise<void> {
  const common = {
    displayName: 'Claude Sonnet 4.6',
    shortDisplayName: 'Sonnet 4.6',
    tier: 'standard',
    family: 'sonnet',
    generation: 'legacy',
    maxOutputTokens: 64_000,
    enabled: true,
    aliases: ['claude-sonnet-4-6'],
    capabilities: { subagentOrchestration: 'reliable' },
    inputPerMillion: 3.0,
    cachedInputPerMillion: 0.3,
    cacheWritePerMillion: 3.75,
    outputPerMillion: 15.0,
    updatedBy: SEED_USER,
  }
  await upsertModel(
    { provider: 'anthropic', apiModel: 'claude-sonnet-4-6' },
    { providerId: null, sortOrder: 2, ...common },
    common,
  )
  console.log('[seed-db-models] Upserted Sonnet 4.6 (apiModel=claude-sonnet-4-6)')
}

async function seedMimo(): Promise<void> {
  const apiKey = process.env.MIMO_API_KEY
  if (!apiKey) {
    console.log(
      '[seed-db-models] MIMO_API_KEY not set — skipping MiMo. Add the provider + key from the super-admin "Custom Providers" form instead.',
    )
    return
  }
  if (!isSecretCryptoConfigured()) {
    console.log('[seed-db-models] SECRETS_ENCRYPTION_KEY not configured — cannot encrypt MiMo key; skipping MiMo.')
    return
  }

  // Provider (upsert by label so re-runs don't duplicate).
  const label = 'MiMo'
  const existing = await (prisma as any).modelProvider.findFirst({ where: { label } })
  const providerData = {
    label,
    baseUrl: 'https://api.xiaomimimo.com/v1',
    protocol: 'openai',
    authStyle: 'bearer',
    encryptedApiKey: encryptSecret(apiKey),
    enabled: true,
    updatedBy: SEED_USER,
  }
  const provider = existing
    ? await (prisma as any).modelProvider.update({ where: { id: existing.id }, data: providerData })
    : await (prisma as any).modelProvider.create({ data: providerData })
  console.log(`[seed-db-models] Upserted MiMo provider (${provider.id})`)

  const modelCommon = {
    providerId: provider.id,
    displayName: 'MiMo v2.5',
    shortDisplayName: 'MiMo 2.5',
    tier: 'standard',
    family: 'other',
    generation: 'current',
    maxOutputTokens: 128_000,
    enabled: true,
    aliases: ['mimo-v2.5', 'mimo', 'mimo-2.5'],
    // Placeholder pricing — update from the MiMo pricing page via admin UI.
    inputPerMillion: 0,
    cachedInputPerMillion: 0,
    cacheWritePerMillion: 0,
    outputPerMillion: 0,
    updatedBy: SEED_USER,
  }
  await upsertModel(
    { provider: 'custom', apiModel: 'mimo-v2.5' },
    { sortOrder: 1, capabilities: null, ...modelCommon },
    modelCommon,
  )
  console.log('[seed-db-models] Upserted MiMo v2.5 (apiModel=mimo-v2.5)')
}

async function main(): Promise<void> {
  await seedOpus48()
  await seedOpus5()
  await seedSonnet5()
  await seedSonnet46()
  await seedMimo()
  console.log('[seed-db-models] Done.')
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[seed-db-models] Failed:', err)
    process.exit(1)
  })
