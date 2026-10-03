// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { Check, ChevronsUpDown } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'

export interface SelectOption<T> {
  value: T
  label: string
}

interface OptionSelectProps<T> {
  testID: string
  label: string
  value: T
  options: SelectOption<T>[]
  onChange: (value: T) => void
  disabled?: boolean
}

/**
 * Compact value + chevron control that expands its options inline. Avoids
 * overlay positioning so it behaves the same on web, desktop and native.
 */
export function OptionSelect<T extends string | null>({
  testID,
  label,
  value,
  options,
  onChange,
  disabled,
}: OptionSelectProps<T>) {
  const [open, setOpen] = useState(false)
  const current = options.find((o) => o.value === value)

  return (
    <View className="items-end">
      <Pressable
        testID={testID}
        accessibilityRole="button"
        accessibilityLabel={`${label}: ${current?.label ?? ''}`}
        accessibilityState={{ expanded: open, disabled }}
        disabled={disabled}
        onPress={() => setOpen((o) => !o)}
        className={cn('flex-row items-center gap-1.5 rounded-lg px-2 py-1.5 web:hover:bg-muted', disabled && 'opacity-50')}
      >
        <Text className="text-sm font-medium text-foreground">{current?.label ?? '—'}</Text>
        <ChevronsUpDown size={14} className="text-muted-foreground" />
      </Pressable>
      {open ? (
        <View className="mt-1 min-w-[160px] overflow-hidden rounded-xl border border-border bg-popover">
          {options.map((opt) => {
            const selected = opt.value === value
            return (
              <Pressable
                key={String(opt.value)}
                testID={`${testID}-option-${opt.value ?? 'none'}`}
                accessibilityRole="menuitem"
                onPress={() => {
                  setOpen(false)
                  onChange(opt.value)
                }}
                className="flex-row items-center justify-between gap-3 px-3 py-2 web:hover:bg-muted"
              >
                <Text className="text-sm text-foreground">{opt.label}</Text>
                {selected ? <Check size={14} className="text-primary" /> : null}
              </Pressable>
            )
          })}
        </View>
      ) : null}
    </View>
  )
}
