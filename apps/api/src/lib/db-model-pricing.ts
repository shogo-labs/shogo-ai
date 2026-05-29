// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Lightweight indirection for DB-defined per-token pricing.
 *
 * Billing helpers (`usage-cost.ts`, `cost-analytics.service.ts`) need the
 * per-token rates of DB-defined models, which live in the model registry.
 * Importing the registry directly from those hot, widely-imported billing
 * modules would couple them to the full `@shogo/model-catalog` surface at
 * module-load time. Instead the registry *registers* its pricing accessor
 * here once it loads, and the billing helpers read through this hook.
 *
 * When no provider is registered (e.g. a unit test that never loads the
 * registry, or a misconfigured server) the accessor returns `undefined` and
 * billing falls back to the static list-price buckets — it never crashes.
 */

export interface DbModelPricing {
  inputPerMillion: number
  cachedInputPerMillion: number
  cacheWritePerMillion: number
  outputPerMillion: number
}

type DbModelPricingProvider = (id: string) => DbModelPricing | undefined

let provider: DbModelPricingProvider | null = null

/** Registered by the model registry once it loads. */
export function setDbModelPricingProvider(fn: DbModelPricingProvider): void {
  provider = fn
}

/** Per-token pricing for a DB-defined model id, or undefined if none. */
export function getDbModelPricing(id: string): DbModelPricing | undefined {
  return provider ? provider(id) : undefined
}
