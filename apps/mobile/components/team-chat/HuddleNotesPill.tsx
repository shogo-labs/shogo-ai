// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The call's notes state, on one line: on, off, or why it can't run here. Tapping
 * it turns notes off (or back on) for the rest of the call — any participant may.
 */
import { Pressable, Text, View } from 'react-native'
import { NotebookPen } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { notesPillLabel, notesPillTone, type NotesPillState } from '../../lib/huddle-notes'
import { setHuddleNotesEnabled } from '../../lib/huddle-call'

export { notesPillLabel, notesPillTone }
export type { NotesPillState }

export function HuddleNotesPill({
  notes,
  compact,
  onToggle,
}: {
  notes: NotesPillState
  /** The mini card and PiP have no room for the icon. */
  compact?: boolean
  /** Defaults to turning the call's notes on or off. */
  onToggle?: () => void
}) {
  const tone = notesPillTone(notes)
  const label = notesPillLabel(notes)
  return (
    <Pressable
      onPress={onToggle ?? (() => void setHuddleNotesEnabled(!notes.enabled))}
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityState={{ checked: notes.enabled }}
      accessibilityHint="Turn the call's notes on or off for everyone"
      className={cn(
        'flex-row items-center gap-1 rounded-full border px-2 py-1 active:opacity-70',
        tone === 'on' && 'border-emerald-500/50 bg-emerald-500/10',
        tone === 'off' && 'border-border bg-muted',
        tone === 'warn' && 'border-amber-500/50 bg-amber-500/10',
      )}
      testID="huddle-notes-pill"
    >
      {compact ? null : (
        <NotebookPen
          size={12}
          className={cn(tone === 'on' ? 'text-emerald-600' : tone === 'off' ? 'text-muted-foreground' : 'text-amber-600')}
        />
      )}
      <Text
        className={cn(
          'text-[10px] font-medium',
          tone === 'on' ? 'text-emerald-700 dark:text-emerald-400' : tone === 'off' ? 'text-muted-foreground' : 'text-amber-700 dark:text-amber-400',
        )}
        numberOfLines={1}
      >
        {label}
      </Text>
    </Pressable>
  )
}

/** The notice a pre-join screen and the guest join page show before anyone speaks. */
export function HuddleNotesNotice({ compact, guest }: { compact?: boolean; guest?: boolean }) {
  return (
    <View className={cn('flex-row items-center gap-1.5 rounded-lg bg-muted px-2 py-1.5', compact && 'px-1.5')} testID="huddle-notes-notice">
      <NotebookPen size={12} className="text-muted-foreground" />
      <Text className="flex-1 text-[11px] text-muted-foreground">
        {guest ? (
          <>
            This huddle is transcribed: everyone gets live captions, speaker-labelled notes and a summary afterwards. Any
            participant can turn notes off, which stops transcription for everyone. Asking Shogo to act on the
            conversation is a member's job, so a guest's words are transcribed but wake nothing.
          </>
        ) : (
          <>
            This huddle is transcribed: everyone gets live captions, speaker-labelled notes and a summary afterwards. Any
            participant can turn notes off, which stops transcription for everyone. Say “hey Shogo” to ask the workspace
            agent about the conversation so far.
          </>
        )}
      </Text>
    </View>
  )
}
