// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Hover card for a Running now row (web + desktop only).
 *
 * Wraps any running-row child. On web, mouse-entering the row for 350 ms
 * opens a fixed-position card portalled to <body>; it stays open while the
 * pointer is over either the row or the card, and closes on:
 *   - pointer leaving both areas (after 150 ms grace)
 *   - Escape key
 *   - scroll of a containing list
 *   - row unmount
 *   - peek returning null (turn ended)
 *
 * On native the component renders its children unchanged — no hover, no fetch.
 *
 * Uses the same DOM-pointer-event approach as MessageRow's ReactionTooltip
 * (not Pressable onHoverIn) so the Stop button inside the row still works.
 */
import { createElement, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Platform, Text, View } from 'react-native'
import type { ReactNode } from 'react'
import { cn } from '@shogo/shared-ui/primitives'
import { elapsedLabel } from '../../lib/activity-feed'
import type { ActiveChatTurn } from '../../lib/api'
import { useRunPeek } from '../../hooks/useRunPeek'

const OPEN_DELAY_MS = 350
const CLOSE_DELAY_MS = 150
const CARD_WIDTH = 320

/** What the card knows upfront from the row (shown before the fetch arrives). */
interface RowMeta {
  workspaceId: string | null | undefined
  chat: Pick<ActiveChatTurn, 'chatSessionId' | 'turnId' | 'startedAt' | 'agentName' | 'projectId' | 'projectName' | 'conversationName' | 'card'>
}

export function RunPeekHover({
  workspaceId,
  chat,
  children,
}: {
  workspaceId: string | null | undefined
  chat?: Pick<ActiveChatTurn, 'chatSessionId' | 'turnId' | 'startedAt' | 'agentName' | 'projectId' | 'projectName' | 'conversationName' | 'card'>
  children: ReactNode
}) {
  if (Platform.OS !== 'web' || !chat) return <>{children}</>
  return (
    <RunPeekHoverWeb workspaceId={workspaceId} chat={chat}>
      {children}
    </RunPeekHoverWeb>
  )
}

/**
 * Lightweight variant for rows that only know the chatSessionId (e.g. Home
 * AgentRowItem). Hover still fetches the peek; cache key uses session id only.
 */
export function RunPeekHoverById({
  workspaceId,
  chatSessionId,
  children,
}: {
  workspaceId: string | null | undefined
  chatSessionId: string | null | undefined
  children: ReactNode
}) {
  if (Platform.OS !== 'web' || !chatSessionId) return <>{children}</>
  const minimalChat = {
    chatSessionId,
    turnId: '',
    startedAt: '',
    agentName: undefined,
    projectId: null,
    projectName: null,
    conversationName: null,
    card: undefined,
  } as unknown as Pick<ActiveChatTurn, 'chatSessionId' | 'turnId' | 'startedAt' | 'agentName' | 'projectId' | 'projectName' | 'conversationName' | 'card'>
  return (
    <RunPeekHoverWeb workspaceId={workspaceId} chat={minimalChat}>
      {children}
    </RunPeekHoverWeb>
  )
}

function RunPeekHoverWeb({ workspaceId, chat, children }: { workspaceId: string | null | undefined; chat: RowMeta['chat']; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const [anchor, setAnchor] = useState<{ rowRight: number; rowTop: number; rowBottom: number } | null>(null)
  const openTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const rowRef = useRef<HTMLDivElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)

  const clear = (kind: 'open' | 'close' | 'both') => {
    if (kind !== 'close' && openTimerRef.current) {
      clearTimeout(openTimerRef.current)
      openTimerRef.current = null
    }
    if (kind !== 'open' && closeTimerRef.current) {
      clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
  }

  const scheduleOpen = (el: HTMLElement) => {
    clear('open')
    openTimerRef.current = setTimeout(() => {
      openTimerRef.current = null
      const rect = el.getBoundingClientRect()
      setAnchor({ rowRight: rect.right, rowTop: rect.top, rowBottom: rect.bottom })
      setOpen(true)
    }, OPEN_DELAY_MS)
  }

  const scheduleClose = () => {
    clear('close')
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = null
      setOpen(false)
      setAnchor(null)
    }, CLOSE_DELAY_MS)
  }

  const cancelClose = () => clear('close')

  // Close on Escape and on list scroll.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setOpen(false); setAnchor(null) }
    }
    const onScroll = (e: Event) => {
      if (cardRef.current?.contains(e.target as Node)) return
      setOpen(false)
      setAnchor(null)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScroll, { passive: true, capture: true })
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [open])

  useEffect(() => () => { clear('both') }, [])

  const peek = useRunPeek({
    open,
    workspaceId,
    chatSessionId: chat.chatSessionId,
    turnId: chat.turnId,
    onDone: () => { setOpen(false); setAnchor(null) },
  })

  const card = anchor && typeof document !== 'undefined'
    ? createPortal(
        createElement(
          'div',
          {
            ref: cardRef,
            'data-testid': 'run-peek-card',
            onMouseEnter: cancelClose,
            onMouseLeave: scheduleClose,
            style: {
              position: 'fixed',
              top: Math.min(
                Math.max(anchor.rowTop, 8),
                window.innerHeight - 8 - Math.min(400, window.innerHeight * 0.6),
              ),
              left: anchor.rowRight + 8 + CARD_WIDTH > window.innerWidth - 8
                ? anchor.rowRight - CARD_WIDTH - 8
                : anchor.rowRight + 8,
              width: CARD_WIDTH,
              maxHeight: '60vh',
              zIndex: 9999,
              overflowY: 'auto',
              borderRadius: 12,
              boxShadow: '0 4px 24px rgba(0,0,0,0.18)',
            },
          },
          <PeekCard chat={chat} peek={peek} />,
        ),
        document.body,
      )
    : null

  return createElement(
    'div',
    {
      ref: rowRef,
      onMouseEnter: (e: { currentTarget: HTMLElement }) => {
        clear('close')
        scheduleOpen(e.currentTarget)
      },
      onMouseLeave: () => {
        clear('open')
        scheduleClose()
      },
      style: { display: 'contents' },
    },
    children,
    card,
  )
}

function PeekCard({
  chat,
  peek,
}: {
  chat: RowMeta['chat']
  peek: ReturnType<typeof useRunPeek>
}) {
  const agentName = chat.agentName?.trim() || chat.projectName || 'Agent'
  const where = chat.conversationName
    ? `#${chat.conversationName}`
    : chat.projectName || 'Chat'

  return (
    <View className="rounded-xl border border-border bg-card p-3 shadow-lg">
      {/* Header: agent · where · elapsed */}
      <View className="flex-row flex-wrap items-center gap-1 pb-1.5">
        <Text className="text-xs font-medium text-muted-foreground">
          {agentName}
        </Text>
        <Text className="text-xs text-muted-foreground">·</Text>
        <Text className="text-xs text-muted-foreground">{where}</Text>
        <Text className="text-xs text-muted-foreground">·</Text>
        <ElapsedTick startedAt={chat.startedAt} />
      </View>

      {/* Full title */}
      {peek.status === 'ready'
        ? <Text className="text-sm font-semibold text-foreground pb-1">{peek.peek.title}</Text>
        : peek.status === 'loading'
          ? <View className="mb-1 h-4 w-3/4 rounded bg-muted" />
          : null}

      {/* Card chip */}
      {peek.status === 'ready' && peek.peek.card ? (
        <Text className="text-xs font-medium text-primary pb-1.5">
          {peek.peek.card.key} · {peek.peek.card.column}
        </Text>
      ) : null}

      {/* Privacy hidden */}
      {peek.status === 'hidden' ? (
        <Text className="text-xs italic text-muted-foreground pt-1">Private conversation</Text>
      ) : null}

      {/* Turn ended */}
      {peek.status === 'done' ? (
        <Text className="text-xs text-muted-foreground pt-1">Run ended</Text>
      ) : null}

      {/* Error */}
      {peek.status === 'error' ? (
        <Text className="text-xs text-destructive pt-1">{peek.message}</Text>
      ) : null}

      {/* Trigger ("Woke by") */}
      {peek.status === 'ready' && peek.peek.trigger ? (
        <TriggerBlock trigger={peek.peek.trigger} />
      ) : null}

      {/* Reply tail */}
      {peek.status === 'ready' && peek.peek.reply ? (
        <ReplyBlock reply={peek.peek.reply} />
      ) : null}

      {/* Skeleton second line while loading */}
      {peek.status === 'loading' ? (
        <View className="h-3 w-full rounded bg-muted mt-1" />
      ) : null}

      {/* Footer hint */}
      <Text className="pt-2 text-[10px] text-muted-foreground/60">Click to open · ■ to stop</Text>
    </View>
  )
}

function TriggerBlock({ trigger }: { trigger: NonNullable<import('../../lib/api').ActiveChatPeek['trigger']> }) {
  const ago = relativeTimestamp(trigger.createdAt)
  return (
    <View className="mt-1.5 rounded-lg bg-muted/50 px-2.5 py-2">
      <Text className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground pb-0.5">
        Woke by · {trigger.authorName}{ago ? ` · ${ago}` : ''}
      </Text>
      <Text className="text-xs text-foreground leading-5" numberOfLines={8}>{trigger.text}</Text>
    </View>
  )
}

function ReplyBlock({ reply }: { reply: NonNullable<import('../../lib/api').ActiveChatPeek['reply']> }) {
  if (!reply.text) return null
  return (
    <View className="mt-1.5 rounded-lg border border-primary/20 bg-primary/5 px-2.5 py-2">
      <Text className="text-[10px] font-semibold uppercase tracking-wider text-primary/60 pb-0.5">Replying</Text>
      <Text className="text-xs text-foreground leading-5" numberOfLines={6}>{reply.text}</Text>
    </View>
  )
}

function ElapsedTick({ startedAt }: { startedAt: string }) {
  const [label, setLabel] = useState(() => elapsedLabel(startedAt))
  useEffect(() => {
    const id = setInterval(() => setLabel(elapsedLabel(startedAt)), 10_000)
    return () => clearInterval(id)
  }, [startedAt])
  return <Text className="text-xs text-muted-foreground">{label}</Text>
}

function relativeTimestamp(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
}
