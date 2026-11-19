// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * BillingSummaryCard — the first thing the billing page answers (SHO-451):
 * what plan am I on, what will I pay next, and which card pays it.
 *
 * Everything here comes from `GET /api/billing/summary`; the price line is
 * derived from the plan + seats + interval we already sell, so it matches the
 * plan cards below. A grant-conferred plan has no Stripe customer, so it shows
 * the plan and period but no card and no Manage button.
 */
import { View, Text } from 'react-native'
import { CreditCard, CalendarClock, Users, Receipt } from 'lucide-react-native'
import { Card, CardContent, Button, Badge, cn } from '@shogo/shared-ui/primitives'
import type { BillingSummary } from '@shogo/shared-app/hooks'
import { PLAN_PRICING, formatUsd, getPlanDisplayName } from '../../lib/billing-config'

function formatDate(iso: string | null | undefined): string {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

function brandLabel(brand: string): string {
  const known: Record<string, string> = {
    visa: 'Visa',
    mastercard: 'Mastercard',
    amex: 'Amex',
    discover: 'Discover',
    diners: 'Diners',
    jcb: 'JCB',
    unionpay: 'UnionPay',
  }
  return known[brand.toLowerCase()] ?? brand.charAt(0).toUpperCase() + brand.slice(1)
}

/** Recurring price for the plan the summary reports, in USD. */
export function summaryPriceUsd(summary: BillingSummary): number | null {
  const base = summary.planId.split('_')[0] as 'basic' | 'pro' | 'business'
  const pricing = PLAN_PRICING[base]
  if (!pricing) return null
  const seats = pricing.perSeat ? Math.max(1, summary.seats) : 1
  const unit = summary.billingInterval === 'annual' ? pricing.annual : pricing.monthly
  return unit * seats
}

function SummaryRow({
  icon,
  label,
  value,
  testID,
}: {
  icon: React.ReactNode
  label: string
  value: string
  testID?: string
}) {
  return (
    <View className="flex-row items-center justify-between gap-3 py-1.5" testID={testID}>
      <View className="flex-row items-center gap-2">
        {icon}
        <Text className="text-sm text-muted-foreground">{label}</Text>
      </View>
      <Text className="flex-1 text-right text-sm font-medium text-foreground">{value}</Text>
    </View>
  )
}

export function BillingSummaryCard({
  summary,
  workspaceName,
  isIos,
  isPortalLoading,
  isRestoreLoading,
  onManage,
  onChangePlan,
  onRestore,
}: {
  summary: BillingSummary | null
  workspaceName?: string
  isIos: boolean
  isPortalLoading?: boolean
  isRestoreLoading?: boolean
  onManage: () => void
  onChangePlan: () => void
  onRestore: () => void
}) {
  const planId = summary?.planId ?? 'free'
  const planName = `${getPlanDisplayName(planId)} Plan`
  const isSubscription = summary?.planSource === 'subscription'
  const priceUsd = summary ? summaryPriceUsd(summary) : null
  const intervalLabel = summary?.billingInterval === 'annual' ? 'per year' : 'per month'
  const seats = Math.max(1, summary?.seats ?? 1)
  const perSeat = planId.split('_')[0] === 'business' && seats > 1

  const renewalLabel = summary?.cancelAtPeriodEnd
    ? `Ends on ${formatDate(summary.currentPeriodEnd)}`
    : summary?.trialEndsAt
      ? `Trial ends ${formatDate(summary.trialEndsAt)}`
      : summary?.currentPeriodEnd
        ? `Renews ${formatDate(summary.currentPeriodEnd)}`
        : 'No renewal scheduled'

  const nextInvoice = summary?.nextInvoice
  const card = summary?.paymentMethod

  return (
    <Card className="mb-4 rounded-2xl border-border shadow-none" testID="billing-summary">
      <CardContent className="p-4 gap-3">
        <View className="flex-row items-center justify-between gap-3">
          <View className="flex-row items-center gap-3 flex-1">
            <View className="h-10 w-10 rounded-full bg-primary/10 items-center justify-center">
              <Text className="text-lg font-semibold text-primary">
                {workspaceName?.[0]?.toUpperCase() || 'W'}
              </Text>
            </View>
            <View className="flex-1">
              <Text className="text-sm font-medium text-foreground">You're on {planName}</Text>
              <Text className="text-xs text-muted-foreground">
                {planId.startsWith('pro')
                  ? 'Pro is no longer sold. You move to Business at your next renewal.'
                  : summary?.planSource === 'grant'
                    ? 'Granted by a license key'
                    : summary?.status === 'trialing'
                      ? 'Free trial'
                      : summary?.status === 'past_due'
                        ? 'Payment failed'
                        : 'Upgrade anytime'}
              </Text>
            </View>
          </View>
          {summary?.status ? (
            <Badge
              variant="secondary"
              className={cn(
                summary.status === 'past_due' && 'bg-destructive/15',
                summary.status === 'trialing' && 'bg-amber-500/15',
              )}
            >
              <Text className="text-[11px] font-medium text-foreground">
                {summary.status === 'past_due' ? 'Past due' : summary.status}
              </Text>
            </Badge>
          ) : null}
        </View>

        <View className="border-t border-border pt-2">
          <SummaryRow
            icon={<Users size={14} className="text-muted-foreground" />}
            label="Seats"
            value={String(seats)}
            testID="billing-summary-seats"
          />
          {priceUsd != null ? (
            <SummaryRow
              icon={<Receipt size={14} className="text-muted-foreground" />}
              label="Price"
              value={`${formatUsd(priceUsd)} ${intervalLabel}${perSeat ? ` · ${seats} seats` : ''}`}
              testID="billing-summary-price"
            />
          ) : null}
          <SummaryRow
            icon={<CalendarClock size={14} className="text-muted-foreground" />}
            label={summary?.cancelAtPeriodEnd ? 'Access ends' : 'Renewal'}
            value={renewalLabel}
            testID="billing-summary-renewal"
          />
          {nextInvoice ? (
            <SummaryRow
              icon={<Receipt size={14} className="text-muted-foreground" />}
              label="Next invoice"
              value={`${formatUsd(nextInvoice.amountUsd)}${
                nextInvoice.date ? ` on ${formatDate(nextInvoice.date)}` : ''
              }`}
              testID="billing-summary-next-invoice"
            />
          ) : null}
          {card ? (
            <SummaryRow
              icon={<CreditCard size={14} className="text-muted-foreground" />}
              label="Card on file"
              value={`${brandLabel(card.brand)} ••${card.last4}`}
              testID="billing-summary-card"
            />
          ) : null}
        </View>

        <View className="flex-row items-center gap-2">
          {!isIos && isSubscription ? (
            <Button variant="outline" size="sm" onPress={onChangePlan} testID="billing-change-plan">
              Change plan
            </Button>
          ) : null}
          {!isIos && isSubscription ? (
            <Button variant="outline" size="sm" onPress={onManage} disabled={isPortalLoading}>
              {isPortalLoading ? 'Loading...' : 'Manage'}
            </Button>
          ) : null}
          {isIos ? (
            <Button variant="outline" size="sm" onPress={onRestore} disabled={isRestoreLoading}>
              {isRestoreLoading ? 'Restoring...' : 'Restore Purchases'}
            </Button>
          ) : null}
        </View>
      </CardContent>
    </Card>
  )
}
