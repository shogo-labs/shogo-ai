// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Seed the DB-defined model catalog (ModelDefinition / ModelProvider) with the
 * first models we ship without a code release:
 *
 *   - Opus 4.8 (`claude-opus-4-8`) — native Anthropic, premium / opus /
 *     current, 128k output, opus-equivalent per-token pricing, alias `opus`.
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
    generation: 'current',
    maxOutputTokens: 128_000,
    enabled: true,
    aliases: ['claude-opus-4-8', 'opus', 'claude-opus'],
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
  await seedMimo()
  console.log('[seed-db-models] Done.')
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[seed-db-models] Failed:', err)
    process.exit(1)
  })
