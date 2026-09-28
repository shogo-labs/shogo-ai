// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { View, Text, Pressable } from 'react-native'
import { Check } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'

/**
 * Countries we can self-serve for Stripe Express Connect payout onboarding.
 * Mirrors `SUPPORTED_CONNECT_COUNTRIES` in
 * `apps/api/src/services/stripe-connect.service.ts` — keep in sync when
 * adding a country there.
 */
export const CONNECT_COUNTRY_OPTIONS = [
  { code: 'US', label: 'United States' },
  { code: 'CA', label: 'Canada' },
] as const

export type ConnectCountryCode = (typeof CONNECT_COUNTRY_OPTIONS)[number]['code']

interface ConnectCountryPickerProps {
  value: ConnectCountryCode
  onChange: (code: ConnectCountryCode) => void
  disabled?: boolean
}

/**
 * A small country picker for the Stripe Connect payout onboarding flows
 * (marketplace creator payout-setup + affiliate onboarding). Only shown
 * before a Connect account exists — a connected account's country is
 * immutable, so this has no effect once onboarding has already created one.
 */
export function ConnectCountryPicker({ value, onChange, disabled }: ConnectCountryPickerProps) {
  return (
    <View className="mb-5">
      <Text className="mb-2 text-[10px] font-semibold uppercase tracking-[1.2px] text-muted-foreground">
        Where are you paid from?
      </Text>
      <View className="flex-row gap-2">
        {CONNECT_COUNTRY_OPTIONS.map((opt) => {
          const selected = opt.code === value
          return (
            <Pressable
              key={opt.code}
              disabled={disabled}
              onPress={() => onChange(opt.code)}
              className={cn(
                'flex-1 flex-row items-center justify-center gap-1.5 rounded-xl border px-3 py-2.5',
                selected ? 'border-primary bg-primary/10' : 'border-border bg-card',
                disabled && 'opacity-60',
              )}
              accessibilityRole="button"
              accessibilityLabel={opt.label}
            >
              {selected && <Check size={14} color="#e27927" />}
              <Text
                className={cn(
                  'text-xs font-semibold',
                  selected ? 'text-primary' : 'text-foreground/80',
                )}
              >
                {opt.label}
              </Text>
            </Pressable>
          )
        })}
      </View>
      <Text className="mt-2 text-[11px] leading-4 text-muted-foreground">
        This can't be changed after you start onboarding with Stripe.
      </Text>
    </View>
  )
}
