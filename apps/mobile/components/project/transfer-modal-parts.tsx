// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * transfer-modal-parts
 *
 * Small shared building blocks for the project Export and Import modals so the
 * two read as one consistent surface: an icon-anchored header, hairline-divided
 * option groups (instead of a stack of floating bordered boxes), borderless
 * toggle rows, a collapsible disclosure for advanced/optional inputs, and a
 * subtle info footnote.
 */
import React from 'react'
import { View, Pressable } from 'react-native'
import { Heading } from '@/components/ui/heading'
import { Text } from '@/components/ui/text'
import { Switch } from '@/components/ui/switch'
import { Divider } from '@/components/ui/divider'
import { ModalCloseButton } from '@/components/ui/modal'
import { X, ChevronDown } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'

type IconType = React.ComponentType<{ size?: number; className?: string }>

/** Header with a rounded icon badge, title, and (optional) close button. */
export function TransferModalHeader({
  icon: Icon,
  title,
  showClose = true,
}: {
  icon: IconType
  title: string
  showClose?: boolean
}) {
  return (
    <View className="flex-row items-center justify-between px-6 pt-6 pb-4 border-b border-outline-100">
      <View className="flex-row items-center gap-3 flex-1 pr-3">
        <View className="h-9 w-9 items-center justify-center rounded-full bg-background-100">
          <Icon size={18} className="text-typography-700" />
        </View>
        <Heading size="lg" className="text-typography-900" numberOfLines={1}>
          {title}
        </Heading>
      </View>
      {showClose && (
        <ModalCloseButton>
          <X size={20} className="text-typography-500" />
        </ModalCloseButton>
      )}
    </View>
  )
}

/**
 * One bordered container that lays out its children separated by hairline
 * dividers — replaces the previous stack of individually-bordered boxes.
 */
export function OptionGroup({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  const items = React.Children.toArray(children).filter(Boolean)
  return (
    <View
      className={cn(
        'rounded-xl border border-outline-100 bg-background-50 overflow-hidden',
        className,
      )}
    >
      {items.map((child, i) => (
        <React.Fragment key={i}>
          {i > 0 && <Divider className="bg-outline-100" />}
          {child}
        </React.Fragment>
      ))}
    </View>
  )
}

/** A borderless icon + title + description + Switch row for use in OptionGroup. */
export function ToggleRow({
  icon: Icon,
  title,
  description,
  value,
  onValueChange,
  disabled,
}: {
  icon?: IconType
  title: string
  description?: string
  value: boolean
  onValueChange: (v: boolean) => void
  disabled?: boolean
}) {
  return (
    <View className="flex-row items-start gap-3 px-4 py-3.5">
      {Icon && (
        <View className="mt-0.5">
          <Icon size={18} className="text-typography-500" />
        </View>
      )}
      <View className="flex-1">
        <Text className="text-sm font-medium text-typography-900">{title}</Text>
        {description && (
          <Text className="text-xs text-typography-500 mt-0.5 leading-relaxed">
            {description}
          </Text>
        )}
      </View>
      <Switch value={value} onValueChange={onValueChange} disabled={disabled} />
    </View>
  )
}

/** Collapsible section. Controlled via `open`/`onToggle`. */
export function Disclosure({
  icon: Icon,
  title,
  subtitle,
  open,
  onToggle,
  disabled,
  children,
}: {
  icon?: IconType
  title: string
  subtitle?: string
  open: boolean
  onToggle: () => void
  disabled?: boolean
  children: React.ReactNode
}) {
  return (
    <View className="rounded-xl border border-outline-100 bg-background-50 overflow-hidden">
      <Pressable
        onPress={onToggle}
        disabled={disabled}
        className="flex-row items-center gap-3 px-4 py-3.5 active:bg-background-100"
      >
        {Icon && (
          <View>
            <Icon size={18} className="text-typography-500" />
          </View>
        )}
        <View className="flex-1">
          <Text className="text-sm font-medium text-typography-900">{title}</Text>
          {subtitle && (
            <Text className="text-xs text-typography-500 mt-0.5">{subtitle}</Text>
          )}
        </View>
        <View
          style={{ transform: [{ rotate: open ? '180deg' : '0deg' }] }}
        >
          <ChevronDown size={18} className="text-typography-400" />
        </View>
      </Pressable>
      {open && (
        <>
          <Divider className="bg-outline-100" />
          <View className="px-4 py-3.5 gap-3">{children}</View>
        </>
      )}
    </View>
  )
}

/** Subtle informational footnote with a small leading icon. */
export function InfoNote({
  icon: Icon,
  children,
}: {
  icon?: IconType
  children: React.ReactNode
}) {
  return (
    <View className="flex-row items-start gap-2 px-1">
      {Icon && (
        <View className="mt-0.5">
          <Icon size={14} className="text-typography-400" />
        </View>
      )}
      <Text className="flex-1 text-xs text-typography-500 leading-relaxed">
        {children}
      </Text>
    </View>
  )
}
