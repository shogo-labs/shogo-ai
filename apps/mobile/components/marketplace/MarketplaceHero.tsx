// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import type { ReactNode } from 'react'
import { View, Text, Platform } from 'react-native'

interface MarketplaceHeroProps {
  /** Tiny eyebrow above the title — e.g. "AGENT MARKETPLACE", "PERSONAL". */
  eyebrow?: string
  title: string
  /** One-line value-prop shown under the title. */
  subtitle?: string
  /** Accent color (`#rrggbb`) used for the gradient ribbon. */
  accent?: string
  /** Slot rendered to the right of the heading on wide layouts. */
  trailing?: ReactNode
  /** Slot rendered below the subtitle (e.g. stats, badges). */
  children?: ReactNode
  /** When true, render with reduced vertical padding for inline use. */
  compact?: boolean
}

/**
 * Editorial hero ribbon — the soft gradient that anchors the top of the
 * browse, detail, category landing, and creator profile pages. Matches
 * the Notion-style restraint: gradient is `{accent}33` → `{accent}0d`,
 * not a flood, so the underlying surface still reads.
 */
export function MarketplaceHero({
  eyebrow,
  title,
  subtitle,
  accent = '#e27927',
  trailing,
  children,
  compact,
}: MarketplaceHeroProps) {
  const titleStyle: any =
    Platform.OS === 'web'
      ? {
          fontFamily: 'Skema Pro Display, ui-serif, Georgia, serif',
          letterSpacing: -0.6,
          lineHeight: compact ? 36 : 44,
        }
      : { lineHeight: compact ? 32 : 40 }

  return (
    <View
      className="overflow-hidden"
      style={{
        backgroundColor: `${accent}14`,
        borderBottomWidth: 1,
        borderBottomColor: `${accent}22`,
      }}
    >
      {/* gradient layer — `{accent}33` top → transparent bottom, faked via two stacked tints */}
      <View
        pointerEvents="none"
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: 120,
          backgroundColor: `${accent}1f`,
        }}
      />
      <View
        className={`px-5 ${compact ? 'pt-6 pb-5' : 'pt-10 pb-8'} flex-row items-end gap-4`}
      >
        <View className="flex-1 min-w-0">
          {eyebrow && (
            <Text
              className="text-xs font-bold text-foreground/70 mb-2"
              style={{ letterSpacing: 1.4 }}
            >
              {eyebrow.toUpperCase()}
            </Text>
          )}
          <Text
            className={`font-bold text-foreground ${compact ? 'text-3xl' : 'text-4xl'}`}
            style={titleStyle}
            numberOfLines={2}
          >
            {title}
          </Text>
          {subtitle && (
            <Text className="text-sm text-foreground/70 mt-3 max-w-xl leading-5">
              {subtitle}
            </Text>
          )}
          {children ? <View className="mt-4">{children}</View> : null}
        </View>
        {trailing}
      </View>
    </View>
  )
}
