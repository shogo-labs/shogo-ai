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
 *   - Fable 5.1 (`claude-fable-5-1`) — native Anthropic, premium / fable /
 *     current, 128k output, real published per-token pricing ($10 in / $50
 *     out, $0.25 cached-input — Fable 5.1's special 0.025x cache-read rate).
 *   - GPT-6 Astra (`gpt-6-astra`) — native OpenAI, premium / gpt / current,
 *     128k output. Already existed in the static `MODEL_CATALOG` but was
 *     never DB-seeded, so it never actually appeared in the picker on any
 *     deployment with DB-defined models (the picker only falls back to the
 *     static catalog when the DB has zero rows — see
 *     `resolveVisibleCatalogModels` in
 *     apps/api/src/services/visible-models.service.ts).
 *   - Sonnet 4.6 (`claude-sonnet-4-6`) — explicit `legacy` row, mirroring
 *     the Opus 4.8 row below, so it's visible/manageable in the DB-backed
 *     admin model list rather than only existing implicitly via the
 *     static catalog fallback.
 *   - MiMo v2.5 (`mimo-v2.5`) — a custom OpenAI-compatible provider
 *     (xiaomimimo). Only seeded when the staging key is provided via the
 *     `MIMO_API_KEY` env var AND `SECRETS_ENCRYPTION_KEY` is configured, so the
 *     key is never committed to source. Otherwise add it from the super-admin
 *     "Custom Providers" form instead. Marked `capabilities.supportsAudioInput`
 *     since MiMo v2.5 accepts `input_audio` content blocks natively — this is
 *     the model backing the public `hoshi-1.0` alias, so re-running this
 *     script also flips on audio support for Hoshi (see
 *     `resolveModelSupportsAudioInput` in apps/api/src/routes/ai-proxy.ts).
 *   - Hoshi 2.0 (`hoshi-2-0`) — a DeepSeek-V4.1-Flash custom provider with
 *     high-effort thinking enabled. Only seeded when `DEEPSEEK_API_KEY` and
 *     `SECRETS_ENCRYPTION_KEY` are configured.
 *
 * Idempotent — safe to re-run (upserts by id / by provider label).
 *
 * Usage (local mode / sqlite):
 *   SHOGO_LOCAL_MODE=true SECRETS_ENCRYPTION_KEY=$(openssl rand -base64 32) \
 *     bun scripts/seed-db-models.ts
 *
 * Hosted / Postgres:
 *   DATABASE_URL=postgres://... SECRETS_ENCRYPTION_KEY=... MIMO_API_KEY=sk-... \
 *     DEEPSEEK_API_KEY=sk-... \
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

async function seedFable51(): Promise<void> {
  const common = {
    displayName: 'Claude Fable 5.1',
    shortDisplayName: 'Fable 5.1',
    tier: 'premium',
    family: 'fable',
    generation: 'current',
    maxOutputTokens: 128_000,
    enabled: true,
    aliases: ['claude-fable-5-1', 'fable', 'claude-fable'],
    // Not yet run through the subagent-smoke eval — leave capabilities unset
    // (unrated) until verified, per the ModelCapabilities doc comment.
    capabilities: null,
    // Anthropic-published rates (see MODEL_DOLLAR_COSTS['claude-fable-5-1']).
    // cachedInputPerMillion uses Fable 5.1's special 0.025x-of-input cache-read
    // rate rather than the standard 0.1x multiplier.
    inputPerMillion: 10.0,
    cachedInputPerMillion: 0.25,
    cacheWritePerMillion: 12.5,
    outputPerMillion: 50.0,
    updatedBy: SEED_USER,
  }
  await upsertModel(
    { provider: 'anthropic', apiModel: 'claude-fable-5-1' },
    { providerId: null, sortOrder: 0, ...common },
    common,
  )
  console.log('[seed-db-models] Upserted Fable 5.1 (apiModel=claude-fable-5-1)')
}

async function seedGptAstra(): Promise<void> {
  const common = {
    displayName: 'GPT-6 Astra',
    shortDisplayName: 'Astra',
    tier: 'premium',
    family: 'gpt',
    generation: 'current',
    maxOutputTokens: 128_000,
    enabled: true,
    aliases: ['gpt-6-astra', 'astra'],
    // Not yet run through the subagent-smoke eval — leave capabilities unset
    // (unrated) until verified, per the ModelCapabilities doc comment.
    capabilities: null,
    // OpenAI-published rates (see MODEL_DOLLAR_COSTS['gpt-6-astra']).
    inputPerMillion: 10.0,
    cachedInputPerMillion: 1.0,
    cacheWritePerMillion: 12.5,
    outputPerMillion: 50.0,
    updatedBy: SEED_USER,
  }
  await upsertModel(
    { provider: 'openai', apiModel: 'gpt-6-astra' },
    { providerId: null, sortOrder: 3, ...common },
    common,
  )
  console.log('[seed-db-models] Upserted GPT-6 Astra (apiModel=gpt-6-astra)')
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
    // MiMo v2.5 accepts `input_audio` content blocks natively over the
    // OpenAI-compatible chat/completions wire format — see
    // `resolveModelSupportsAudioInput` (apps/api/src/routes/ai-proxy.ts),
    // which checks this DB-defined capability (the static MODEL_CATALOG
    // only knows about `gpt-audio`).
    capabilities: { supportsAudioInput: true },
    // Placeholder pricing — update from the MiMo pricing page via admin UI.
    inputPerMillion: 0,
    cachedInputPerMillion: 0,
    cacheWritePerMillion: 0,
    outputPerMillion: 0,
    updatedBy: SEED_USER,
  }
  await upsertModel(
    { provider: 'custom', apiModel: 'mimo-v2.5' },
    { sortOrder: 1, ...modelCommon },
    modelCommon,
  )
  console.log('[seed-db-models] Upserted MiMo v2.5 (apiModel=mimo-v2.5)')
}

async function seedDeepSeek(): Promise<void> {
  const apiKey = process.env.DEEPSEEK_API_KEY
  if (!apiKey) {
    console.log(
      '[seed-db-models] DEEPSEEK_API_KEY not set — skipping Hoshi 2.0. Add the provider + key from the super-admin "Custom Providers" form instead.',
    )
    return
  }
  if (!isSecretCryptoConfigured()) {
    console.log('[seed-db-models] SECRETS_ENCRYPTION_KEY not configured — cannot encrypt DeepSeek key; skipping Hoshi 2.0.')
    return
  }

  const label = 'DeepSeek'
  const existing = await (prisma as any).modelProvider.findFirst({ where: { label } })
  const providerData = {
    label,
    baseUrl: 'https://api.deepseek.com/v1',
    protocol: 'openai',
    authStyle: 'bearer',
    encryptedApiKey: encryptSecret(apiKey),
    enabled: true,
    updatedBy: SEED_USER,
  }
  const provider = existing
    ? await (prisma as any).modelProvider.update({ where: { id: existing.id }, data: providerData })
    : await (prisma as any).modelProvider.create({ data: providerData })
  console.log(`[seed-db-models] Upserted DeepSeek provider (${provider.id})`)

  const modelCommon = {
    providerId: provider.id,
    displayName: 'Hoshi 2.0',
    shortDisplayName: 'Hoshi 2.0',
    tier: 'standard',
    family: 'other',
    generation: 'current',
    maxOutputTokens: 128_000,
    contextWindow: 1_000_000,
    reasoningEffort: 'high',
    enabled: true,
    aliases: ['hoshi-2-0'],
    capabilities: { upstream: 'deepseek', supportsAudioInput: false },
    // Keep the user-facing Hoshi rate unchanged; provider cost is tracked
    // separately using DeepSeek's current rates in release analytics.
    inputPerMillion: 0.15,
    cachedInputPerMillion: 0.001,
    cacheWritePerMillion: 0.15,
    outputPerMillion: 0.30,
    updatedBy: SEED_USER,
  }
  await upsertModel(
    { provider: 'custom', apiModel: 'deepseek-flash' },
    { sortOrder: 1, ...modelCommon },
    modelCommon,
  )
  console.log('[seed-db-models] Upserted Hoshi 2.0 (apiModel=deepseek-flash)')
}

async function seedGptLive1(): Promise<void> {
  const common = {
    displayName: 'GPT-Live 1',
    shortDisplayName: 'GPT-Live 1',
    tier: 'standard',
    family: 'gpt',
    generation: 'current',
    kind: 'live',
    maxOutputTokens: 0,
    enabled: true,
    aliases: ['gpt-live-1'],
    description: 'Full-duplex voice conversations with interruption handling and backend delegation.',
    usdPerMinute: 0.05,
    // Live sessions are billed by duration rather than tokens.
    inputPerMillion: 0,
    cachedInputPerMillion: 0,
    cacheWritePerMillion: 0,
    outputPerMillion: 0,
    updatedBy: SEED_USER,
  }
  await upsertModel(
    { provider: 'openai', apiModel: 'gpt-live-1' },
    { providerId: null, sortOrder: 100, ...common },
    common,
  )
  console.log('[seed-db-models] Upserted GPT-Live 1')
}

async function main(): Promise<void> {
  await seedOpus48()
  await seedOpus5()
  await seedSonnet5()
  await seedFable51()
  await seedSonnet46()
  await seedMimo()
  await seedDeepSeek()
  await seedGptLive1()
  await seedGptAstra()
  console.log('[seed-db-models] Done.')
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[seed-db-models] Failed:', err)
    process.exit(1)
  })
