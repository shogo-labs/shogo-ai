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
import { answerApproval } from '../../lib/approval-decision'
import { DrawnCheckmark } from '../ui/DrawnCheckmark'
import { GlassCard } from '../ui/GlassCard'
import { AgentAvatar } from './AgentAvatar'

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

const AMBER = '#f59e0b'

/**
 * An agent asking permission, in glass with an amber edge: the command in
 * monospace, then Approve or Deny. Once answered, a ring and tick draw
 * themselves; once closed, it says who decided. Approving asks for Face ID or
 * a fingerprint first when that is switched on in Settings.
 */
export function ApprovalCardView({
  approval,
  canDecide = true,
  onDecide,
  messageId,
}: {
  approval: ApprovalCard
  canDecide?: boolean
  onDecide: (decision: 'approve' | 'deny') => Promise<unknown>
  /** The card's message, so other lists (Home) drop it as soon as it is answered. */
  messageId?: string
}) {
  const [busy, setBusy] = useState<'approve' | 'deny' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState<'approve' | 'deny' | null>(null)
  const decide = async (decision: 'approve' | 'deny') => {
    if (busy) return
    setBusy(decision)
    setError(null)
    const outcome = await answerApproval(messageId ?? approval.requestId, decision, {
      biometricReason: `Approve: ${approval.summary}`,
      send: (_id, answer) => onDecide(answer),
    })
    if (outcome.ok) setSent(decision)
    else if (outcome.reason === 'failed') setError(outcome.message)
    setBusy(null)
  }
  const pending = approval.status === 'pending'
  const settled = approval.status === 'pending' ? null : APPROVAL_STATUS[approval.status]
  return (
    <GlassCard
      style={{ marginTop: 4, maxWidth: 520 }}
      radius={16}
      accent={pending ? `${AMBER}80` : undefined}
      tint={pending ? `${AMBER}1a` : undefined}
      testID="approval-card"
    >
      <View className="gap-2 p-3">
        {pending ? <Text className="text-xs font-semibold text-amber-600 dark:text-amber-400">Waiting for your OK</Text> : null}
        <Text className="rounded-lg bg-black/5 px-2.5 py-2 font-mono text-[13px] text-foreground dark:bg-white/10" selectable>
          {approval.summary}
        </Text>
        {approval.reason ? <Text className="text-xs text-muted-foreground">{approval.reason}</Text> : null}
        {pending ? (
          sent ? (
            <View className="flex-row items-center gap-2" testID="approval-sent">
              <DrawnCheckmark size={28} tone={sent === 'approve' ? 'success' : 'danger'} />
              <Text className={cn('text-sm font-medium', sent === 'approve' ? 'text-emerald-700 dark:text-emerald-400' : 'text-destructive')}>
                {sent === 'approve' ? 'Approved, sent to the agent' : 'Denied, sent to the agent'}
              </Text>
            </View>
          ) : canDecide ? (
            <View className="flex-row gap-2">
              <Pressable
                onPress={() => void decide('approve')}
                disabled={!!busy}
                accessibilityRole="button"
                accessibilityLabel="Approve"
                className={cn('rounded-lg bg-primary px-3.5 py-2', busy && 'opacity-60')}
              >
                <Text className="text-sm font-medium text-primary-foreground">{busy === 'approve' ? 'Approving…' : 'Approve'}</Text>
              </Pressable>
              <Pressable
                onPress={() => void decide('deny')}
                disabled={!!busy}
                accessibilityRole="button"
                accessibilityLabel="Deny"
                className={cn('rounded-lg border border-border px-3.5 py-2 active:bg-muted', busy && 'opacity-60')}
              >
                <Text className="text-sm font-medium text-foreground">{busy === 'deny' ? 'Denying…' : 'Deny'}</Text>
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
    </GlassCard>
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
        <AgentAvatar name={name} projectId={latest.authorAgent?.projectId ?? null} workspaceId={latest.workspaceId} iconUrl={latest.authorAgent?.iconUrl} size={20} />
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
