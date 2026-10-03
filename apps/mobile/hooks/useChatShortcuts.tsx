// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Keyboard shortcuts for team chat on web and desktop:
 *
 *   Alt+↑ / Alt+↓               previous / next conversation in the sidebar
 *   Alt+Shift+↑ / Alt+Shift+↓   previous / next unread conversation
 *   Cmd/Ctrl+Shift+M            inbox
 *   Cmd/Ctrl+/                  this list
 *   ↑ in an empty composer      edit your last message
 *
 * Cmd/Ctrl+K (jump to a conversation) lives in the command palette.
 */
import { useEffect, useRef, useState } from 'react'
import { Modal, Platform, Pressable, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import type { ConversationSummary } from '../lib/team-chat-api'
import { stepConversation } from '../lib/team-chat-state'

export const CHAT_SHORTCUTS: Array<{ keys: string; label: string }> = [
  { keys: '⌘K / Ctrl+K', label: 'Jump to a conversation or person' },
  { keys: 'Alt+↑ / Alt+↓', label: 'Previous / next conversation' },
  { keys: 'Alt+Shift+↑ / ↓', label: 'Previous / next unread conversation' },
  { keys: '⌘⇧M / Ctrl+Shift+M', label: 'Open inbox' },
  { keys: '↑', label: 'Edit your last message (empty composer)' },
  { keys: 'Enter / Shift+Enter', label: 'Send / new line' },
  { keys: '⌘/ / Ctrl+/', label: 'Show keyboard shortcuts' },
]

// ─── Edit-last requests (composer → message rows) ───────────────────────────

const editListeners = new Set<(messageId: string) => void>()

export function requestEditMessage(messageId: string): void {
  editListeners.forEach((l) => l(messageId))
}

/** Calls `onRequest` when something asks to edit `messageId`. */
export function useEditRequest(messageId: string, onRequest: () => void): void {
  const cb = useRef(onRequest)
  cb.current = onRequest
  useEffect(() => {
    const listener = (id: string) => {
      if (id === messageId) cb.current()
    }
    editListeners.add(listener)
    return () => {
      editListeners.delete(listener)
    }
  }, [messageId])
}

// ─── Global shortcuts ───────────────────────────────────────────────────────

export function useChatShortcuts(opts: {
  ordered: ConversationSummary[]
  activeId: string | null | undefined
  hrefFor: (id: string) => string
}): { helpOpen: boolean; closeHelp: () => void } {
  const router = useRouter()
  const [helpOpen, setHelpOpen] = useState(false)
  const latest = useRef(opts)
  latest.current = opts

  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      if (e.altKey && !mod && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        const { ordered, activeId, hrefFor } = latest.current
        const next = stepConversation(ordered, activeId, e.key === 'ArrowDown' ? 1 : -1, e.shiftKey)
        if (!next) return
        e.preventDefault()
        router.push(hrefFor(next.id) as any)
        return
      }
      if (mod && e.shiftKey && e.key.toLowerCase() === 'm') {
        e.preventDefault()
        router.push('/(app)/c/inbox' as any)
        return
      }
      if (mod && e.key === '/') {
        e.preventDefault()
        setHelpOpen((v) => !v)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [router])

  return { helpOpen, closeHelp: () => setHelpOpen(false) }
}

export function ShortcutsHelp({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View className="flex-1 items-center justify-center px-4">
        <Pressable onPress={onClose} className="absolute inset-0 bg-black/50" accessibilityLabel="Close" />
        <View className="z-10 w-full max-w-md rounded-xl border border-border bg-card p-5">
          <Text className="mb-3 text-base font-semibold text-foreground">Keyboard shortcuts</Text>
          {CHAT_SHORTCUTS.map((s) => (
            <View key={s.keys} className="flex-row items-center border-b border-border/50 py-2">
              <Text className="flex-1 text-sm text-foreground">{s.label}</Text>
              <Text className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">{s.keys}</Text>
            </View>
          ))}
        </View>
      </View>
    </Modal>
  )
}
