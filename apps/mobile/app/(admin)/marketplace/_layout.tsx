// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Marketplace admin sub-layout. Renders a horizontal tab strip across
 * the three top-level pages (Review queue, Listings, Payouts) and a
 * Slot for the active page. The strip is suppressed on detail pages
 * (e.g. /marketplace/listing/:id) since those have their own back
 * button + header.
 *
 * Auth + DomainProvider are already provided by the parent
 * (admin)/_layout.tsx, so this layout intentionally stays thin.
 */

import { View, Text, Pressable, ScrollView, useWindowDimensions } from 'react-native'
import { Slot, usePathname, useRouter } from 'expo-router'
import { Inbox, ListChecks, DollarSign } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'

const TABS = [
  { href: '/(admin)/marketplace', match: '/marketplace', exact: true, icon: Inbox, label: 'Review queue' },
  { href: '/(admin)/marketplace/listings', match: '/marketplace/listings', exact: false, icon: ListChecks, label: 'Listings' },
  { href: '/(admin)/marketplace/payouts', match: '/marketplace/payouts', exact: false, icon: DollarSign, label: 'Payouts' },
] as const

function isTabActive(pathname: string, tab: (typeof TABS)[number]): boolean {
  if (tab.exact) {
    return pathname === tab.match || pathname === `${tab.match}/index`
  }
  return pathname.startsWith(tab.match)
}

function shouldShowTabs(pathname: string): boolean {
  // Hide the tab strip on the listing detail page so the detail screen
  // owns the full header (back button + actions).
  return !pathname.startsWith('/marketplace/listing/')
}

export default function MarketplaceAdminLayout() {
  const router = useRouter()
  const pathname = usePathname()
  const { width } = useWindowDimensions()
  const isWide = width >= 900

  const showTabs = shouldShowTabs(pathname)

  return (
    <View className="flex-1 bg-background">
      {showTabs && (
        <View className={cn('border-b border-border bg-card', isWide ? 'px-8' : 'px-3')}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ alignItems: 'center', gap: 4, paddingVertical: 8 }}
          >
            {TABS.map((tab) => {
              const Icon = tab.icon
              const active = isTabActive(pathname, tab)
              return (
                <Pressable
                  key={tab.href}
                  onPress={() => router.push(tab.href as any)}
                  role="tab"
                  accessibilityState={{ selected: active }}
                  accessibilityLabel={tab.label}
                  className={cn(
                    'flex-row items-center gap-1.5 px-3 py-2 rounded-lg',
                    active ? 'bg-primary/10' : 'active:bg-muted/50',
                  )}
                >
                  <Icon size={14} className={active ? 'text-primary' : 'text-muted-foreground'} />
                  <Text
                    className={cn(
                      'text-sm font-medium',
                      active ? 'text-primary' : 'text-muted-foreground',
                    )}
                  >
                    {tab.label}
                  </Text>
                </Pressable>
              )
            })}
          </ScrollView>
        </View>
      )}

      <View className="flex-1">
        <Slot />
      </View>
    </View>
  )
}
