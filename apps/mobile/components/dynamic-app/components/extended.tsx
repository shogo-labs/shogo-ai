// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Extended Components for Dynamic App (React Native)
 *
 * Tabs and Accordion components built with React Native primitives.
 */

import { useState, type ReactNode } from 'react'
import { View, Pressable } from 'react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { Text } from '@/components/ui/text'
import { ChevronDown } from 'lucide-react-native'

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

interface TabDef {
  id: string
  label: string
}

interface DynTabsProps {
  tabs?: TabDef[]
  defaultTab?: string
  children?: ReactNode
  className?: string
}

export function DynTabs({ tabs = [], defaultTab, children, className }: DynTabsProps) {
  const [activeTab, setActiveTab] = useState(defaultTab || tabs[0]?.id || '')
  const childArray = Array.isArray(children) ? children : children ? [children] : []

  const activeIdx = tabs.findIndex((t) => t.id === activeTab)

  return (
    <View className={cn(className)}>
      {tabs.length > 0 && (
        <View className="flex-row border-b border-border">
          {tabs.map((tab) => (
            <Pressable
              key={tab.id}
              onPress={() => setActiveTab(tab.id)}
              className={cn(
                'px-4 py-2.5',
                activeTab === tab.id && 'border-b-2 border-primary',
              )}
            >
              <Text
                className={cn(
                  'text-sm font-medium',
                  activeTab === tab.id ? 'text-foreground' : 'text-muted-foreground',
                )}
              >
                {tab.label}
              </Text>
            </Pressable>
          ))}
        </View>
      )}
      <View className="pt-4">
        {activeIdx >= 0 && activeIdx < childArray.length
          ? childArray[activeIdx]
          : childArray[0]}
      </View>
    </View>
  )
}

interface DynTabPanelProps {
  title?: string
  children?: ReactNode
  className?: string
}

export function DynTabPanel({ children, className }: DynTabPanelProps) {
  return <View className={cn('flex flex-col gap-4', className)}>{children}</View>
}

// ---------------------------------------------------------------------------
// Accordion
// ---------------------------------------------------------------------------

interface DynAccordionProps {
  children?: ReactNode
  className?: string
}

export function DynAccordion({ children, className }: DynAccordionProps) {
  return <View className={cn('rounded-lg border border-border', className)}>{children}</View>
}

interface DynAccordionItemProps {
  title?: string
  defaultOpen?: boolean
  children?: ReactNode
  className?: string
}

export function DynAccordionItem({ title, defaultOpen = false, children, className }: DynAccordionItemProps) {
  const [open, setOpen] = useState(defaultOpen)

  return (
    <View className={cn('border-b border-border', className)}>
      <Pressable
        onPress={() => setOpen(!open)}
        className="flex-row items-center justify-between px-4 py-3"
      >
        <Text className="text-sm font-medium flex-1">{title}</Text>
        <ChevronDown
          size={16}
          className={cn('text-muted-foreground', open && 'rotate-180')}
        />
      </Pressable>
      {open && (
        <View className="px-4 pb-3">
          {children}
        </View>
      )}
    </View>
  )
}
