// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The two strips an email thread adds to a thread pane:
 *
 * - `MailThreadActions` (top): assign, status, snooze and category for the
 *   thread, with `e` / `a` / `h` / `r` shortcuts on web.
 * - `MailReplyModeBar` (above the composer): **Reply** sends an email to the
 *   people on the thread, **Comment** posts a team-only note, as any thread
 *   reply does.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Platform, Pressable, ScrollView, Text, View } from 'react-native'
import { AlarmClock, Check, Inbox, Mail, MessageSquare, UserPlus } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import {
  MAIL_CATEGORY_LABELS,
  MAIL_STATUS_LABELS,
  mailApi,
  type MailCategory,
  type MailThread,
  type MailThreadStatus,
} from '../../lib/mail-api'
import type { Mentionables } from '../../lib/team-chat-api'

const api = mailApi()

export type MailComposeMode = 'reply' | 'comment'

/** Snooze presets, as absolute times from now. */
export function snoozeOptions(now = new Date()): Array<{ label: string; at: Date }> {
  const inHour = new Date(now.getTime() + 60 * 60 * 1000)
  const tomorrow = new Date(now)
  tomorrow.setDate(now.getDate() + 1)
  tomorrow.setHours(9, 0, 0, 0)
  const nextWeek = new Date(now)
  nextWeek.setDate(now.getDate() + ((8 - now.getDay()) % 7 || 7))
  nextWeek.setHours(9, 0, 0, 0)
  return [
    { label: 'In 1 hour', at: inHour },
    { label: 'Tomorrow 9am', at: tomorrow },
    { label: 'Next week', at: nextWeek },
  ]
}

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el) return false
  const tag = el.tagName?.toLowerCase()
  return tag === 'input' || tag === 'textarea' || tag === 'select' || !!el.isContentEditable
}

function Chip({ label, active, onPress, icon, testID }: { label: string; active?: boolean; onPress: () => void; icon?: React.ReactNode; testID?: string }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      aria-selected={active}
      testID={testID}
      className={cn(
        'flex-row items-center gap-1 rounded-full border px-2.5 py-1',
        active ? 'border-primary bg-primary/10' : 'border-border active:bg-accent/50 hover:bg-accent/50',
      )}
    >
      {icon}
      <Text className={cn('text-xs', active ? 'font-medium text-primary' : 'text-foreground')}>{label}</Text>
    </Pressable>
  )
}

type Menu = 'assign' | 'snooze' | 'category' | null

export function MailThreadActions({
  workspaceId,
  threadId,
  mentionables,
  me,
  onReply,
}: {
  workspaceId: string
  threadId: string
  mentionables: Mentionables | null
  me: string | null
  /** `r`: switch the composer to Reply and focus it. */
  onReply?: () => void
}) {
  const [thread, setThread] = useState<MailThread | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [menu, setMenu] = useState<Menu>(null)

  useEffect(() => {
    let cancelled = false
    api
      .thread(workspaceId, threadId)
      .then((r) => !cancelled && setThread(r.thread))
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : String(err)))
    return () => {
      cancelled = true
    }
  }, [workspaceId, threadId])

  const patch = useCallback(
    async (p: { status?: MailThreadStatus; assigneeUserId?: string | null; snoozedUntil?: string | null; category?: MailCategory }) => {
      setError(null)
      setMenu(null)
      setThread((t) => (t ? { ...t, ...p } : t))
      try {
        setThread(await api.updateThread(workspaceId, threadId, p))
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    },
    [workspaceId, threadId],
  )

  const latest = useRef({ patch, onReply })
  latest.current = { patch, onReply }
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return
      const key = e.key.toLowerCase()
      if (key === 'e') {
        e.preventDefault()
        void latest.current.patch({ status: 'done' })
      } else if (key === 'a') {
        e.preventDefault()
        setMenu((m) => (m === 'assign' ? null : 'assign'))
      } else if (key === 'h') {
        e.preventDefault()
        setMenu((m) => (m === 'snooze' ? null : 'snooze'))
      } else if (key === 'r' && latest.current.onReply) {
        e.preventDefault()
        latest.current.onReply()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  const people = mentionables?.people ?? []
  const assignee = thread?.assigneeUserId ? people.find((p) => p.id === thread.assigneeUserId) : null
  const snoozed = thread?.snoozedUntil && new Date(thread.snoozedUntil).getTime() > Date.now()

  return (
    <View className="gap-2 border-b border-border bg-background px-3 py-2" testID="mail-thread-actions">
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerClassName="items-center gap-1.5">
        <Chip
          label={assignee ? assignee.name : 'Assign'}
          active={menu === 'assign' || !!assignee}
          onPress={() => setMenu((m) => (m === 'assign' ? null : 'assign'))}
          icon={<UserPlus size={12} className="text-muted-foreground" />}
          testID="mail-assign"
        />
        {(Object.keys(MAIL_STATUS_LABELS) as MailThreadStatus[]).map((s) => (
          <Chip
            key={s}
            label={MAIL_STATUS_LABELS[s]}
            active={thread?.status === s}
            onPress={() => void patch({ status: s })}
            icon={s === 'done' ? <Check size={12} className="text-muted-foreground" /> : undefined}
            testID={`mail-status-${s}`}
          />
        ))}
        <Chip
          label={snoozed ? `Snoozed until ${new Date(thread!.snoozedUntil!).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : 'Snooze'}
          active={menu === 'snooze' || !!snoozed}
          onPress={() => setMenu((m) => (m === 'snooze' ? null : 'snooze'))}
          icon={<AlarmClock size={12} className="text-muted-foreground" />}
          testID="mail-snooze"
        />
        <Chip
          label={thread ? MAIL_CATEGORY_LABELS[thread.category] ?? 'Move' : 'Move'}
          active={menu === 'category'}
          onPress={() => setMenu((m) => (m === 'category' ? null : 'category'))}
          icon={<Inbox size={12} className="text-muted-foreground" />}
          testID="mail-category"
        />
      </ScrollView>

      {menu === 'assign' ? (
        <View className="flex-row flex-wrap gap-1.5" testID="mail-assign-menu">
          {me ? <Chip label="Me" onPress={() => void patch({ assigneeUserId: me })} /> : null}
          {people
            .filter((p) => p.id !== me)
            .map((p) => (
              <Chip key={p.id} label={p.name} active={thread?.assigneeUserId === p.id} onPress={() => void patch({ assigneeUserId: p.id })} />
            ))}
          {thread?.assigneeUserId ? <Chip label="Unassign" onPress={() => void patch({ assigneeUserId: null })} /> : null}
        </View>
      ) : null}
      {menu === 'snooze' ? (
        <View className="flex-row flex-wrap gap-1.5" testID="mail-snooze-menu">
          {snoozeOptions().map((o) => (
            <Chip key={o.label} label={o.label} onPress={() => void patch({ snoozedUntil: o.at.toISOString() })} />
          ))}
          {snoozed ? <Chip label="Unsnooze" onPress={() => void patch({ snoozedUntil: null })} /> : null}
        </View>
      ) : null}
      {menu === 'category' ? (
        <View className="flex-row flex-wrap gap-1.5" testID="mail-category-menu">
          {(['important', 'feed', 'paper_trail', 'spam'] as MailCategory[]).map((c) => (
            <Chip key={c} label={MAIL_CATEGORY_LABELS[c]} active={thread?.category === c} onPress={() => void patch({ category: c })} />
          ))}
        </View>
      ) : null}
      {error ? <Text className="text-xs text-destructive">{error}</Text> : null}
      {Platform.OS === 'web' ? (
        <Text className="text-[10px] text-muted-foreground">Shortcuts: e done · r reply · a assign · h snooze</Text>
      ) : null}
    </View>
  )
}

export function MailReplyModeBar({
  mode,
  onModeChange,
  replyAll,
  onReplyAllChange,
}: {
  mode: MailComposeMode
  onModeChange: (mode: MailComposeMode) => void
  replyAll: boolean
  onReplyAllChange: (on: boolean) => void
}) {
  return (
    <View className="flex-row flex-wrap items-center gap-2 px-4 pb-1.5" testID="mail-reply-mode">
      <View className="flex-row overflow-hidden rounded-md border border-border">
        <Pressable
          onPress={() => onModeChange('reply')}
          accessibilityRole="radio"
          aria-checked={mode === 'reply'}
          className={cn('flex-row items-center gap-1 px-2.5 py-1', mode === 'reply' ? 'bg-primary' : 'active:bg-muted')}
          testID="mail-mode-reply"
        >
          <Mail size={12} className={mode === 'reply' ? 'text-primary-foreground' : 'text-muted-foreground'} />
          <Text className={cn('text-xs font-medium', mode === 'reply' ? 'text-primary-foreground' : 'text-foreground')}>Reply (email)</Text>
        </Pressable>
        <Pressable
          onPress={() => onModeChange('comment')}
          accessibilityRole="radio"
          aria-checked={mode === 'comment'}
          className={cn('flex-row items-center gap-1 border-l border-border px-2.5 py-1', mode === 'comment' ? 'bg-primary' : 'active:bg-muted')}
          testID="mail-mode-comment"
        >
          <MessageSquare size={12} className={mode === 'comment' ? 'text-primary-foreground' : 'text-muted-foreground'} />
          <Text className={cn('text-xs font-medium', mode === 'comment' ? 'text-primary-foreground' : 'text-foreground')}>Comment (team only)</Text>
        </Pressable>
      </View>
      {mode === 'reply' ? (
        <Pressable
          onPress={() => onReplyAllChange(!replyAll)}
          accessibilityRole="checkbox"
          aria-checked={replyAll}
          className="flex-row items-center gap-1.5"
          testID="mail-reply-all"
        >
          <View className={cn('h-3.5 w-3.5 items-center justify-center rounded-sm border', replyAll ? 'border-primary bg-primary' : 'border-border')}>
            {replyAll ? <Check size={10} className="text-primary-foreground" /> : null}
          </View>
          <Text className="text-xs text-foreground">Reply all</Text>
        </Pressable>
      ) : null}
    </View>
  )
}
