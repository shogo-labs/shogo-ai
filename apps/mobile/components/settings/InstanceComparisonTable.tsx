// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { View, Text, Pressable, useWindowDimensions } from 'react-native'
import { CheckCircle2 } from 'lucide-react-native'
import {
  INSTANCE_SIZES,
  getDisplayPrice,
  type InstanceSizeName,
} from '../../lib/instance-config'
import {
  Card,
  CardContent,
  Badge,
  cn,
} from '@shogo/shared-ui/primitives'

interface InstanceComparisonTableProps {
  currentSize: InstanceSizeName
  billingInterval: 'monthly' | 'annual'
  onSelectSize: (size: InstanceSizeName) => void
  isCheckoutLoading: boolean
}

const WIDE_BREAKPOINT = 640

export function InstanceComparisonTable({
  currentSize,
  billingInterval,
  onSelectSize,
  isCheckoutLoading,
}: InstanceComparisonTableProps) {
  const { width } = useWindowDimensions()
  const isWide = width >= WIDE_BREAKPOINT

  if (isWide) {
    return <WideTable currentSize={currentSize} billingInterval={billingInterval} onSelectSize={onSelectSize} isCheckoutLoading={isCheckoutLoading} />
  }
  return <NarrowCards currentSize={currentSize} billingInterval={billingInterval} onSelectSize={onSelectSize} isCheckoutLoading={isCheckoutLoading} />
}

function WideTable({ currentSize, billingInterval, onSelectSize, isCheckoutLoading }: InstanceComparisonTableProps) {
  const currentIdx = INSTANCE_SIZES.findIndex((t) => t.name === currentSize)

  return (
    <Card>
      <CardContent className="p-0">
        {/* Header */}
        <View className="flex-row border-b border-border px-4 py-3">
          <Text className="flex-[2] text-xs font-medium text-muted-foreground uppercase tracking-wide">Size</Text>
          <Text className="flex-1 text-xs font-medium text-muted-foreground uppercase tracking-wide">CPU</Text>
          <Text className="flex-1 text-xs font-medium text-muted-foreground uppercase tracking-wide">Memory</Text>
          <Text className="flex-1 text-xs font-medium text-muted-foreground uppercase tracking-wide">Storage</Text>
          <Text className="flex-1 text-xs font-medium text-muted-foreground uppercase tracking-wide text-right">Price</Text>
          <View className="flex-1" />
        </View>

        {/* Rows */}
        {INSTANCE_SIZES.map((tier, idx) => {
          const isCurrent = tier.name === currentSize
          const isUpgrade = idx > currentIdx
          const isDowngrade = idx < currentIdx
          const price = getDisplayPrice(tier, billingInterval)

          return (
            <View
              key={tier.name}
              className={cn(
                'flex-row items-center px-4 py-3 border-b border-border',
                isCurrent && 'bg-primary/5',
              )}
            >
              <View className="flex-[2] flex-row items-center gap-2">
                <Text className={cn('text-sm font-medium', isCurrent ? 'text-primary' : 'text-foreground')}>
                  {tier.label}
                </Text>
                {isCurrent && (
                  <Badge variant="default" className="px-1.5 py-0.5">
                    <Text className="text-[10px] text-primary-foreground">Current</Text>
                  </Badge>
                )}
                {tier.dedicated && !isCurrent && (
                  <Badge variant="outline" className="px-1.5 py-0.5">
                    <Text className="text-[10px] text-muted-foreground">Dedicated</Text>
                  </Badge>
                )}
              </View>
              <Text className="flex-1 text-sm text-foreground">{tier.cpuLabel}</Text>
              <Text className="flex-1 text-sm text-foreground">{tier.memoryLabel}</Text>
              <Text className="flex-1 text-sm text-foreground">{tier.storageLabel}</Text>
              <Text className="flex-1 text-sm font-medium text-foreground text-right">
                {price === 0 ? 'Free' : `$${price}${billingInterval === 'monthly' ? '/mo' : '/yr'}`}
              </Text>
              <View className="flex-1 items-end">
                {isCurrent ? (
                  <CheckCircle2 size={16} className="text-primary" />
                ) : tier.name !== 'micro' ? (
                  <Pressable
                    onPress={() => onSelectSize(tier.name)}
                    disabled={isCheckoutLoading}
                    className={cn(
                      'px-3 py-1.5 rounded-md',
                      isUpgrade ? 'bg-primary' : 'bg-muted',
                    )}
                  >
                    <Text className={cn(
                      'text-xs font-medium',
                      isUpgrade ? 'text-primary-foreground' : 'text-foreground',
                    )}>
                      {isUpgrade ? 'Upgrade' : 'Downgrade'}
                    </Text>
                  </Pressable>
                ) : null}
              </View>
            </View>
          )
        })}
      </CardContent>
    </Card>
  )
}

function NarrowCards({ currentSize, billingInterval, onSelectSize, isCheckoutLoading }: InstanceComparisonTableProps) {
  const currentIdx = INSTANCE_SIZES.findIndex((t) => t.name === currentSize)

  return (
    <View className="gap-3">
      {INSTANCE_SIZES.map((tier, idx) => {
        const isCurrent = tier.name === currentSize
        const isUpgrade = idx > currentIdx
        const price = getDisplayPrice(tier, billingInterval)

        return (
          <Card key={tier.name} className={cn(isCurrent && 'border-primary')}>
            <CardContent className="p-4 gap-2">
              <View className="flex-row items-center justify-between">
                <View className="flex-row items-center gap-2">
                  <Text className={cn('text-base font-semibold', isCurrent ? 'text-primary' : 'text-foreground')}>
                    {tier.label}
                  </Text>
                  {isCurrent && (
                    <Badge variant="default">
                      <Text className="text-xs text-primary-foreground">Current</Text>
                    </Badge>
                  )}
                  {tier.dedicated && !isCurrent && (
                    <Badge variant="outline">
                      <Text className="text-xs text-muted-foreground">Dedicated</Text>
                    </Badge>
                  )}
                </View>
                <Text className="text-base font-bold text-foreground">
                  {price === 0 ? 'Free' : `$${price}${billingInterval === 'monthly' ? '/mo' : '/yr'}`}
                </Text>
              </View>

              <Text className="text-sm text-muted-foreground">
                {tier.cpuLabel} &middot; {tier.memoryLabel} &middot; {tier.storageLabel} storage
              </Text>

              {!isCurrent && tier.name !== 'micro' && (
                <Pressable
                  onPress={() => onSelectSize(tier.name)}
                  disabled={isCheckoutLoading}
                  className={cn(
                    'w-full items-center justify-center py-2.5 rounded-md mt-1',
                    isUpgrade ? 'bg-primary' : 'bg-muted',
                  )}
                >
                  <Text className={cn(
                    'text-sm font-medium',
                    isUpgrade ? 'text-primary-foreground' : 'text-foreground',
                  )}>
                    {isUpgrade ? 'Upgrade' : 'Downgrade'}
                  </Text>
                </Pressable>
              )}
            </CardContent>
          </Card>
        )
      })}
    </View>
  )
}
