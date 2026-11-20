// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * PlanComparison — the paid-workspace plan layout (SHO-451).
 *
 * A workspace that already pays does not need three big sales cards: it needs
 * to see where it is and what the other tiers cost. So the current plan is
 * marked "Current plan" and every other tier is one compact row with a single
 * action. The full sales layout (Solo Founder + the three cards) stays for Free
 * workspaces, where the job is to explain the product.
 */
import { View, Text } from 'react-native'
import { Check } from 'lucide-react-native'
import { Card, CardContent, Button, Badge, cn } from '@shogo/shared-ui/primitives'
import {
  PLAN_PRICING,
  formatUsd,
  getPlanDisplayName,
  getWindowLimitsForPlan,
} from '../../lib/billing-config'

const BASIC_WEEKLY_USD = getWindowLimitsForPlan('basic')?.weeklyUsd ?? 0

function usageLine(planId: string): string {
  const limits = getWindowLimitsForPlan(planId)
  if (!limits) return 'Unlimited usage — no rate windows'
  if (!BASIC_WEEKLY_USD || limits.weeklyUsd <= BASIC_WEEKLY_USD) {
    return 'Standard 5-hour & weekly usage windows'
  }
  const multiple = Number((limits.weeklyUsd / BASIC_WEEKLY_USD).toFixed(1))
  return `${multiple}× the usage of Basic`
}

function priceLine(planId: 'basic' | 'business', interval: 'monthly' | 'annual', seats: number): string {
  const pricing = PLAN_PRICING[planId]
  const unit = interval === 'annual' ? pricing.annual : pricing.monthly
  const quantity = pricing.perSeat ? Math.max(1, seats) : 1
  const suffix = interval === 'annual' ? '/yr' : '/mo'
  return `${formatUsd(unit * quantity)}${suffix}${pricing.perSeat && quantity > 1 ? ` · ${quantity} seats` : ''}`
}

function PlanRow({
  planId,
  isCurrent,
  interval,
  seats,
  isBusy,
  onSelect,
}: {
  planId: 'basic' | 'business'
  isCurrent: boolean
  interval: 'monthly' | 'annual'
  seats: number
  isBusy: boolean
  onSelect: () => void
}) {
  return (
    <View
      className={cn(
        'flex-row items-center justify-between gap-3 rounded-xl border p-3',
        isCurrent ? 'border-primary bg-primary/[0.04]' : 'border-border',
      )}
      testID={`plan-row-${planId}`}
    >
      <View className="flex-1 gap-0.5">
        <View className="flex-row items-center gap-2">
          <Text className="text-sm font-semibold text-foreground">
            {getPlanDisplayName(planId)}
          </Text>
          {isCurrent ? (
            <Badge variant="secondary" className="bg-primary/15">
              <Text className="text-[10px] font-semibold text-primary">Current plan</Text>
            </Badge>
          ) : null}
        </View>
        <Text className="text-xs text-muted-foreground">{usageLine(planId)}</Text>
        <Text className="text-sm font-medium text-foreground">
          {priceLine(planId, interval, seats)}
        </Text>
      </View>
      {isCurrent ? (
        <View className="flex-row items-center gap-1">
          <Check size={14} className="text-primary" />
          <Text className="text-xs font-medium text-primary">Active</Text>
        </View>
      ) : (
        <Button variant="outline" size="sm" onPress={onSelect} disabled={isBusy}>
          {planId === 'basic' ? 'Switch to Basic' : 'Switch to Business'}
        </Button>
      )}
    </View>
  )
}

export function PlanComparison({
  currentPlanId,
  billingInterval,
  seats,
  isIos,
  isBusy,
  onSelect,
  onContactSales,
}: {
  currentPlanId: string
  billingInterval: 'monthly' | 'annual'
  seats: number
  isIos: boolean
  isBusy?: boolean
  onSelect: (planId: 'basic' | 'business') => void
  onContactSales: () => void
}) {
  const current = (currentPlanId ?? '').toLowerCase().split('_')[0]
  return (
    <Card className="mb-4 rounded-2xl border-border shadow-none" testID="plan-comparison">
      <CardContent className="p-4 gap-3">
        <View>
          <Text className="text-sm font-medium text-foreground">Plans</Text>
          <Text className="text-xs text-muted-foreground">
            Changes apply immediately and are prorated — you see the price before you confirm.
          </Text>
        </View>
        <PlanRow
          planId="basic"
          isCurrent={current === 'basic'}
          interval={billingInterval}
          seats={1}
          isBusy={Boolean(isBusy)}
          onSelect={() => onSelect('basic')}
        />
        <PlanRow
          planId="business"
          isCurrent={current === 'business' || current === 'pro'}
          interval={billingInterval}
          seats={seats}
          isBusy={Boolean(isBusy)}
          onSelect={() => onSelect('business')}
        />
        {!isIos ? (
          <View className="flex-row items-center justify-between gap-3 rounded-xl border border-border p-3">
            <View className="flex-1 gap-0.5">
              <Text className="text-sm font-semibold text-foreground">Enterprise</Text>
              <Text className="text-xs text-muted-foreground">
                Custom seats, governance and support.
              </Text>
            </View>
            <Button variant="outline" size="sm" onPress={onContactSales}>
              Book a demo
            </Button>
          </View>
        ) : null}
      </CardContent>
    </Card>
  )
}
