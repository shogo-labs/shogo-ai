// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/** A single-choice list in a modal: move to column, set priority, assign. */
import { useState } from 'react'
import { Modal, Pressable, ScrollView, Text, TextInput, View } from 'react-native'
import { Check } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'

export interface SheetOption {
  id: string
  label: string
  hint?: string
}

export interface OptionSheetProps {
  title: string
  options: SheetOption[]
  value?: string | null
  searchable?: boolean
  onSelect: (id: string) => void
  onClose: () => void
}

export function OptionSheet({ title, options, value, searchable, onSelect, onClose }: OptionSheetProps) {
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()
  const shown = q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable className="flex-1 items-center justify-center bg-black/40 p-6" onPress={onClose} accessibilityLabel={`Close ${title.toLowerCase()}`}>
        <Pressable
          className="max-h-[80%] w-full max-w-sm rounded-xl bg-card p-4"
          testID="option-sheet"
          onPress={(event) => (event as { stopPropagation?: () => void }).stopPropagation?.()}
        >
          <Text className="mb-3 text-base font-semibold text-foreground">{title}</Text>
          {searchable ? (
            <TextInput
              value={query}
              onChangeText={setQuery}
              autoFocus
              placeholder="Search"
              placeholderTextColor="#8a8a8a"
              accessibilityLabel={`Search ${title.toLowerCase()}`}
              className="mb-2 rounded-md border border-border px-3 py-2.5 text-base text-foreground"
            />
          ) : null}
          <ScrollView className="max-h-80" keyboardShouldPersistTaps="handled">
            {shown.map((option) => {
              const selected = option.id === value
              return (
                <Pressable
                  key={option.id}
                  accessibilityRole="button"
                  aria-selected={selected}
                  onPress={() => {
                    onSelect(option.id)
                    onClose()
                  }}
                  className="min-h-11 flex-row items-center gap-3 rounded-md px-2 py-2 active:bg-muted hover:bg-muted"
                >
                  <View className="w-4">{selected ? <Check size={14} className="text-primary" /> : null}</View>
                  <View className="min-w-0 flex-1">
                    <Text className={cn('text-sm text-foreground', selected && 'font-medium')} numberOfLines={1}>{option.label}</Text>
                    {option.hint ? <Text className="text-xs text-muted-foreground" numberOfLines={1}>{option.hint}</Text> : null}
                  </View>
                </Pressable>
              )
            })}
            {!shown.length ? <Text className="px-2 py-4 text-sm text-muted-foreground">No matches.</Text> : null}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  )
}
