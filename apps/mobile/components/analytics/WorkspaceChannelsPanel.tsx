// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * WorkspaceChannelsPanel
 *
 * Channels tab of the workspace Analytics screen: one row per channel with
 * messages, active members, agent @mentions and last activity for the selected
 * period, plus workspace totals on top.
 *
 * DMs are excluded server-side; channels bridged from Slack / Teams / Google
 * Chat are included and labelled with their provider. The endpoint is
 * owners/admins on a Business plan or higher, so a 403 renders an upgrade note
 * instead of a bare error.
 */

import { useEffect, useRef, useState } from 'react'
import { ActivityIndicator, ScrollView, View } from 'react-native'
import { AtSign, Hash, Lock, MessagesSquare, Users } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { useDomainHttp } from '../../contexts/domain'
import { useActiveWorkspace } from '../../hooks/useActiveWorkspace'
import { api } from '../../lib/api'
import { compactNumber, formatLastActive } from '../../lib/engagement-utils'
import { Text } from '../settings/account-sheet-chrome'
import { DateRangePills } from './DateRangePills'
import { StatCard, type AnalyticsPeriod } from './SharedAnalytics'

export interface ChannelBreakdownRow {
  conversationId: string
  name: string | null
  slug: string | null
  kind: string
  provider: string
  bridged: boolean
  messages: number
  humanMessages: number
  agentMessages: number
  bridgedMessages: number
  agentMentions: number
  activeMembers: number
  lastMessageAt: string | null
}

export interface ChannelBreakdown {
  workspaceId: string
  period?: string
  window: { from: string; to: string }
  totals: {
    channels: number
    activeUsers: number
    messages: number
    humanMessages: number
    agentMessages: number
    bridgedMessages: number
    agentMentions: number
    bridgedShare: number
    messagesPerActiveUser: number
  }
  channels: ChannelBreakdownRow[]
}

const PROVIDER_LABELS: Record<string, string> = {
  shogo: 'Native',
  slack: 'Slack',
  teams: 'Teams',
  google_chat: 'Google Chat',
}

const COLUMNS: { key: string; label: string; width: number; align?: 'right' }[] = [
  { key: 'channel', label: 'Channel', width: 210 },
  { key: 'messages', label: 'Messages', width: 84, align: 'right' },
  { key: 'activeMembers', label: 'Active members', width: 118, align: 'right' },
  { key: 'agentMentions', label: 'Agent mentions', width: 118, align: 'right' },
  { key: 'lastMessageAt', label: 'Last activity', width: 108, align: 'right' },
]

function Cell({ width, align, children }: { width: number; align?: 'right'; children: React.ReactNode }) {
  return (
    <View style={{ width }} className={cn('px-2', align === 'right' && 'items-end')}>
      {children}
    </View>
  )
}

/** Percentage as a whole number, so the totals strip reads "20%". */
function formatShare(share: number | null | undefined): string {
  if (typeof share !== 'number' || !Number.isFinite(share)) return '—'
  return `${Math.round(share * 100)}%`
}

export function WorkspaceChannelsPanel({ workspaceId }: { workspaceId?: string } = {}) {
  const http = useDomainHttp()
  const workspace = useActiveWorkspace()
  const activeWorkspaceId = workspaceId ?? workspace?.id

  const [period, setPeriod] = useState<AnalyticsPeriod>('7d')
  const [state, setState] = useState<{
    data: ChannelBreakdown | null
    loading: boolean
    error: string | null
    forbidden: boolean
  }>({ data: null, loading: true, error: null, forbidden: false })
  const latest = useRef(0)

  useEffect(() => {
    if (!activeWorkspaceId) return
    const requestId = ++latest.current
    setState((s) => ({ ...s, loading: true, error: null, forbidden: false }))
    api
      .getWorkspaceAnalytics<ChannelBreakdown>(http, activeWorkspaceId, 'channels', { period })
      .then((data) => {
        if (requestId === latest.current) {
          setState({ data, loading: false, error: null, forbidden: false })
        }
      })
      .catch((err: any) => {
        if (requestId !== latest.current) return
        setState({
          data: null,
          loading: false,
          error: err?.message || 'Could not load channel activity',
          forbidden: err?.status === 403,
        })
      })
  }, [http, activeWorkspaceId, period])

  if (!activeWorkspaceId) {
    return (
      <View className="py-12 items-center">
        <Text className="text-sm text-muted-foreground">No workspace selected</Text>
      </View>
    )
  }

  const header = (
    <View>
      <Text className="text-lg font-bold text-foreground mb-1">Channels</Text>
      <Text className="text-xs text-muted-foreground">
        Messages, people and agent mentions per channel. DMs are not included.
      </Text>
    </View>
  )

  if (state.forbidden) {
    return (
      <View className="gap-4">
        {header}
        <View className="rounded-xl border border-border bg-card p-4 flex-row items-center gap-3">
          <Lock size={16} className="text-muted-foreground" />
          <View className="flex-1">
            <Text className="text-sm font-semibold text-foreground">Channel activity</Text>
            <Text className="text-xs text-muted-foreground">
              Per-channel activity is available to workspace owners and admins on the Business plan or higher.
            </Text>
          </View>
        </View>
      </View>
    )
  }

  const totals = state.data?.totals
  const channels = state.data?.channels ?? []

  return (
    <View className="gap-4">
      {header}

      <DateRangePills value={period} onChange={setPeriod} />

      <View className="flex-row flex-wrap gap-2">
        <StatCard
          label="Active people"
          value={totals ? totals.activeUsers : undefined}
          icon={Users}
          subtitle={
            totals && totals.bridgedShare != null ? `${formatShare(totals.bridgedShare)} bridged` : undefined
          }
        />
        <StatCard
          label="Messages"
          value={totals ? compactNumber(totals.messages) : undefined}
          icon={MessagesSquare}
          subtitle={totals ? `${compactNumber(totals.agentMessages)} agent` : undefined}
        />
        <StatCard
          label="Agent mentions"
          value={totals ? compactNumber(totals.agentMentions) : undefined}
          icon={AtSign}
          subtitle={totals ? `${totals.channels} channels` : undefined}
        />
      </View>

      <View className="rounded-xl border border-border bg-card p-4">
        {!state.data ? (
          <View className="py-10 items-center justify-center gap-2">
            {state.loading ? (
              <ActivityIndicator />
            ) : (
              <Text className="text-sm text-muted-foreground">
                {state.error ?? 'Channel activity is unavailable right now'}
              </Text>
            )}
          </View>
        ) : channels.length === 0 ? (
          <View className="py-10 items-center justify-center gap-1">
            <Hash size={18} className="text-muted-foreground" />
            <Text className="text-sm font-medium text-foreground">No channels yet</Text>
            <Text className="text-xs text-muted-foreground text-center">
              Create a channel and its activity shows up here.
            </Text>
          </View>
        ) : (
          <ScrollView horizontal showsHorizontalScrollIndicator testID="channels-table">
            <View className={cn(state.loading && 'opacity-60')}>
              <View className="flex-row border-b border-border pb-1.5">
                {COLUMNS.map((col) => (
                  <Cell key={col.key} width={col.width} align={col.align}>
                    <Text className="text-[11px] font-medium text-muted-foreground">{col.label}</Text>
                  </Cell>
                ))}
              </View>

              {channels.map((channel) => {
                const label = channel.name ?? channel.slug ?? 'Untitled channel'
                return (
                  <View
                    key={channel.conversationId}
                    className="flex-row items-center py-2 border-b border-border/50"
                    testID={`channel-row-${channel.slug ?? channel.conversationId}`}
                  >
                    <Cell width={210}>
                      <View className="flex-row items-center gap-1.5">
                        {channel.kind === 'private' ? (
                          <Lock size={12} className="text-muted-foreground" />
                        ) : (
                          <Hash size={12} className="text-muted-foreground" />
                        )}
                        <Text className="text-xs font-medium text-foreground" numberOfLines={1}>
                          {label}
                        </Text>
                      </View>
                      <View
                        className={cn(
                          'self-start mt-1 rounded px-1.5 py-0.5',
                          channel.bridged ? 'bg-primary/10' : 'bg-muted',
                        )}
                      >
                        <Text
                          className={cn(
                            'text-[10px] font-medium',
                            channel.bridged ? 'text-primary' : 'text-muted-foreground',
                          )}
                        >
                          {PROVIDER_LABELS[channel.provider] ?? channel.provider}
                        </Text>
                      </View>
                    </Cell>
                    <Cell width={84} align="right">
                      <Text className="text-xs text-foreground">{compactNumber(channel.messages)}</Text>
                      {channel.bridgedMessages > 0 ? (
                        <Text className="text-[10px] text-muted-foreground">
                          {compactNumber(channel.bridgedMessages)} bridged
                        </Text>
                      ) : null}
                    </Cell>
                    <Cell width={118} align="right">
                      <Text className="text-xs text-foreground">{channel.activeMembers}</Text>
                    </Cell>
                    <Cell width={118} align="right">
                      <Text className="text-xs text-foreground">{compactNumber(channel.agentMentions)}</Text>
                    </Cell>
                    <Cell width={108} align="right">
                      <Text className="text-xs text-muted-foreground">
                        {formatLastActive(channel.lastMessageAt)}
                      </Text>
                    </Cell>
                  </View>
                )
              })}

              {totals ? (
                <View className="flex-row items-center pt-2" testID="channels-total">
                  <Cell width={210}>
                    <Text className="text-xs font-semibold text-foreground">
                      Workspace total ({totals.channels})
                    </Text>
                  </Cell>
                  <Cell width={84} align="right">
                    <Text className="text-xs font-semibold text-foreground">
                      {compactNumber(totals.messages)}
                    </Text>
                  </Cell>
                  <Cell width={118} align="right">
                    <Text className="text-xs font-semibold text-foreground">{totals.activeUsers}</Text>
                  </Cell>
                  <Cell width={118} align="right">
                    <Text className="text-xs font-semibold text-foreground">
                      {compactNumber(totals.agentMentions)}
                    </Text>
                  </Cell>
                  <Cell width={108} align="right">
                    <Text className="text-[10px] text-muted-foreground">{formatShare(totals.bridgedShare)} bridged</Text>
                  </Cell>
                </View>
              ) : null}
            </View>
          </ScrollView>
        )}
      </View>
    </View>
  )
}
