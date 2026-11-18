// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A mailbox conversation's main view. The tabs split mail the way a mail app
 * does (Inbox / Feed / Paper trail / Screener / Snoozed / Done / Assigned to
 * me); "Chat" is the plain conversation timeline underneath. Opening a thread
 * opens its chat thread, where every email and team comment lives.
 */
import { useCallback, useEffect, useState } from 'react'
import { ActivityIndicator, Modal, Pressable, ScrollView, Text, TextInput, View } from 'react-native'
import { Mail, Pencil, X } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import {
  MAIL_STATUS_LABELS,
  MAIL_VIEWS,
  formatAddress,
  mailApi,
  parseAddressList,
  threadRootMessageId,
  type Mailbox,
  type MailThread,
  type MailView,
  type ScreenerSender,
  type SenderDecision,
} from '../../lib/mail-api'
import type { Mentionables } from '../../lib/team-chat-api'
import { snoozeOptions } from './MailThreadBar'

const api = mailApi()

export type MailboxTab = MailView | 'chat'

function formatWhen(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function MailboxHeader({
  mailbox,
  tab,
  onTabChange,
  onCompose,
  style,
}: {
  mailbox: Mailbox
  tab: MailboxTab
  onTabChange: (tab: MailboxTab) => void
  onCompose: () => void
  style?: object
}) {
  const tabs: Array<{ id: MailboxTab; label: string }> = [...MAIL_VIEWS, { id: 'chat', label: 'Chat' }]
  return (
    <View className="shrink-0 border-b border-border/60" style={style} testID="mailbox-header">
      <View className="flex-row items-center gap-2 px-3 pt-2">
        <Mail size={14} className="text-muted-foreground" />
        <Text className="min-w-0 flex-1 text-xs text-muted-foreground" numberOfLines={1}>
          {mailbox.displayName ? `${mailbox.displayName} · ` : ''}
          {mailbox.address}
        </Text>
        <Pressable
          onPress={onCompose}
          accessibilityRole="button"
          className="flex-row items-center gap-1 rounded-md bg-primary px-2.5 py-1 active:opacity-90"
          testID="mail-new-email"
        >
          <Pencil size={12} className="text-primary-foreground" />
          <Text className="text-xs font-semibold text-primary-foreground">New email</Text>
        </Pressable>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerClassName="items-center gap-1.5 px-3 py-2">
        {tabs.map((t) => (
          <Pressable
            key={t.id}
            onPress={() => onTabChange(t.id)}
            accessibilityRole="tab"
            aria-selected={tab === t.id}
            className={cn('rounded-full border px-3 py-1', tab === t.id ? 'border-primary bg-primary/10' : 'border-border active:bg-accent/50')}
            testID={`mailbox-tab-${t.id}`}
          >
            <Text className={cn('text-xs', tab === t.id ? 'font-medium text-primary' : 'text-muted-foreground')}>{t.label}</Text>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  )
}

export function MailThreadList({
  workspaceId,
  mailbox,
  view,
  mentionables,
  onOpenThread,
  refreshKey,
}: {
  workspaceId: string
  mailbox: Mailbox
  view: MailView
  mentionables: Mentionables | null
  /** Called with the chat message id that roots the thread. */
  onOpenThread: (rootMessageId: string) => void
  refreshKey?: number
}) {
  const [threads, setThreads] = useState<MailThread[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [submitted, setSubmitted] = useState('')

  useEffect(() => {
    let cancelled = false
    setThreads(null)
    setError(null)
    api
      .threads(workspaceId, mailbox.id, { view, q: submitted || undefined, limit: 50 })
      .then((t) => !cancelled && setThreads(t))
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : String(err)))
    return () => {
      cancelled = true
    }
  }, [workspaceId, mailbox.id, view, submitted, refreshKey])

  const open = useCallback(
    async (thread: MailThread) => {
      const root = threadRootMessageId(thread)
      if (root) return onOpenThread(root)
      try {
        const detail = await api.thread(workspaceId, thread.id)
        const first = detail.messages.find((m) => m.conversationMessageId)
        if (first?.conversationMessageId) onOpenThread(first.conversationMessageId)
        else setError('This thread has no message in the conversation yet.')
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    },
    [workspaceId, onOpenThread],
  )

  const people = mentionables?.people ?? []
  return (
    <View className="flex-1">
      <View className="px-3 pt-2">
        <TextInput
          value={query}
          onChangeText={setQuery}
          onSubmitEditing={() => setSubmitted(query.trim())}
          placeholder="Search this mailbox"
          accessibilityLabel="Search this mailbox"
          returnKeyType="search"
          className="rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground"
        />
      </View>
      {error ? <Text className="px-4 pt-2 text-xs text-destructive">{error}</Text> : null}
      {threads === null && !error ? (
        <ActivityIndicator className="mt-6" />
      ) : threads && !threads.length ? (
        <Text className="px-4 pt-6 text-center text-sm text-muted-foreground">Nothing here.</Text>
      ) : (
        <ScrollView className="flex-1" contentContainerClassName="py-1" testID="mail-thread-list">
          {(threads ?? []).map((t) => {
            const assignee = t.assigneeUserId ? people.find((p) => p.id === t.assigneeUserId)?.name : null
            const from = t.from ? formatAddress(t.from) : (t.participants ?? []).map((p) => p.name || p.address).join(', ')
            const late = t.slaDueAt && t.status !== 'done' && new Date(t.slaDueAt).getTime() < Date.now()
            return (
              <Pressable
                key={t.id}
                onPress={() => void open(t)}
                accessibilityRole="link"
                className="gap-0.5 border-b border-border/40 px-4 py-2.5 active:bg-accent/50 hover:bg-accent/40"
                testID="mail-thread-row"
              >
                <View className="flex-row items-center gap-2">
                  <Text className={cn('min-w-0 flex-1 text-sm text-foreground', t.unread && 'font-semibold')} numberOfLines={1}>
                    {from || '(unknown sender)'}
                  </Text>
                  <Text className="text-[11px] text-muted-foreground">{formatWhen(t.lastMessageAt)}</Text>
                </View>
                <Text className={cn('text-sm text-foreground', t.unread && 'font-semibold')} numberOfLines={1}>
                  {t.subject || '(no subject)'}
                  {t.messageCount && t.messageCount > 1 ? <Text className="text-muted-foreground"> ({t.messageCount})</Text> : null}
                </Text>
                {t.snippet ? (
                  <Text className="text-xs text-muted-foreground" numberOfLines={1}>{t.snippet}</Text>
                ) : null}
                <View className="mt-0.5 flex-row flex-wrap items-center gap-1.5">
                  {t.status !== 'open' ? (
                    <Text className="rounded bg-muted px-1.5 py-px text-[10px] text-muted-foreground">{MAIL_STATUS_LABELS[t.status]}</Text>
                  ) : null}
                  {assignee ? <Text className="rounded bg-primary/10 px-1.5 py-px text-[10px] text-primary">{assignee}</Text> : null}
                  {late ? <Text className="rounded bg-destructive/15 px-1.5 py-px text-[10px] text-destructive">Past SLA</Text> : null}
                </View>
              </Pressable>
            )
          })}
        </ScrollView>
      )}
    </View>
  )
}

const DECISIONS: Array<{ id: SenderDecision; label: string }> = [
  { id: 'allow', label: 'Allow' },
  { id: 'feed', label: 'Feed' },
  { id: 'paper_trail', label: 'Paper trail' },
  { id: 'block', label: 'Block' },
]

export function ScreenerList({ workspaceId, mailbox }: { workspaceId: string; mailbox: Mailbox }) {
  const [senders, setSenders] = useState<ScreenerSender[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    api
      .screener(workspaceId, mailbox.id)
      .then((s) => !cancelled && setSenders(s))
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : String(err)))
    return () => {
      cancelled = true
    }
  }, [workspaceId, mailbox.id])

  const decide = async (address: string, decision: SenderDecision) => {
    setError(null)
    try {
      await api.decideSender(workspaceId, mailbox.id, address, decision)
      setSenders((s) => (s ?? []).filter((x) => x.address !== address))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <ScrollView className="flex-1" contentContainerClassName="gap-2 p-3" testID="mail-screener">
      <Text className="text-xs text-muted-foreground">
        First-time senders wait here. Allow them into the Inbox, send them to Feed or Paper trail, or block them.
      </Text>
      {error ? <Text className="text-xs text-destructive">{error}</Text> : null}
      {senders === null && !error ? <ActivityIndicator className="mt-4" /> : null}
      {senders && !senders.length ? <Text className="pt-4 text-center text-sm text-muted-foreground">No one is waiting.</Text> : null}
      {(senders ?? []).map((s) => (
        <View key={s.address} className="gap-1.5 rounded-lg border border-border bg-card p-3" testID="screener-sender">
          <Text className="text-sm text-foreground" numberOfLines={1}>{s.name ? `${s.name} <${s.address}>` : s.address}</Text>
          <Text className="text-[11px] text-muted-foreground">
            {s.count} email{s.count === 1 ? '' : 's'}{s.lastAt ? ` · last ${formatWhen(s.lastAt)}` : ''}
          </Text>
          <View className="flex-row flex-wrap gap-1.5">
            {DECISIONS.map((d) => (
              <Pressable
                key={d.id}
                onPress={() => void decide(s.address, d.id)}
                accessibilityRole="button"
                className={cn(
                  'rounded-md border px-2.5 py-1',
                  d.id === 'block' ? 'border-destructive/40 active:bg-destructive/10' : d.id === 'allow' ? 'border-primary bg-primary/10' : 'border-border active:bg-muted',
                )}
              >
                <Text className={cn('text-xs font-medium', d.id === 'block' ? 'text-destructive' : d.id === 'allow' ? 'text-primary' : 'text-foreground')}>{d.label}</Text>
              </Pressable>
            ))}
          </View>
        </View>
      ))}
    </ScrollView>
  )
}

function Field({ label, value, onChangeText, multiline, testID }: { label: string; value: string; onChangeText: (v: string) => void; multiline?: boolean; testID?: string }) {
  return (
    <View className="gap-1">
      <Text className="text-xs font-medium text-muted-foreground">{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        multiline={multiline}
        accessibilityLabel={label}
        autoCapitalize={multiline || label === 'Subject' ? 'sentences' : 'none'}
        autoCorrect={!!multiline}
        testID={testID}
        className={cn('rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground', multiline && 'min-h-[160px]')}
        style={multiline ? { textAlignVertical: 'top' } : undefined}
      />
    </View>
  )
}

export function ComposeEmailSheet({
  workspaceId,
  mailbox,
  onClose,
  onSent,
}: {
  workspaceId: string
  mailbox: Mailbox
  onClose: () => void
  onSent?: (rootMessageId: string | null) => void
}) {
  const [to, setTo] = useState('')
  const [cc, setCc] = useState('')
  const [bcc, setBcc] = useState('')
  const [showCc, setShowCc] = useState(false)
  const [subject, setSubject] = useState('')
  const [text, setText] = useState(mailbox.signature ? `\n\n${mailbox.signature}` : '')
  const [sendAt, setSendAt] = useState<Date | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const recipients = parseAddressList(to)

  const send = async () => {
    if (busy) return
    if (!recipients.length) return setError('Add at least one recipient.')
    if (!subject.trim() && !text.trim()) return setError('Write a subject or a message.')
    setBusy(true)
    setError(null)
    try {
      const { thread } = await api.compose(workspaceId, mailbox.id, {
        to: recipients,
        cc: parseAddressList(cc),
        bcc: parseAddressList(bcc),
        subject: subject.trim(),
        text,
        ...(sendAt ? { sendAt: sendAt.toISOString() } : {}),
      })
      onSent?.(thread ? threadRootMessageId(thread) : null)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable className="flex-1 items-center justify-center bg-black/40 p-4" onPress={onClose} accessibilityLabel="Close">
        <Pressable className="max-h-[90%] w-full max-w-xl rounded-xl bg-card" onPress={() => {}} testID="compose-email">
          <View className="flex-row items-center border-b border-border px-4 py-3">
            <Text className="min-w-0 flex-1 text-base font-semibold text-foreground" numberOfLines={1}>
              New email from {mailbox.address}
            </Text>
            <Pressable onPress={onClose} accessibilityLabel="Close" className="rounded-md p-1 active:bg-muted">
              <X size={16} className="text-muted-foreground" />
            </Pressable>
          </View>
          <ScrollView contentContainerClassName="gap-3 p-4" keyboardShouldPersistTaps="handled">
            <Field label="To" value={to} onChangeText={setTo} testID="compose-to" />
            {showCc ? (
              <>
                <Field label="Cc" value={cc} onChangeText={setCc} />
                <Field label="Bcc" value={bcc} onChangeText={setBcc} />
              </>
            ) : (
              <Pressable onPress={() => setShowCc(true)} className="self-start">
                <Text className="text-xs text-primary">Add Cc / Bcc</Text>
              </Pressable>
            )}
            <Field label="Subject" value={subject} onChangeText={setSubject} testID="compose-subject" />
            <Field label="Message" value={text} onChangeText={setText} multiline testID="compose-body" />
            <View className="flex-row flex-wrap items-center gap-1.5">
              <Text className="text-xs text-muted-foreground">Send:</Text>
              {[{ label: 'Now', at: null as Date | null }, ...snoozeOptions().map((o) => ({ label: o.label, at: o.at as Date | null }))].map((o) => {
                const active = (sendAt?.getTime() ?? null) === (o.at?.getTime() ?? null)
                return (
                  <Pressable
                    key={o.label}
                    onPress={() => setSendAt(o.at)}
                    className={cn('rounded-full border px-2.5 py-1', active ? 'border-primary bg-primary/10' : 'border-border')}
                  >
                    <Text className={cn('text-xs', active ? 'text-primary' : 'text-foreground')}>{o.label}</Text>
                  </Pressable>
                )
              })}
            </View>
            <Text className="text-[11px] text-muted-foreground">You can undo for a few seconds after sending.</Text>
            {error ? <Text className="text-xs text-destructive" testID="compose-error">{error}</Text> : null}
          </ScrollView>
          <View className="flex-row justify-end gap-2 border-t border-border px-4 py-3">
            <Pressable onPress={onClose} className="rounded-md px-3 py-1.5 active:bg-muted">
              <Text className="text-sm text-foreground">Cancel</Text>
            </Pressable>
            <Pressable
              onPress={() => void send()}
              disabled={busy}
              accessibilityRole="button"
              className={cn('rounded-md bg-primary px-4 py-1.5 active:opacity-90', busy && 'opacity-60')}
              testID="compose-send"
            >
              <Text className="text-sm font-semibold text-primary-foreground">{sendAt ? 'Schedule' : 'Send'}</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  )
}
