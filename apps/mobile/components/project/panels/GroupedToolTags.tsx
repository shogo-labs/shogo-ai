// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useMemo, useState } from 'react'
import { View, Text, Pressable } from 'react-native'
import { ChevronDown, ChevronUp } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import {
  groupToolsByCategory,
  categoryTextClass,
  categoryBgClass,
} from './tool-categories'

interface GroupedToolTagsProps {
  tools: string[]
  className?: string
}

export function GroupedToolTags({ tools, className }: GroupedToolTagsProps) {
  const [expanded, setExpanded] = useState(false)
  const groups = useMemo(() => groupToolsByCategory(tools), [tools])

  if (groups.length === 0) return null

  if (!expanded) {
    return (
      <Pressable
        onPress={() => setExpanded(true)}
        accessibilityRole="button"
        accessibilityLabel="Show tool details by category"
        accessibilityHint="Expands grouped tool list"
        className={cn('flex-row flex-wrap gap-1 mt-1.5', className)}
      >
        {groups.map(({ category, tools: categoryTools }) => (
          <View
            key={category.id}
            className={cn(
              'flex-row items-center gap-1 rounded px-1.5 py-0.5',
              categoryBgClass(category.color),
            )}
          >
            <Text
              className={cn('text-[10px] font-semibold', categoryTextClass(category.color))}
            >
              {category.label}
            </Text>
            {categoryTools.length > 1 ? (
              <Text className={cn('text-[10px]', categoryTextClass(category.color))}>
                {categoryTools.length}
              </Text>
            ) : null}
          </View>
        ))}
        <ChevronDown size={12} className="text-muted-foreground self-center" />
      </Pressable>
    )
  }

  return (
    <View className={cn('mt-1.5 gap-1.5', className)}>
      {groups.map(({ category, tools: categoryTools }) => (
        <View key={category.id} className="flex-row flex-wrap items-center gap-1">
          <View
            className={cn(
              'rounded px-1.5 py-0.5 mr-0.5',
              categoryBgClass(category.color),
            )}
          >
            <Text
              className={cn('text-[10px] font-semibold', categoryTextClass(category.color))}
            >
              {category.label}
            </Text>
          </View>
          {categoryTools.map((tool) => (
            <View key={tool} className="px-1.5 py-0.5 bg-muted/80 rounded">
              <Text className="text-muted-foreground text-[10px]">{tool}</Text>
            </View>
          ))}
        </View>
      ))}
      <Pressable
        onPress={() => setExpanded(false)}
        accessibilityRole="button"
        accessibilityLabel="Collapse tool list"
        className="flex-row items-center gap-0.5 self-start mt-0.5"
      >
        <ChevronUp size={12} className="text-muted-foreground" />
        <Text className="text-[10px] text-muted-foreground">Show less</Text>
      </Pressable>
    </View>
  )
}
