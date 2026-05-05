// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { View, Text } from 'react-native'
import * as Lucide from 'lucide-react-native'
import { resolveIntegration } from '@shogo/shared-app'

interface IntegrationStripProps {
  tags: string[]
  /** When true, render only chips that resolve to a known integration. */
  knownOnly?: boolean
  /** Cap the number of chips shown — overflow is collapsed into "+N more". */
  max?: number
}

/**
 * Resolve a Lucide icon name (string) to its component. Returns null when
 * the name doesn't exist in lucide-react-native.
 */
function getIcon(name: string): React.ComponentType<{ size?: number; color?: string }> | null {
  const Icon = (Lucide as any)[name]
  return Icon ?? null
}

/**
 * Shopify-style "Works with: Gmail, Slack, ..." horizontal strip. Tags
 * registered in `KNOWN_INTEGRATIONS` get a tinted icon chip; unknown
 * tags render as plain text chips so creators don't need to wait for us
 * to recognize their integration.
 */
export function IntegrationStrip({ tags, knownOnly, max = 8 }: IntegrationStripProps) {
  const filtered = tags.filter((t) => (knownOnly ? !!resolveIntegration(t) : true))
  if (filtered.length === 0) return null

  const visible = filtered.slice(0, max)
  const overflow = filtered.length - visible.length

  return (
    <View className="flex-row flex-wrap items-center gap-2">
      {visible.map((tag) => {
        const integration = resolveIntegration(tag)
        if (integration) {
          const Icon = getIcon(integration.icon)
          const tint = integration.color ?? '#71717a'
          return (
            <View
              key={tag}
              className="flex-row items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1"
            >
              {Icon ? <Icon size={12} color={tint} /> : null}
              <Text className="text-xs font-medium text-foreground">
                {integration.label}
              </Text>
            </View>
          )
        }
        return (
          <View
            key={tag}
            className="rounded-full bg-muted px-2.5 py-1"
          >
            <Text className="text-xs text-muted-foreground">{tag}</Text>
          </View>
        )
      })}
      {overflow > 0 && (
        <View className="rounded-full bg-muted px-2.5 py-1">
          <Text className="text-xs text-muted-foreground">+{overflow} more</Text>
        </View>
      )}
    </View>
  )
}
