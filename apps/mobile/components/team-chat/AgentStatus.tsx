// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * How an agent's routine updates show up in a channel: a status card it keeps
 * current in place, and runs of plain status posts folded into one row.
 */
import { useState } from 'react'
import { Linking, Pressable, Text, View } from 'react-native'
import { AlertTriangle, Check, ChevronDown, ChevronRight, Circle, ExternalLink, Loader2 } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { MarkdownText } from '../chat/MarkdownText'
import type { ChatMessage } from '../../lib/team-chat-api'
import { cardProgress, stepStates, type ApprovalCard, type CardStatus, type StatusCard } from '../../lib/team-chat-kinds'
import { AgentAvatar } from './AgentProfileCard'

const STATUS_LABEL: Record<CardStatus, string> = { working: 'In progress', blocked: 'Blocked', done: 'Done', failed: 'Failed' }
const STATUS_STYLE: Record<CardStatus, { bg: string; text: string }> = {
  working: { bg: 'bg-primary/10', text: 'text-primary' },
  blocked: { bg: 'bg-amber-500/15', text: 'text-amber-700 dark:text-amber-400' },
  done: { bg: 'bg-emerald-500/15', text: 'text-emerald-700 dark:text-emerald-400' },
  failed: { bg: 'bg-destructive/15', text: 'text-destructive' },
}

export function StatusCardView({ card, onOpenLink }: { card: StatusCard; onOpenLink?: (url: string) => boolean }) {
  const states = stepStates(card)
  const progress = Math.round(cardProgress(card) * 100)
  const pill = STATUS_STYLE[card.status]
  return (
    <View
      className={cn('mt-1 max-w-[520px] gap-2 rounded-lg border bg-card p-3', card.status === 'done' ? 'border-emerald-500/40' : card.status === 'failed' ? 'border-destructive/40' : 'border-border')}
      testID="status-card"
    >
      <View className="flex-row items-start justify-between gap-2">
        <Text className="min-w-0 flex-1 text-sm font-semibold text-foreground">{card.title}</Text>
        <View className={cn('rounded px-1.5 py-0.5', pill.bg)}>
          <Text className={cn('text-[10px] font-medium', pill.text)} testID="status-card-status">
            {STATUS_LABEL[card.status]}
          </Text>
        </View>
      </View>

      {card.steps?.length ? (
        <View className="gap-1">
          <View className="h-1 overflow-hidden rounded-full bg-muted" accessibilityRole="progressbar" accessibilityLabel={`${progress}% complete`}>
            <View className={cn('h-1 rounded-full', card.status === 'failed' ? 'bg-destructive' : card.status === 'done' ? 'bg-emerald-500' : 'bg-primary')} style={{ width: `${progress}%` }} />
          </View>
          {card.steps.map((step, i) => (
            <View key={`${i}-${step}`} className="flex-row items-center gap-2" testID={`status-step-${states[i]}`}>
              {states[i] === 'done' ? (
                <Check size={12} className="text-emerald-600" />
              ) : states[i] === 'current' ? (
                card.status === 'blocked' || card.status === 'failed'
                  ? <AlertTriangle size={12} className={card.status === 'failed' ? 'text-destructive' : 'text-amber-600'} />
                  : <Loader2 size={12} className="text-primary" />
              ) : (
                <Circle size={12} className="text-muted-foreground" />
              )}
              <Text className={cn('text-xs', states[i] === 'pending' ? 'text-muted-foreground' : 'text-foreground', states[i] === 'current' && 'font-medium')}>{step}</Text>
            </View>
          ))}
        </View>
      ) : null}

      {card.criteria?.length ? (
        <View>
          <Text className="text-[11px] font-semibold uppercase text-muted-foreground">Done when</Text>
          {card.criteria.map((c, i) => (
            <Text key={`${i}-${c}`} className="text-xs text-foreground">{`• ${c}`}</Text>
          ))}
        </View>
      ) : null}

      {card.links?.length ? (
        <View className="flex-row flex-wrap gap-2">
          {card.links.map((l) => (
            <Pressable
              key={l.url}
              onPress={() => { if (!onOpenLink?.(l.url)) void Linking.openURL(l.url) }}
              accessibilityRole="link"
              accessibilityLabel={l.label}
              className="flex-row items-center gap-1 rounded-md border border-border px-2 py-1 active:bg-muted"
            >
              <ExternalLink size={11} className="text-primary" />
              <Text className="text-xs font-medium text-primary" numberOfLines={1}>{l.label}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      {card.summary ? (
        <View testID="status-card-summary">
          <MarkdownText>{card.summary}</MarkdownText>
        </View>
      ) : null}
    </View>
  )
}

const APPROVAL_STATUS: Record<Exclude<ApprovalCard['status'], 'pending'>, { label: string; text: string }> = {
  approved: { label: 'Approved', text: 'text-emerald-700 dark:text-emerald-400' },
  denied: { label: 'Denied', text: 'text-destructive' },
  expired: { label: 'Not run: no answer in time', text: 'text-muted-foreground' },
}

function errorText(err: any): string {
  return err?.response?.data?.error?.message ?? err?.message ?? 'Could not send that answer'
}

/** An agent asking permission: Approve or Deny while open, who decided once it is closed. */
export function ApprovalCardView({
  approval,
  canDecide = true,
  onDecide,
}: {
  approval: ApprovalCard
  canDecide?: boolean
  onDecide: (decision: 'approve' | 'deny') => Promise<unknown>
}) {
  const [busy, setBusy] = useState<'approve' | 'deny' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const decide = async (decision: 'approve' | 'deny') => {
    if (busy) return
    setBusy(decision)
    setError(null)
    try {
      await onDecide(decision)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(null)
    }
  }
  const pending = approval.status === 'pending'
  const settled = approval.status === 'pending' ? null : APPROVAL_STATUS[approval.status]
  return (
    <View className={cn('mt-1 max-w-[520px] gap-2 rounded-lg border bg-card p-3', pending ? 'border-amber-500/50' : 'border-border')} testID="approval-card">
      <Text className="text-sm font-semibold text-foreground">{approval.summary}</Text>
      {approval.reason ? <Text className="text-xs text-muted-foreground">{approval.reason}</Text> : null}
      {pending ? (
        canDecide ? (
          <View className="flex-row gap-2">
            <Pressable
              onPress={() => void decide('approve')}
              disabled={!!busy}
              accessibilityRole="button"
              accessibilityLabel="Approve"
              className={cn('rounded-md bg-primary px-3 py-1.5', busy && 'opacity-60')}
            >
              <Text className="text-xs font-medium text-primary-foreground">{busy === 'approve' ? 'Approving…' : 'Approve'}</Text>
            </Pressable>
            <Pressable
              onPress={() => void decide('deny')}
              disabled={!!busy}
              accessibilityRole="button"
              accessibilityLabel="Deny"
              className={cn('rounded-md border border-border px-3 py-1.5 active:bg-muted', busy && 'opacity-60')}
            >
              <Text className="text-xs font-medium text-foreground">{busy === 'deny' ? 'Denying…' : 'Deny'}</Text>
            </Pressable>
          </View>
        ) : (
          <Text className="text-xs text-muted-foreground">Waiting for someone to decide</Text>
        )
      ) : (
        <Text className={cn('text-xs font-medium', settled!.text)} testID="approval-outcome">
          {approval.decidedBy ? `${settled!.label} by ${approval.decidedBy.name}` : settled!.label}
        </Text>
      )}
      {error ? <Text className="text-xs text-destructive" testID="approval-error">{error}</Text> : null}
    </View>
  )
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

/** One row standing in for several routine status posts; tap to see each. */
export function StatusRunRow({ latest, folded, onOpenThread }: { latest: ChatMessage; folded: ChatMessage[]; onOpenThread?: (m: ChatMessage) => void }) {
  const [open, setOpen] = useState(false)
  const all = [...folded, latest]
  const name = latest.authorAgent?.name ?? 'Agent'
  const Chevron = open ? ChevronDown : ChevronRight
  return (
    <View className="px-4 py-1" testID="status-run">
      <Pressable
        onPress={() => setOpen((v) => !v)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${name}: ${all.length} updates`}
        className="flex-row items-center gap-2 rounded-md py-1 active:bg-muted"
      >
        <AgentAvatar name={name} iconUrl={latest.authorAgent?.iconUrl} size={20} />
        <Chevron size={12} className="text-muted-foreground" />
        <Text className="text-xs font-medium text-muted-foreground">{`${name} · ${all.length} updates`}</Text>
        {!open ? <Text className="min-w-0 flex-1 text-xs text-muted-foreground" numberOfLines={1}>{latest.text}</Text> : null}
        <Text className="text-[11px] text-muted-foreground">{formatTime(latest.createdAt)}</Text>
      </Pressable>
      {open ? (
        <View className="ml-7 gap-0.5 border-l border-border pl-3">
          {all.map((m) => (
            <Pressable key={m.id} onPress={onOpenThread ? () => onOpenThread(m) : undefined} className="flex-row gap-2">
              <Text className="w-14 text-[11px] text-muted-foreground">{formatTime(m.createdAt)}</Text>
              <View className="min-w-0 flex-1"><MarkdownText>{m.text}</MarkdownText></View>
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  )
}
