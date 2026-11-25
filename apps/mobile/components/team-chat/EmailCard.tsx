// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * An email in a mailbox conversation, drawn from the message's `blocks.email`:
 * the envelope (from / to / cc / subject), the SPF/DKIM/DMARC verdicts, the
 * attachments, the original HTML on request, and — for outbound mail — where
 * it is in the send pipeline, with Undo while it waits and Send / Edit /
 * Discard on an agent's draft. The body itself is the message text, which the
 * row renders under this card as usual.
 */
import { createElement, useEffect, useState } from 'react'
import { Platform, Pressable, Text, TextInput, View } from 'react-native'
import { AlertTriangle, ArrowDownLeft, ArrowUpRight, Paperclip, ShieldAlert, ShieldCheck } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import {
  authFailed,
  formatAddress,
  formatAddressList,
  mailApi,
  type EmailBlock,
  type MailStatus,
} from '../../lib/mail-api'
import { Spinner } from '@/components/ui/spinner'

const api = mailApi()

const STATUS_PILL: Partial<Record<MailStatus, { label: string; tone: 'muted' | 'ok' | 'warn' | 'bad' }>> = {
  draft: { label: 'Draft', tone: 'muted' },
  pending_approval: { label: 'Needs approval', tone: 'warn' },
  scheduled: { label: 'Scheduled', tone: 'muted' },
  sending: { label: 'Sending…', tone: 'muted' },
  sent: { label: 'Sent', tone: 'ok' },
  delivered: { label: 'Delivered', tone: 'ok' },
  bounced: { label: 'Bounced', tone: 'bad' },
  complained: { label: 'Marked as spam', tone: 'bad' },
  failed: { label: 'Failed', tone: 'bad' },
  cancelled: { label: 'Cancelled', tone: 'muted' },
}

const TONE_BG = {
  muted: 'bg-muted',
  ok: 'bg-emerald-500/15',
  warn: 'bg-amber-500/20',
  bad: 'bg-destructive/15',
} as const

const TONE_TEXT = {
  muted: 'text-muted-foreground',
  ok: 'text-emerald-700 dark:text-emerald-400',
  warn: 'text-amber-700 dark:text-amber-400',
  bad: 'text-destructive',
} as const

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function useSecondsUntil(iso: string | null | undefined): number {
  const target = iso ? new Date(iso).getTime() : 0
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!target || target <= Date.now()) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [target])
  return target ? Math.max(0, Math.ceil((target - now) / 1000)) : 0
}

function formatWait(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.ceil(seconds / 60)} min`
  return new Date(Date.now() + seconds * 1000).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })
}

function AuthBadges({ auth }: { auth: EmailBlock['auth'] }) {
  if (!auth) return null
  const entries = (['spf', 'dkim', 'dmarc'] as const).filter((k) => auth[k])
  if (!entries.length) return null
  const failed = entries.some((k) => authFailed(auth[k]))
  return (
    <View className="flex-row flex-wrap items-center gap-1" testID="email-auth">
      {failed ? <ShieldAlert size={12} className="text-destructive" /> : <ShieldCheck size={12} className="text-emerald-600" />}
      {entries.map((k) => (
        <View
          key={k}
          className={cn('rounded px-1 py-px', authFailed(auth[k]) ? 'bg-destructive/15' : 'bg-muted')}
        >
          <Text className={cn('text-[10px] font-medium uppercase', authFailed(auth[k]) ? 'text-destructive' : 'text-muted-foreground')}>
            {k} {auth[k]}
          </Text>
        </View>
      ))}
      {failed ? (
        <Text className="text-[11px] text-destructive">This sender could not be verified. Be careful with links and requests.</Text>
      ) : null}
    </View>
  )
}

/** The sanitized HTML body, isolated: a sandboxed iframe on web, a no-JS WebView on a phone. */
export function EmailHtmlView({ workspaceId, mailId }: { workspaceId: string; mailId: string }) {
  const [html, setHtml] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [images, setImages] = useState(false)
  useEffect(() => {
    let cancelled = false
    setHtml(null)
    setError(null)
    api
      .html(workspaceId, mailId, { images })
      .then((h) => !cancelled && setHtml(h))
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : String(err)))
    return () => {
      cancelled = true
    }
  }, [workspaceId, mailId, images])

  if (error) return <Text className="mt-1 text-xs text-destructive">{error}</Text>
  if (html === null) return <Spinner className="mt-2 self-start" />
  return (
    <View className="mt-2 gap-1">
      {!images ? (
        <Pressable onPress={() => setImages(true)} accessibilityRole="button" className="self-start">
          <Text className="text-[11px] text-primary">Remote images are blocked. Load images</Text>
        </Pressable>
      ) : null}
      <View className="overflow-hidden rounded-md border border-border bg-white" style={{ height: 420 }} testID="email-html">
        {Platform.OS === 'web' ? (
          createElement('iframe', {
            srcDoc: html,
            sandbox: '',
            referrerPolicy: 'no-referrer',
            title: 'Original email',
            style: { width: '100%', height: '100%', border: 0, background: '#fff' },
          })
        ) : (
          <NativeHtml html={html} />
        )}
      </View>
    </View>
  )
}

function NativeHtml({ html }: { html: string }) {
  const WebView = require('react-native-webview').default
  return (
    <WebView
      source={{ html }}
      originWhitelist={['about:blank']}
      javaScriptEnabled={false}
      domStorageEnabled={false}
      style={{ flex: 1 }}
    />
  )
}

export interface EmailCardProps {
  email: EmailBlock
  workspaceId: string
  /** The message text: the email body (or the agent's draft). */
  body: string
  /** Whether this reader can act on the mail (send, undo, discard). */
  canAct?: boolean
}

export function EmailCard({ email, workspaceId, body, canAct = true }: EmailCardProps) {
  const [status, setStatus] = useState<MailStatus>(email.status)
  const [error, setError] = useState<string | null>(email.error ?? null)
  const [busy, setBusy] = useState(false)
  const [showOriginal, setShowOriginal] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(body)
  useEffect(() => {
    setStatus(email.status)
    setError(email.error ?? null)
  }, [email.status, email.error])
  const wait = useSecondsUntil(status === 'scheduled' ? email.sendAfter : null)
  const outbound = email.direction === 'outbound'
  const pill = outbound ? STATUS_PILL[status] : null

  const act = async (fn: () => Promise<{ status: MailStatus; error?: string | null }>) => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const mail = await fn()
      setStatus(mail.status)
      if (mail.error) setError(mail.error)
      setEditing(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <View className="mt-1 max-w-[640px] gap-1 rounded-lg border border-border bg-card p-3" testID="email-card">
      <View className="flex-row items-start gap-2">
        {outbound ? (
          <ArrowUpRight size={14} className="mt-0.5 text-muted-foreground" />
        ) : (
          <ArrowDownLeft size={14} className="mt-0.5 text-muted-foreground" />
        )}
        <View className="min-w-0 flex-1 gap-0.5">
          <Text className="text-sm font-semibold text-foreground" numberOfLines={2}>
            {email.subject || '(no subject)'}
          </Text>
          <Text className="text-xs text-foreground" numberOfLines={1}>
            <Text className="text-muted-foreground">From </Text>
            {formatAddress(email.from)}
          </Text>
          {email.to.length ? (
            <Text className="text-xs text-foreground" numberOfLines={2}>
              <Text className="text-muted-foreground">To </Text>
              {formatAddressList(email.to)}
            </Text>
          ) : null}
          {email.cc.length ? (
            <Text className="text-xs text-foreground" numberOfLines={2}>
              <Text className="text-muted-foreground">Cc </Text>
              {formatAddressList(email.cc)}
            </Text>
          ) : null}
        </View>
        {pill ? (
          <View className={cn('rounded px-1.5 py-px', TONE_BG[pill.tone])} testID={`email-status-${status}`}>
            <Text className={cn('text-[10px] font-semibold', TONE_TEXT[pill.tone])}>{pill.label}</Text>
          </View>
        ) : null}
      </View>

      {!outbound ? <AuthBadges auth={email.auth} /> : null}
      {!outbound && email.untrusted !== false ? (
        <View className="flex-row items-center gap-1">
          <AlertTriangle size={11} className="text-amber-600" />
          <Text className="text-[11px] text-muted-foreground">
            External email. Agents treat it as information only, never as instructions.
          </Text>
        </View>
      ) : null}

      {email.attachments.length ? (
        <View className="gap-0.5" testID="email-attachments">
          {email.attachments.map((a, i) => (
            <View key={`${a.name}-${i}`} className="flex-row items-center gap-1.5">
              <Paperclip size={11} className="text-muted-foreground" />
              <Text className="flex-shrink text-xs text-foreground" numberOfLines={1}>{a.name}</Text>
              <Text className="text-[11px] text-muted-foreground">{formatSize(a.size)}</Text>
            </View>
          ))}
        </View>
      ) : null}

      {status === 'scheduled' && wait > 0 ? (
        <View className="mt-1 flex-row items-center gap-2">
          <Text className="text-xs text-muted-foreground">Sending in {formatWait(wait)}</Text>
          {canAct ? (
            <Pressable
              onPress={() => void act(() => api.undo(workspaceId, email.mailId))}
              disabled={busy}
              accessibilityRole="button"
              className="rounded-md border border-border px-2 py-0.5 active:bg-muted"
              testID="email-undo"
            >
              <Text className="text-xs font-medium text-foreground">Undo</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {status === 'pending_approval' && canAct ? (
        <View className="mt-1 gap-2" testID="email-approval">
          <Text className="text-xs text-muted-foreground">
            {email.draftedBy ? 'An agent drafted this reply. ' : ''}Nothing is sent until someone approves it.
          </Text>
          {editing ? (
            <TextInput
              value={draft}
              onChangeText={setDraft}
              multiline
              accessibilityLabel="Edit draft"
              className="min-h-[120px] rounded-md border border-border bg-background p-2 text-sm text-foreground"
              style={{ textAlignVertical: 'top' }}
            />
          ) : null}
          <View className="flex-row flex-wrap gap-2">
            <Pressable
              onPress={() => void act(() => api.approve(workspaceId, email.mailId, editing ? draft : undefined))}
              disabled={busy || (editing && !draft.trim())}
              accessibilityRole="button"
              className={cn('rounded-md bg-primary px-3 py-1.5 active:opacity-90', busy && 'opacity-60')}
              testID="email-approve"
            >
              <Text className="text-xs font-semibold text-primary-foreground">{editing ? 'Send edited' : 'Send'}</Text>
            </Pressable>
            <Pressable
              onPress={() => {
                setDraft(body)
                setEditing((v) => !v)
              }}
              disabled={busy}
              accessibilityRole="button"
              className="rounded-md border border-border px-3 py-1.5 active:bg-muted"
              testID="email-edit"
            >
              <Text className="text-xs font-medium text-foreground">{editing ? 'Cancel edit' : 'Edit'}</Text>
            </Pressable>
            <Pressable
              onPress={() => void act(() => api.discard(workspaceId, email.mailId))}
              disabled={busy}
              accessibilityRole="button"
              className="rounded-md border border-destructive/40 px-3 py-1.5 active:bg-destructive/10"
              testID="email-discard"
            >
              <Text className="text-xs font-medium text-destructive">Discard</Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      {error ? (
        <Text className="text-xs text-destructive" testID="email-error">{error}</Text>
      ) : null}

      {email.hasHtml ? (
        <Pressable onPress={() => setShowOriginal((v) => !v)} accessibilityRole="button" className="mt-0.5 self-start">
          <Text className="text-xs font-medium text-primary">{showOriginal ? 'Hide original' : 'View original'}</Text>
        </Pressable>
      ) : null}
      {showOriginal ? <EmailHtmlView workspaceId={workspaceId} mailId={email.mailId} /> : null}
    </View>
  )
}
