// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useEffect, useState } from 'react'
import { Image, Platform, Text, useWindowDimensions, View } from 'react-native'
import { Sparkles } from 'lucide-react-native'
import { Skeleton } from '@shogo/shared-ui/primitives'
import { API_URL } from '../../../lib/api'
import { safeGetItem } from '../../../lib/safe-storage'
import { SelectableCard } from '../SelectableCard'

/**
 * Slimmed-down marketplace listing for the onboarding picker. Uses
 * `/api/marketplace/featured` so onboarding and the home rail show the same
 * first-party agents. `pending_template_id` is the legacy storage key for a
 * marketing-site deep link; its value is a listing slug.
 */
export interface OnboardingListing {
  slug: string
  title: string
  shortDescription: string
  iconUrl?: string | null
}

interface AgentPickerStepProps {
  selected: OnboardingListing | null
  onSelect: (listing: OnboardingListing | null) => void
}

const LISTING_LIMIT = 6
const PHONE_BREAKPOINT = 640

function ListingIcon({ iconUrl }: { iconUrl?: string | null }) {
  return (
    <View className="h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-primary/10">
      {iconUrl ? (
        <Image source={{ uri: iconUrl }} style={{ width: 44, height: 44 }} accessibilityIgnoresInvertColors />
      ) : (
        <Sparkles size={20} className="text-primary" />
      )}
    </View>
  )
}

export function AgentPickerStep({ selected, onSelect }: AgentPickerStepProps) {
  const [listings, setListings] = useState<OnboardingListing[] | null>(null)
  const { width } = useWindowDimensions()
  const columns = width < PHONE_BREAKPOINT ? 1 : 2

  useEffect(() => {
    let cancelled = false
    fetch(`${API_URL}/api/marketplace/featured?limit=${LISTING_LIMIT}`, { credentials: 'include' })
      .then((r) => r.json())
      .then((data: any) => {
        if (cancelled) return
        const list: OnboardingListing[] = Array.isArray(data?.items) ? data.items.slice(0, LISTING_LIMIT) : []
        setListings(list)
        if (Platform.OS === 'web' && !selected) {
          const pending = safeGetItem('pending_template_id')
          const match = pending ? list.find((l) => l.slug === pending) : undefined
          if (match) onSelect(match)
        }
      })
      .catch(() => {
        if (!cancelled) setListings([])
      })
    return () => {
      cancelled = true
    }
    // Fetch once per mount; `selected`/`onSelect` only seed the deep link.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (listings === null) {
    return (
      <View className="gap-3">
        {Array.from({ length: LISTING_LIMIT / columns }).map((_, r) => (
          <View key={r} className="flex-row gap-3">
            {Array.from({ length: columns }).map((__, c) => (
              <Skeleton key={c} className="h-[92px] flex-1 rounded-2xl" />
            ))}
          </View>
        ))}
      </View>
    )
  }

  if (listings.length === 0) {
    return (
      <View className="rounded-2xl border border-dashed border-border p-6">
        <Text className="text-sm text-muted-foreground">
          Featured agents couldn't load right now. You can start from scratch and browse the
          marketplace from your Team workspace anytime.
        </Text>
      </View>
    )
  }

  const rows: OnboardingListing[][] = []
  for (let i = 0; i < listings.length; i += columns) rows.push(listings.slice(i, i + columns))

  return (
    <View className="gap-3" accessibilityRole="radiogroup">
      {rows.map((row, r) => (
        <View key={r} className="flex-row gap-3">
          {row.map((listing) => (
            <SelectableCard
              key={listing.slug}
              testID={`onboarding-agent-${listing.slug}`}
              title={listing.title}
              description={listing.shortDescription}
              leading={<ListingIcon iconUrl={listing.iconUrl} />}
              selected={selected?.slug === listing.slug}
              onPress={() => onSelect(selected?.slug === listing.slug ? null : listing)}
            />
          ))}
          {row.length < columns ? <View className="flex-1" /> : null}
        </View>
      ))}
    </View>
  )
}
