// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Opened from a date chip: the full date (in your time zone), reminders for
 * it, and, when you can edit the doc, changing or removing the date.
 */
import { useState } from 'react'
import { Modal, Pressable, Text, View } from 'react-native'
import { AlarmClock, CalendarDays, Pencil, Trash2, X } from 'lucide-react-native'
import { teamChatApi } from '../../lib/team-chat-api'
import { absoluteDateText, fullDateLabel, parseDateValue, reminderPresets } from '../../lib/doc-tokens'

const api = teamChatApi()

export interface DateChipCardProps {
  workspaceId: string
  conversationId: string
  value: string
  /** What the reminder is about, e.g. "#devops doc". */
  context: string
  editable: boolean
  onEdit: () => void
  onRemove: () => void
  onClose: () => void
}

export function DateChipCard({ workspaceId, conversationId, value, context, editable, onEdit, onRemove, onClose }: DateChipCardProps) {
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const now = new Date()
  const presets = reminderPresets(value, now)
  const isMoment = !!parseDateValue(value)?.instant

  const remind = async (at: Date, label: string) => {
    try {
      setError(null)
      await api.createReminder(workspaceId, {
        text: `${context}: ${fullDateLabel(value, now)}`,
        remindAt: at.toISOString(),
        conversationId,
        target: 'doc',
      })
      setNotice(`Reminder set: ${label.toLowerCase()}.`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not set the reminder')
    }
  }

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View className="flex-1 items-center justify-center p-6">
        <Pressable className="absolute inset-0 bg-black/30" onPress={onClose} accessibilityLabel="Close date" />
        <View className="w-full max-w-[340px] rounded-xl border border-border bg-card p-4" testID="date-chip-card">
          <View className="flex-row items-start gap-2">
            <CalendarDays size={18} className="mt-0.5 text-muted-foreground" />
            <View className="min-w-0 flex-1">
              <Text className="text-base font-semibold text-foreground" testID="date-chip-full">
                {fullDateLabel(value, now)}
              </Text>
              {isMoment ? <Text className="text-xs text-muted-foreground">{absoluteDateText(value)}</Text> : null}
            </View>
            <Pressable onPress={onClose} accessibilityLabel="Close" className="rounded p-1 active:bg-muted">
              <X size={16} className="text-muted-foreground" />
            </Pressable>
          </View>

          {presets.length ? (
            <View className="mt-3">
              <View className="mb-1 flex-row items-center gap-1.5">
                <AlarmClock size={12} className="text-muted-foreground" />
                <Text className="text-[11px] font-semibold uppercase text-muted-foreground">Add a reminder</Text>
              </View>
              {presets.map((p) => (
                <Pressable
                  key={p.label}
                  onPress={() => void remind(p.at, p.label)}
                  accessibilityRole="button"
                  accessibilityLabel={`Remind me ${p.label}`}
                  className="rounded-md px-2 py-1.5 active:bg-muted hover:bg-muted"
                >
                  <Text className="text-sm text-foreground">{p.label}</Text>
                </Pressable>
              ))}
            </View>
          ) : (
            <Text className="mt-3 text-xs text-muted-foreground">This date has passed.</Text>
          )}
          {notice ? <Text className="mt-2 text-xs text-primary" testID="date-chip-notice">{notice}</Text> : null}
          {error ? <Text className="mt-2 text-xs text-destructive">{error}</Text> : null}

          {editable ? (
            <View className="mt-3 flex-row gap-2 border-t border-border pt-3">
              <Pressable
                onPress={onEdit}
                accessibilityRole="button"
                accessibilityLabel="Edit date"
                className="flex-1 flex-row items-center justify-center gap-1.5 rounded-md border border-border py-1.5 active:bg-muted hover:bg-muted"
              >
                <Pencil size={13} className="text-foreground" />
                <Text className="text-xs font-medium text-foreground">Edit date</Text>
              </Pressable>
              <Pressable
                onPress={onRemove}
                accessibilityRole="button"
                accessibilityLabel="Remove date"
                className="flex-row items-center justify-center gap-1.5 rounded-md px-3 py-1.5 active:bg-muted hover:bg-muted"
              >
                <Trash2 size={13} className="text-destructive" />
                <Text className="text-xs text-destructive">Remove</Text>
              </Pressable>
            </View>
          ) : null}
        </View>
      </View>
    </Modal>
  )
}
