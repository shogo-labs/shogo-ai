// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { View, Text, Pressable } from 'react-native'
import { Check } from 'lucide-react-native'

export type PricingModel = 'free' | 'one_time' | 'subscription'

interface PriceTagProps {
  pricingModel: PricingModel
  priceInCents?: number | null
  monthlyPriceInCents?: number | null
  /** Subscription billing interval to surface — defaults to monthly. */
  annualPriceInCents?: number | null
  /** Visual size — `sm` for card chips, `md` for the detail hero. */
  size?: 'sm' | 'md'
}

interface PricingCardsProps {
  pricingModel: PricingModel
  priceInCents?: number | null
  monthlyPriceInCents?: number | null
  annualPriceInCents?: number | null
  /** Called when a plan is chosen — triggers the install flow. */
  onSelect?: (interval: 'monthly' | 'annual' | 'one_time' | 'free') => void
  loading?: boolean
}

export function formatCents(cents: number): string {
  if (cents % 100 === 0) return `$${cents / 100}`
  return `$${(cents / 100).toFixed(2)}`
}

const BG: Record<PricingModel, string> = {
  free: 'bg-emerald-500/15',
  one_time: 'bg-blue-500/15',
  subscription: 'bg-purple-500/15',
}
const FG: Record<PricingModel, string> = {
  free: 'text-emerald-600 dark:text-emerald-400',
  one_time: 'text-blue-600 dark:text-blue-400',
  subscription: 'text-purple-600 dark:text-purple-400',
}

/**
 * Inline pricing pill — drop-in replacement for the old `PricingBadge`.
 * Used inside cards, list rows, and search results.
 */
export function PriceTag({
  pricingModel,
  priceInCents,
  monthlyPriceInCents,
  annualPriceInCents,
  size = 'sm',
}: PriceTagProps) {
  let label: string
  if (pricingModel === 'free') {
    label = 'Free'
  } else if (pricingModel === 'subscription') {
    if (monthlyPriceInCents) {
      label = `${formatCents(monthlyPriceInCents)}/mo`
    } else if (annualPriceInCents) {
      label = `${formatCents(annualPriceInCents)}/yr`
    } else {
      label = 'Subscribe'
    }
  } else if (priceInCents) {
    label = formatCents(priceInCents)
  } else {
    label = 'Free'
  }

  const padding = size === 'sm' ? 'px-2 py-0.5' : 'px-2.5 py-1'
  const text = size === 'sm' ? 'text-[11px]' : 'text-xs'

  return (
    <View className={`rounded-full ${BG[pricingModel]} ${padding}`}>
      <Text className={`font-semibold ${text} ${FG[pricingModel]}`}>{label}</Text>
    </View>
  )
}

interface PriceCardProps {
  title: string
  price: string
  /** Per-month effective price (for annual cards). */
  effective?: string
  /** Optional saving callout, e.g. "Save 20%". */
  savings?: string
  /** Bullets shown below the price. */
  features: string[]
  recommended?: boolean
  ctaLabel: string
  onPress?: () => void
  loading?: boolean
}

function PriceCard({
  title,
  price,
  effective,
  savings,
  features,
  recommended,
  ctaLabel,
  onPress,
  loading,
}: PriceCardProps) {
  return (
    <View
      className={`flex-1 rounded-2xl border p-5 gap-3 ${
        recommended
          ? 'border-primary/40 bg-primary/5'
          : 'border-border bg-card'
      }`}
    >
      <View className="flex-row items-center justify-between">
        <Text className="text-sm font-semibold text-foreground">{title}</Text>
        {savings && (
          <View className="rounded-full bg-emerald-500/15 px-2 py-0.5">
            <Text className="text-[10px] font-bold text-emerald-600 dark:text-emerald-400">
              {savings}
            </Text>
          </View>
        )}
      </View>

      <View className="flex-row items-baseline gap-1">
        <Text className="text-3xl font-bold text-foreground">{price}</Text>
      </View>
      {effective && (
        <Text className="text-xs text-muted-foreground -mt-2">{effective}</Text>
      )}

      <View className="gap-1.5 mt-1">
        {features.map((f) => (
          <View key={f} className="flex-row items-start gap-2">
            <Check size={13} color="#22c55e" style={{ marginTop: 2 }} />
            <Text className="text-xs text-foreground/80 flex-1 leading-4">{f}</Text>
          </View>
        ))}
      </View>

      <Pressable
        onPress={onPress}
        disabled={loading}
        className={`mt-2 rounded-xl py-2.5 items-center justify-center ${
          recommended ? 'bg-primary' : 'bg-foreground/10'
        } ${loading ? 'opacity-60' : ''}`}
      >
        <Text
          className={`text-sm font-semibold ${
            recommended ? 'text-primary-foreground' : 'text-foreground'
          }`}
        >
          {ctaLabel}
        </Text>
      </Pressable>
    </View>
  )
}

/**
 * Shopify-style pricing tier cards. Renders side-by-side monthly + annual
 * cards when both prices exist, a single full-width card for free /
 * one-time, and falls back gracefully when subscription has only one
 * billing interval.
 */
export function PricingCards({
  pricingModel,
  priceInCents,
  monthlyPriceInCents,
  annualPriceInCents,
  onSelect,
  loading,
}: PricingCardsProps) {
  if (pricingModel === 'free') {
    return (
      <PriceCard
        title="Free"
        price="$0"
        features={[
          'Unlimited use after install',
          'Cancel any time, no card required',
          'Receives updates from the creator',
        ]}
        recommended
        ctaLabel="Install free"
        onPress={() => onSelect?.('free')}
        loading={loading}
      />
    )
  }

  if (pricingModel === 'one_time') {
    const price = priceInCents ? formatCents(priceInCents) : '—'
    return (
      <PriceCard
        title="One-time purchase"
        price={price}
        features={[
          'Lifetime access — pay once',
          'Includes future updates',
          'Receipted via Stripe',
        ]}
        recommended
        ctaLabel={`Buy ${price}`}
        onPress={() => onSelect?.('one_time')}
        loading={loading}
      />
    )
  }

  // Subscription
  const hasMonthly = !!monthlyPriceInCents
  const hasAnnual = !!annualPriceInCents
  if (!hasMonthly && !hasAnnual) {
    return (
      <PriceCard
        title="Subscription"
        price="—"
        features={['Pricing not yet set']}
        ctaLabel="Subscribe"
        loading={loading}
      />
    )
  }

  const annualEffective =
    hasAnnual && annualPriceInCents
      ? `${formatCents(Math.round(annualPriceInCents / 12))}/mo billed yearly`
      : undefined
  const savings = hasMonthly && hasAnnual && monthlyPriceInCents && annualPriceInCents
    ? Math.round((1 - annualPriceInCents / (monthlyPriceInCents * 12)) * 100)
    : 0

  if (hasMonthly && hasAnnual) {
    return (
      <View className="flex-row gap-3">
        <PriceCard
          title="Monthly"
          price={`${formatCents(monthlyPriceInCents!)}/mo`}
          features={['Cancel any time', 'Includes future updates']}
          ctaLabel={`Subscribe ${formatCents(monthlyPriceInCents!)}/mo`}
          onPress={() => onSelect?.('monthly')}
          loading={loading}
        />
        <PriceCard
          title="Annual"
          price={`${formatCents(annualPriceInCents!)}/yr`}
          effective={annualEffective}
          savings={savings > 0 ? `Save ${savings}%` : undefined}
          features={['Best value', 'Cancel any time', 'Includes future updates']}
          recommended
          ctaLabel={`Subscribe ${formatCents(annualPriceInCents!)}/yr`}
          onPress={() => onSelect?.('annual')}
          loading={loading}
        />
      </View>
    )
  }

  // Only one of monthly / annual exists.
  if (hasMonthly) {
    return (
      <PriceCard
        title="Subscription"
        price={`${formatCents(monthlyPriceInCents!)}/mo`}
        features={['Cancel any time', 'Includes future updates']}
        recommended
        ctaLabel={`Subscribe ${formatCents(monthlyPriceInCents!)}/mo`}
        onPress={() => onSelect?.('monthly')}
        loading={loading}
      />
    )
  }
  return (
    <PriceCard
      title="Annual"
      price={`${formatCents(annualPriceInCents!)}/yr`}
      effective={annualEffective}
      features={['Cancel any time', 'Includes future updates']}
      recommended
      ctaLabel={`Subscribe ${formatCents(annualPriceInCents!)}/yr`}
      onPress={() => onSelect?.('annual')}
      loading={loading}
    />
  )
}

/**
 * Returns the install/subscribe CTA label used across the hero, sticky
 * bottom bar, and pricing card. Centralized so the wording stays
 * consistent everywhere.
 */
export function installCtaLabel(
  pricingModel: PricingModel,
  priceInCents?: number | null,
  monthlyPriceInCents?: number | null,
  annualPriceInCents?: number | null,
): string {
  if (pricingModel === 'free') return 'Use this agent'
  if (pricingModel === 'subscription') {
    if (monthlyPriceInCents) return `Subscribe · ${formatCents(monthlyPriceInCents)}/mo`
    if (annualPriceInCents) return `Subscribe · ${formatCents(annualPriceInCents)}/yr`
    return 'Subscribe'
  }
  if (priceInCents) return `Buy · ${formatCents(priceInCents)}`
  return 'Get this agent'
}
