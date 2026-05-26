// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Helper for `mock.module('../lib/prisma', ...)` factories.
 *
 * `apps/api/src/lib/prisma.ts` re-exports the entire Prisma client
 * (`export * from '../generated/prisma-pg/client'`), which means real
 * call sites can `import { prisma, Prisma, SubscriptionStatus, ... }`
 * from a single specifier. When a test replaces that module, every
 * named export the loaded code touches must exist on the mock factory's
 * return value — otherwise bun's ESM loader throws
 * `SyntaxError: Export named 'X' not found in module ...` at the first
 * route that imports the missing name.
 *
 * Wrap your stub data with `withPrismaExports({ prisma: stub })` to get
 * a mock factory shape that satisfies every named export the apps/api
 * source tree actually consumes.
 */

export const PRISMA_NAMESPACE = {
  // Pi/Prisma raw helpers used in service code paths. Keep as plain
  // identity functions so no test ever observes a "magic" wrapper.
  raw: (s: string) => s,
  sql: (s: string) => s,
  empty: '',
  TransactionIsolationLevel: {
    ReadUncommitted: 'ReadUncommitted',
    ReadCommitted: 'ReadCommitted',
    RepeatableRead: 'RepeatableRead',
    Serializable: 'Serializable',
    Snapshot: 'Snapshot',
  },
  PrismaClientKnownRequestError: class PrismaClientKnownRequestError extends Error {
    code: string
    meta?: any
    clientVersion: string
    constructor(message: string, opts: { code: string; meta?: any; clientVersion?: string }) {
      super(message)
      this.code = opts.code
      this.meta = opts.meta
      this.clientVersion = opts.clientVersion ?? 'mock'
    }
  },
  PrismaClientValidationError: class PrismaClientValidationError extends Error {},
  PrismaClientInitializationError: class PrismaClientInitializationError extends Error {},
}

export const SUBSCRIPTION_STATUS = {
  active: 'active',
  past_due: 'past_due',
  canceled: 'canceled',
  trialing: 'trialing',
  paused: 'paused',
} as const

export const BILLING_INTERVAL = {
  monthly: 'monthly',
  annual: 'annual',
} as const

export const INSTANCE_SIZE = {
  micro: 'micro',
  small: 'small',
  medium: 'medium',
  large: 'large',
  xlarge: 'xlarge',
} as const

export const PRICING_MODEL = {
  free: 'free',
  one_time: 'one_time',
  subscription: 'subscription',
} as const

export const INSTANCE_STATUS = {
  online: 'online',
  offline: 'offline',
} as const

export const INSTANCE_KIND = {
  desktop: 'desktop',
  cli_worker: 'cli_worker',
} as const

export const AFFILIATE_STATUS = {
  active: 'active',
  suspended: 'suspended',
  banned: 'banned',
} as const

export const COMMISSION_STATUS = {
  pending: 'pending',
  approved: 'approved',
  paid: 'paid',
  refunded: 'refunded',
  clawed_back: 'clawed_back',
  void: 'void',
} as const

export const PAYOUT_BATCH_STATUS = {
  pending: 'pending',
  sent: 'sent',
  paid: 'paid',
  failed: 'failed',
} as const

export const PAYOUT_STATUS = {
  not_setup: 'not_setup',
  pending_verification: 'pending_verification',
  verified: 'verified',
  requires_update: 'requires_update',
  disabled: 'disabled',
} as const

export interface PrismaMockOptions {
  prisma: any
  /** Override any of the named exports below if a test needs custom values. */
  Prisma?: any
  SubscriptionStatus?: typeof SUBSCRIPTION_STATUS | Record<string, string>
  BillingInterval?: typeof BILLING_INTERVAL | Record<string, string>
  InstanceSize?: typeof INSTANCE_SIZE | Record<string, string>
  PricingModel?: typeof PRICING_MODEL | Record<string, string>
  InstanceStatus?: typeof INSTANCE_STATUS | Record<string, string>
  InstanceKind?: typeof INSTANCE_KIND | Record<string, string>
  AffiliateStatus?: typeof AFFILIATE_STATUS | Record<string, string>
  CommissionStatus?: typeof COMMISSION_STATUS | Record<string, string>
  PayoutBatchStatus?: typeof PAYOUT_BATCH_STATUS | Record<string, string>
  PayoutStatus?: typeof PAYOUT_STATUS | Record<string, string>
}

/**
 * Returns a mock factory result shaped like `apps/api/src/lib/prisma.ts`
 * so `mock.module('../lib/prisma', () => withPrismaExports({ prisma }))`
 * works without consumers having to enumerate every Prisma re-export.
 */
export function withPrismaExports(opts: PrismaMockOptions) {
  return {
    prisma: opts.prisma,
    Prisma: opts.Prisma ?? PRISMA_NAMESPACE,
    SubscriptionStatus: opts.SubscriptionStatus ?? SUBSCRIPTION_STATUS,
    BillingInterval: opts.BillingInterval ?? BILLING_INTERVAL,
    InstanceSize: opts.InstanceSize ?? INSTANCE_SIZE,
    PricingModel: opts.PricingModel ?? PRICING_MODEL,
    InstanceStatus: opts.InstanceStatus ?? INSTANCE_STATUS,
    InstanceKind: opts.InstanceKind ?? INSTANCE_KIND,
    AffiliateStatus: opts.AffiliateStatus ?? AFFILIATE_STATUS,
    CommissionStatus: opts.CommissionStatus ?? COMMISSION_STATUS,
    PayoutBatchStatus: opts.PayoutBatchStatus ?? PAYOUT_BATCH_STATUS,
    PayoutStatus: opts.PayoutStatus ?? PAYOUT_STATUS,
  }
}
