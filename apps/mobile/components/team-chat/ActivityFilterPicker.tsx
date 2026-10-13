// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * One axis of the #activity filter bar: a chip that opens a searchable list.
 * Rows toggle, so several agents or channels can be on at once. "All" clears
 * the axis. One selection shows its name; more than one shows a count. A
 * button on the chip clears the axis without opening the list.
 */
import { useState } from 'react'
import { Modal, Pressable, ScrollView, Text, TextInput, View } from 'react-native'
import { Check, X } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'

export interface ActivityFilterOption {
  id: string
  label: string
}

export interface ActivityFilterPickerProps {
  /** "Agent" or "Channel": the chip reads "Agent: All" until something is chosen. */
  label: string
  value: string[]
  options: ActivityFilterOption[]
  onChange: (ids: string[]) => void
}

export function ActivityFilterPicker({ label, value, options, onChange }: ActivityFilterPickerProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const selected = options.filter((option) => value.includes(option.id))
  const q = query.trim().toLowerCase()
  const shown = q ? options.filter((option) => option.label.toLowerCase().includes(q)) : options
  const searchLabel = `Search ${label.toLowerCase()}s`
  const chip = chipLabel(label, selected)

  const close = () => {
    setOpen(false)
    setQuery('')
  }
  const toggle = (id: string) => {
    onChange(value.includes(id) ? value.filter((current) => current !== id) : [...value, id])
  }

  return (
    <>
      <View
        className={cn(
          'flex-row items-center rounded-full border',
          selected.length ? 'border-primary bg-primary/10' : 'border-border',
        )}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={chip.accessibilityLabel}
          aria-selected={selected.length > 0}
          testID={`activity-filter-${label.toLowerCase()}`}
          onPress={() => setOpen(true)}
          className="px-3 py-1 active:bg-accent/50"
        >
          <Text className={cn('text-xs', selected.length ? 'font-medium text-primary' : 'text-muted-foreground')}>
            {chip.text}
          </Text>
        </Pressable>
        {selected.length ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Clear ${label.toLowerCase()} filter`}
            onPress={() => onChange([])}
            className="py-1 pr-2"
          >
            <X size={12} className="text-primary" />
          </Pressable>
        ) : null}
      </View>
      {open ? (
        <Modal visible transparent animationType="fade" onRequestClose={close}>
          <Pressable className="flex-1 items-center justify-center bg-black/40 p-6" onPress={close} accessibilityLabel="Close filter">
            <Pressable
              className="max-h-[80%] w-full max-w-sm rounded-xl bg-card p-4"
              onPress={(event) => (event as { stopPropagation?: () => void }).stopPropagation?.()}
            >
              <Text className="mb-3 text-base font-semibold text-foreground">{label}</Text>
              <TextInput
                value={query}
                onChangeText={setQuery}
                autoFocus
                placeholder={searchLabel}
                placeholderTextColor="#8a8a8a"
                accessibilityLabel={searchLabel}
                className="mb-2 rounded-md border border-border px-3 py-2.5 text-base text-foreground"
              />
              <ScrollView className="max-h-80" keyboardShouldPersistTaps="handled">
                <OptionRow label="All" selected={!value.length} onPress={() => onChange([])} />
                {shown.map((option) => (
                  <OptionRow
                    key={option.id}
                    label={option.label}
                    selected={value.includes(option.id)}
                    onPress={() => toggle(option.id)}
                  />
                ))}
                {!shown.length ? <Text className="px-2 py-4 text-sm text-muted-foreground">No matches.</Text> : null}
              </ScrollView>
            </Pressable>
          </Pressable>
        </Modal>
      ) : null}
    </>
  )
}

/** One name on the chip, or a count once more than one is checked. */
function chipLabel(label: string, selected: ActivityFilterOption[]): { text: string; accessibilityLabel: string } {
  if (selected.length === 0) {
    const text = `${label}: All`
    return { text, accessibilityLabel: text }
  }
  if (selected.length === 1) {
    return { text: selected[0]!.label, accessibilityLabel: `${label}: ${selected[0]!.label}` }
  }
  return {
    text: `${selected.length} ${label.toLowerCase()}s`,
    accessibilityLabel: `${label}: ${selected.map((option) => option.label).join(', ')}`,
  }
}

function OptionRow({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked: selected }}
      onPress={onPress}
      className="min-h-12 flex-row items-center gap-3 rounded-md px-2 py-2 active:bg-muted hover:bg-muted"
    >
      <View className={cn('h-5 w-5 items-center justify-center rounded border', selected ? 'border-primary bg-primary' : 'border-border')}>
        {selected ? <Check size={13} className="text-primary-foreground" /> : null}
      </View>
      <Text className="min-w-0 flex-1 text-sm text-foreground" numberOfLines={1}>{label}</Text>
    </Pressable>
  )
}
