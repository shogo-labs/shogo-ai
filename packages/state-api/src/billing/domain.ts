/**
 * Billing Domain Store
 *
 * Uses the domain() composition API to define Subscription, CreditLedger,
 * and UsageEvent entities with enhancement hooks for computed views,
 * collection queries, and domain actions.
 *
 * Credit rules:
 * - Free tier: 5 daily credits only (no monthly, no rollover)
 * - Pro/Business: $25/$50 per month, 100 monthly + 5 daily credits
 * - Daily credits reset at midnight UTC (lazy calculation)
 * - Deduction order: daily first, then monthly, then rollover
 * - Unused monthly credits roll over (active subscriptions only)
 * - Free tier ledger is auto-created on first credit consumption
 */

import { scope } from "arktype"
import { domain } from "../domain"

// ============================================================
// 1. DOMAIN SCHEMA (ArkType)
// ============================================================

export const BillingDomain = scope({
  Subscription: {
    id: "string.uuid",
    workspace: "string", // Cross-schema loose string reference to Workspace
    stripeSubscriptionId: "string",
    stripeCustomerId: "string",
    planId: "'pro' | 'business' | 'enterprise'",
    status: "'active' | 'past_due' | 'canceled' | 'trialing' | 'paused'",
    billingInterval: "'monthly' | 'annual'",
    currentPeriodStart: "number",
    currentPeriodEnd: "number",
    "cancelAtPeriodEnd?": "boolean",
    createdAt: "number",
    "updatedAt?": "number",
  },

  CreditLedger: {
    id: "string.uuid",
    workspace: "string", // Cross-schema loose string reference to Workspace
    monthlyCredits: "number",
    dailyCredits: "number",
    rolloverCredits: "number",
    anniversaryDay: "number", // Day of month (1-31) for monthly reset
    lastDailyReset: "number", // Timestamp for lazy daily reset
    lastMonthlyReset: "number", // Timestamp for monthly reset
    createdAt: "number",
    "updatedAt?": "number",
  },

  UsageEvent: {
    id: "string.uuid",
    workspace: "string", // Cross-schema loose string reference to Workspace
    "projectId?": "string", // Optional project attribution (loose string)
    memberId: "string", // Who performed the action (loose string)
    actionType: "string", // e.g., 'chat_message', 'code_generation'
    "actionMetadata?": "unknown", // Additional context
    creditCost: "number",
    creditSource: "'daily' | 'monthly'",
    balanceBefore: "number",
    balanceAfter: "number",
    createdAt: "number",
  },
})

// ============================================================
// 2. HELPER FUNCTIONS
// ============================================================

/**
 * Get the start of the current UTC day as a timestamp
 */
function getStartOfUTCDay(timestamp: number = Date.now()): number {
  const date = new Date(timestamp)
  date.setUTCHours(0, 0, 0, 0)
  return date.getTime()
}

/**
 * Check if two timestamps are on different UTC days
 */
function isDifferentUTCDay(ts1: number, ts2: number): boolean {
  return getStartOfUTCDay(ts1) !== getStartOfUTCDay(ts2)
}

// ============================================================
// 3. DOMAIN DEFINITION WITH ENHANCEMENTS
// ============================================================

/**
 * Billing domain with all enhancements.
 * Registered in enhancement registry for meta-store integration.
 */
export const billingDomain = domain({
  name: "billing",
  from: BillingDomain,
  enhancements: {
    // --------------------------------------------------------
    // models: Add computed views to individual entities
    // --------------------------------------------------------
    models: (models) => ({
      ...models,

      // Subscription.isActive - check if subscription is active
      Subscription: models.Subscription.views((self: any) => ({
        /**
         * Check if subscription is currently active
         */
        get isActive(): boolean {
          return self.status === "active" || self.status === "trialing"
        },

        /**
         * Days remaining in current billing period
         */
        get daysRemaining(): number {
          const now = Date.now()
          const end = self.currentPeriodEnd
          const diff = end - now
          return Math.max(0, Math.ceil(diff / (24 * 60 * 60 * 1000)))
        },
      })),

      // CreditLedger computed views
      CreditLedger: models.CreditLedger.views((self: any) => ({
        /**
         * Calculate effective balance with lazy daily reset
         * If lastDailyReset is not today, return 5 daily credits
         * This does NOT mutate the entity - just returns calculated balance
         */
        get effectiveBalance(): { dailyCredits: number; monthlyCredits: number; rolloverCredits: number; total: number } {
          const now = Date.now()
          const needsReset = isDifferentUTCDay(self.lastDailyReset, now)

          const dailyCredits = needsReset ? 5 : self.dailyCredits
          const monthlyCredits = self.monthlyCredits
          const rolloverCredits = self.rolloverCredits

          return {
            dailyCredits,
            monthlyCredits,
            rolloverCredits,
            total: dailyCredits + monthlyCredits + rolloverCredits,
          }
        },

        /**
         * Check if any credits are available
         */
        get hasCredits(): boolean {
          const balance = (self as any).effectiveBalance
          return balance.total > 0
        },
      })),
    }),

    // --------------------------------------------------------
    // collections: Add query methods
    // --------------------------------------------------------
    collections: (collections) => ({
      ...collections,

      SubscriptionCollection: collections.SubscriptionCollection.views((self: any) => ({
        /**
         * Find subscriptions for a workspace
         */
        findByWorkspace(workspaceId: string): any[] {
          return self.all().filter((s: any) => s.workspace === workspaceId)
        },
      })),

      CreditLedgerCollection: collections.CreditLedgerCollection.views((self: any) => ({
        /**
         * Find credit ledger for a workspace
         */
        findByWorkspace(workspaceId: string): any | null {
          return self.all().find((l: any) => l.workspace === workspaceId) || null
        },
      })),

      UsageEventCollection: collections.UsageEventCollection.views((self: any) => ({
        /**
         * Find usage events for a workspace
         */
        recentForWorkspace(workspaceId: string, limit: number = 50): any[] {
          return self
            .all()
            .filter((e: any) => e.workspace === workspaceId)
            .sort((a: any, b: any) => b.createdAt - a.createdAt)
            .slice(0, limit)
        },

        /**
         * Find usage events for a project
         */
        findByProject(projectId: string): any[] {
          return self.all().filter((e: any) => e.projectId === projectId)
        },

        /**
         * Find usage events for a member
         */
        findByMember(memberId: string): any[] {
          return self.all().filter((e: any) => e.memberId === memberId)
        },
      })),
    }),

    // --------------------------------------------------------
    // rootStore: Add domain actions
    // --------------------------------------------------------
    rootStore: (RootModel) =>
      RootModel.actions((self: any) => ({
        /**
         * Allocate monthly credits for a new subscription or reset.
         * Creates CreditLedger if doesn't exist.
         *
         * @param workspaceId - The workspace to allocate credits to
         */
        async allocateMonthlyCredits(workspaceId: string): Promise<void> {
          const now = Date.now()
          const today = new Date(now)

          // Check if ledger exists
          const existingLedger = self.creditLedgerCollection.findByWorkspace(workspaceId)

          if (existingLedger) {
            // Update existing ledger
            const newMonthly = 100
            const rollover = existingLedger.monthlyCredits // Unused becomes rollover

            // Only rollover if there's an active subscription
            const subscription = self.subscriptionCollection.findByWorkspace(workspaceId)[0]
            const shouldRollover = subscription?.isActive ?? false

            existingLedger.monthlyCredits = newMonthly
            existingLedger.rolloverCredits = shouldRollover
              ? existingLedger.rolloverCredits + rollover
              : 0
            existingLedger.dailyCredits = 5
            existingLedger.lastMonthlyReset = now
            existingLedger.updatedAt = now
          } else {
            // Create new ledger
            self.creditLedgerCollection.add({
              id: crypto.randomUUID(),
              workspace: workspaceId,
              monthlyCredits: 100,
              dailyCredits: 5,
              rolloverCredits: 0,
              anniversaryDay: today.getUTCDate(),
              lastDailyReset: now,
              lastMonthlyReset: now,
              createdAt: now,
            })
          }
        },

        /**
         * Allocate free tier credits for a workspace.
         * Creates a CreditLedger with 5 daily credits and 0 monthly credits.
         * Used for workspaces without a paid subscription.
         *
         * @param workspaceId - The workspace to allocate free credits to
         * @returns The created or existing ledger
         */
        async allocateFreeCredits(workspaceId: string): Promise<any> {
          const now = Date.now()
          const today = new Date(now)

          // Check if ledger exists
          const existingLedger = self.creditLedgerCollection.findByWorkspace(workspaceId)

          if (existingLedger) {
            // Ledger exists - just reset daily credits if needed via updateOne
            if (isDifferentUTCDay(existingLedger.lastDailyReset, now)) {
              await self.creditLedgerCollection.updateOne(existingLedger.id, {
                dailyCredits: 5,
                lastDailyReset: now,
                updatedAt: now,
              })
            }
            return self.creditLedgerCollection.findByWorkspace(workspaceId)
          }

          // Create new free tier ledger
          const ledgerId = crypto.randomUUID()
          await self.creditLedgerCollection.insertOne({
            id: ledgerId,
            workspace: workspaceId,
            monthlyCredits: 0, // Free tier gets no monthly credits
            dailyCredits: 5,   // Free tier gets 5 daily credits
            rolloverCredits: 0,
            anniversaryDay: today.getUTCDate(),
            lastDailyReset: now,
            lastMonthlyReset: now,
            createdAt: now,
          })
          return self.creditLedgerCollection.get(ledgerId)
        },

        /**
         * Consume credits for an action.
         * Deducts from daily first, then monthly, then rollover.
         * Creates UsageEvent records for tracking.
         * Auto-creates a free tier ledger if none exists.
         *
         * @param workspaceId - The workspace consuming credits
         * @param amount - Credits to consume
         * @param memberId - Who is consuming
         * @param actionType - What action is consuming credits
         * @param projectId - Optional project attribution
         * @param actionMetadata - Optional additional context
         */
        async consumeCredits(
          workspaceId: string,
          amount: number,
          memberId: string,
          actionType: string,
          projectId?: string,
          actionMetadata?: unknown
        ): Promise<void> {
          let ledger = self.creditLedgerCollection.findByWorkspace(workspaceId)

          // Auto-create free tier ledger if none exists
          if (!ledger) {
            await self.allocateFreeCredits(workspaceId)
            ledger = self.creditLedgerCollection.findByWorkspace(workspaceId)
          }

          if (!ledger) {
            throw new Error(`Failed to create or find credit ledger for workspace ${workspaceId}`)
          }

          const now = Date.now()
          let remaining = amount

          // Get current credit values (may need daily reset)
          let dailyCredits = ledger.dailyCredits
          let monthlyCredits = ledger.monthlyCredits
          let rolloverCredits = ledger.rolloverCredits
          let lastDailyReset = ledger.lastDailyReset

          // Check if daily reset is needed (lazy reset)
          if (isDifferentUTCDay(lastDailyReset, now)) {
            dailyCredits = 5
            lastDailyReset = now
          }

          // Deduct from daily credits first
          if (remaining > 0 && dailyCredits > 0) {
            const fromDaily = Math.min(remaining, dailyCredits)
            const balanceBefore = dailyCredits
            dailyCredits -= fromDaily
            remaining -= fromDaily

            // Create usage event for daily deduction
            await self.usageEventCollection.insertOne({
              id: crypto.randomUUID(),
              workspace: workspaceId,
              projectId,
              memberId,
              actionType,
              actionMetadata,
              creditCost: fromDaily,
              creditSource: "daily",
              balanceBefore,
              balanceAfter: dailyCredits,
              createdAt: now,
            })
          }

          // Deduct from monthly credits if needed
          if (remaining > 0 && monthlyCredits > 0) {
            const fromMonthly = Math.min(remaining, monthlyCredits)
            const balanceBefore = monthlyCredits
            monthlyCredits -= fromMonthly
            remaining -= fromMonthly

            // Create usage event for monthly deduction
            await self.usageEventCollection.insertOne({
              id: crypto.randomUUID(),
              workspace: workspaceId,
              projectId,
              memberId,
              actionType,
              actionMetadata,
              creditCost: fromMonthly,
              creditSource: "monthly",
              balanceBefore,
              balanceAfter: monthlyCredits,
              createdAt: now,
            })
          }

          // Deduct from rollover if still remaining
          if (remaining > 0 && rolloverCredits > 0) {
            const fromRollover = Math.min(remaining, rolloverCredits)
            const balanceBefore = rolloverCredits
            rolloverCredits -= fromRollover
            remaining -= fromRollover

            // Create usage event for rollover deduction
            await self.usageEventCollection.insertOne({
              id: crypto.randomUUID(),
              workspace: workspaceId,
              projectId,
              memberId,
              actionType,
              actionMetadata,
              creditCost: fromRollover,
              creditSource: "monthly", // Rollover counts as monthly
              balanceBefore,
              balanceAfter: rolloverCredits,
              createdAt: now,
            })
          }

          if (remaining > 0) {
            throw new Error(
              `Insufficient credits: needed ${amount}, only had ${amount - remaining}`
            )
          }

          // Update ledger via collection's updateOne method (proper MST action handling)
          await self.creditLedgerCollection.updateOne(ledger.id, {
            dailyCredits,
            monthlyCredits,
            rolloverCredits,
            lastDailyReset,
            updatedAt: now,
          })
        },

        /**
         * Sync subscription data from Stripe webhook.
         * Creates or updates Subscription entity.
         * Triggers credit allocation for new subscriptions.
         *
         * @param data - Webhook subscription data
         */
        async syncFromStripe(data: {
          subscriptionId: string
          workspaceId: string
          customerId: string
          planId: string
          status: string
          billingInterval: string
          currentPeriodStart: number
          currentPeriodEnd: number
          cancelAtPeriodEnd?: boolean
          isNew?: boolean
        }): Promise<void> {
          const now = Date.now()

          // Find existing subscription
          const existing = self.subscriptionCollection
            .all()
            .find((s: any) => s.stripeSubscriptionId === data.subscriptionId)

          if (existing) {
            // Update existing subscription
            existing.planId = data.planId
            existing.status = data.status
            existing.billingInterval = data.billingInterval
            existing.currentPeriodStart = data.currentPeriodStart
            existing.currentPeriodEnd = data.currentPeriodEnd
            existing.cancelAtPeriodEnd = data.cancelAtPeriodEnd
            existing.updatedAt = now
          } else {
            // Create new subscription
            self.subscriptionCollection.add({
              id: crypto.randomUUID(),
              workspace: data.workspaceId,
              stripeSubscriptionId: data.subscriptionId,
              stripeCustomerId: data.customerId,
              planId: data.planId,
              status: data.status,
              billingInterval: data.billingInterval,
              currentPeriodStart: data.currentPeriodStart,
              currentPeriodEnd: data.currentPeriodEnd,
              cancelAtPeriodEnd: data.cancelAtPeriodEnd,
              createdAt: now,
            })

            // Allocate credits for new subscription
            if (data.isNew || data.status === "active") {
              await self.allocateMonthlyCredits(data.workspaceId)
            }
          }
        },

        /**
         * Initialize billing store - called on app startup
         */
        async initialize(): Promise<void> {
          // Load all collections from persistence
          await self.subscriptionCollection.loadAll?.()
          await self.creditLedgerCollection.loadAll?.()
          await self.usageEventCollection.loadAll?.()
        },
      })),
  },
})

// BillingDomain scope and billingDomain result are exported above
