// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * In-app "Get started" checklist shown after the cloud onboarding wizard.
 *
 * Progress is server-derived (`GET /api/me/getting-started`) except for two
 * signals the server can't see: Composio integration connections (fetched
 * per workspace) and "visited your other space" (recorded per device).
 * Only shown to users who went through the destination-based onboarding
 * (`onboardingIntent` is set), so pre-existing accounts aren't nagged.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { Check, ChevronDown, ChevronRight, ChevronUp, X } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { useAuth } from '../../contexts/auth'
import { useDomainHttp, useWorkspaceCollection } from '../../contexts/domain'
import { usePostHogSafe } from '../../contexts/posthog'
import { useActiveWorkspace } from '../../hooks/useActiveWorkspace'
import { api, type GettingStartedProgress } from '../../lib/api'
import { EVENTS, trackEvent } from '../../lib/analytics'
import { usePlatformConfig } from '../../lib/platform-config'
import { openInWorkspace } from '../../lib/switch-workspace'

const DISMISSED_KEY = 'shogo:getting-started-dismissed:'
const SEEN_KINDS_KEY = 'shogo:getting-started-seen-kinds:'

type WorkspaceKind = 'personal' | 'team'

type ItemId = 'first-message' | 'first-agent' | 'connect-tool' | 'invite' | 'other-space'

export interface ChecklistItem {
  id: ItemId
  title: string
  description: string
  done: boolean
  onPress?: () => void
}

export interface GettingStartedState {
  visible: boolean
  items: ChecklistItem[]
  completedCount: number
  dismiss: () => void
}

function isActiveConnection(status: string | undefined): boolean {
  return (status ?? '').toUpperCase() === 'ACTIVE'
}

export function useGettingStarted(enabled = true): GettingStartedState {
  const router = useRouter()
  const posthog = usePostHogSafe()
  const { user } = useAuth()
  const http = useDomainHttp()
  const { localMode } = usePlatformConfig()
  const workspaces = useWorkspaceCollection()
  const current = useActiveWorkspace() as { id: string; kind?: WorkspaceKind } | null
  const kind: WorkspaceKind = current?.kind === 'personal' ? 'personal' : 'team'

  const [eligible, setEligible] = useState(false)
  const [dismissed, setDismissed] = useState(true)
  const [progress, setProgress] = useState<GettingStartedProgress | null>(null)
  const [hasConnection, setHasConnection] = useState(false)
  const [seenKinds, setSeenKinds] = useState<WorkspaceKind[]>([])

  const all = (workspaces?.all ?? []) as Array<{ id: string; kind?: WorkspaceKind }>
  const personalId = all.find((w) => w.kind === 'personal')?.id
  const teamId = all.find((w) => w.kind !== 'personal')?.id

  useEffect(() => {
    if (!enabled || localMode || !user?.id) return
    let cancelled = false
    ;(async () => {
      try {
        const [me, flag, seen] = await Promise.all([
          api.getMe(http),
          AsyncStorage.getItem(DISMISSED_KEY + user.id),
          AsyncStorage.getItem(SEEN_KINDS_KEY + user.id),
        ])
        if (cancelled) return
        setDismissed(flag === 'true')
        setEligible(!!me?.data?.onboardingIntent)
        setSeenKinds(seen ? (JSON.parse(seen) as WorkspaceKind[]) : [])
      } catch {
        // Non-fatal: the checklist just stays hidden.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [enabled, http, localMode, user?.id])

  // Record which kinds of workspace this user has opened.
  useEffect(() => {
    if (!user?.id || !current?.id || !eligible) return
    setSeenKinds((prev) => {
      if (prev.includes(kind)) return prev
      const next = [...prev, kind]
      AsyncStorage.setItem(SEEN_KINDS_KEY + user.id, JSON.stringify(next)).catch(() => {})
      return next
    })
  }, [current?.id, eligible, kind, user?.id])

  useEffect(() => {
    if (!eligible || dismissed || !current?.id) return
    let cancelled = false
    api
      .getGettingStarted(http)
      .then((p) => {
        if (!cancelled) setProgress(p)
      })
      .catch(() => {})
    api
      .getWorkspaceIntegrationConnections(http, current.id)
      .then((rows) => {
        if (!cancelled && rows.some((r) => isActiveConnection(r.status))) setHasConnection(true)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [current?.id, dismissed, eligible, http])

  const track = useCallback(
    (item: ItemId) => trackEvent(posthog, EVENTS.GETTING_STARTED_ITEM_CLICKED, { item, workspace_kind: kind }),
    [kind, posthog],
  )

  const items = useMemo<ChecklistItem[]>(() => {
    const go = (item: ItemId, workspaceId: string | undefined, path: string) => () => {
      track(item)
      openInWorkspace(router, workspaceId, path, current?.id)
    }
    const firstMessage: ChecklistItem = {
      id: 'first-message',
      title: 'Send your first message to your companion',
      description:
        kind === 'personal'
          ? 'Type below. Try "Help me plan my week."'
          : 'Your companion lives in your Personal space.',
      done: !!progress?.sentFirstMessage,
      onPress: kind === 'personal' ? undefined : go('first-message', personalId, '/'),
    }
    const firstAgent: ChecklistItem = {
      id: 'first-agent',
      title: 'Install or build your first agent',
      description: 'Pick one from the marketplace or describe what you want built.',
      done: !!progress?.installedAgent || !!progress?.createdProject,
      onPress: go('first-agent', teamId, '/(app)/marketplace'),
    }
    const connectTool: ChecklistItem = {
      id: 'connect-tool',
      title: 'Connect a tool',
      description: 'Gmail, Slack, GitHub, Notion and more.',
      done: !!progress?.connectedIntegration || hasConnection,
      onPress: go('connect-tool', current?.id, '/(app)/settings?tab=integrations'),
    }
    const invite: ChecklistItem = {
      id: 'invite',
      title: 'Invite a teammate',
      description: 'Build together in your Team workspace.',
      done: !!progress?.invitedTeammate,
      onPress: go('invite', teamId, `/(app)/settings?tab=people${teamId ? `&workspace=${teamId}` : ''}`),
    }
    const otherSpace: ChecklistItem =
      kind === 'personal'
        ? {
            id: 'other-space',
            title: 'Open your Team workspace',
            description: 'This is where you build projects and agents.',
            done: seenKinds.includes('team'),
            onPress: go('other-space', teamId, '/'),
          }
        : {
            id: 'other-space',
            title: 'Open your Personal space',
            description: 'A private companion that remembers your context.',
            done: seenKinds.includes('personal'),
            onPress: go('other-space', personalId, '/'),
          }
    return kind === 'personal'
      ? [firstMessage, otherSpace, connectTool, firstAgent, invite]
      : [firstAgent, invite, connectTool, otherSpace, firstMessage]
  }, [current?.id, hasConnection, kind, personalId, progress, router, seenKinds, teamId, track])

  const completedCount = items.filter((i) => i.done).length

  const dismiss = useCallback(() => {
    setDismissed(true)
    trackEvent(posthog, EVENTS.GETTING_STARTED_DISMISSED, { completed_count: completedCount })
    if (user?.id) AsyncStorage.setItem(DISMISSED_KEY + user.id, 'true').catch(() => {})
  }, [completedCount, posthog, user?.id])

  const visible =
    enabled && !localMode && eligible && !dismissed && !!progress && completedCount < items.length

  return { visible, items, completedCount, dismiss }
}

interface GetStartedChecklistProps {
  state: GettingStartedState
  className?: string
}

export function GetStartedChecklist({ state, className }: GetStartedChecklistProps) {
  const [expanded, setExpanded] = useState(true)
  if (!state.visible) return null
  const { items, completedCount, dismiss } = state
  const pct = Math.round((completedCount / items.length) * 100)

  return (
    <View className={cn('w-full overflow-hidden rounded-2xl border border-border bg-card', className)}>
      <View className="flex-row items-center gap-3 px-4 pb-3 pt-4">
        <Pressable
          className="min-w-0 flex-1"
          onPress={() => setExpanded((e) => !e)}
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          accessibilityLabel="Get started checklist"
        >
          <View className="flex-row items-center gap-2">
            <Text className="text-sm font-semibold text-foreground">Get started</Text>
            <Text className="text-xs text-muted-foreground">
              {completedCount} of {items.length}
            </Text>
            {expanded ? (
              <ChevronUp size={14} className="text-muted-foreground" />
            ) : (
              <ChevronDown size={14} className="text-muted-foreground" />
            )}
          </View>
          <View className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <View className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
          </View>
        </Pressable>
        <Pressable
          onPress={dismiss}
          accessibilityLabel="Dismiss get started checklist"
          className="h-7 w-7 items-center justify-center rounded-full active:bg-muted web:hover:bg-muted"
        >
          <X size={15} className="text-muted-foreground" />
        </Pressable>
      </View>
      {expanded ? (
        <View className="border-t border-border">
          {items.map((item, i) => (
            <Pressable
              key={item.id}
              onPress={item.done ? undefined : item.onPress}
              disabled={item.done || !item.onPress}
              accessibilityRole={item.onPress && !item.done ? 'button' : undefined}
              accessibilityState={{ checked: item.done }}
              className={cn(
                'flex-row items-center gap-3 px-4 py-3',
                i > 0 && 'border-t border-border',
                !item.done && item.onPress && 'active:bg-muted web:hover:bg-muted/50',
              )}
            >
              <View
                className={cn(
                  'h-5 w-5 items-center justify-center rounded-full border',
                  item.done ? 'border-primary bg-primary' : 'border-border',
                )}
              >
                {item.done ? <Check size={12} strokeWidth={3} className="text-primary-foreground" /> : null}
              </View>
              <View className="min-w-0 flex-1">
                <Text
                  className={cn(
                    'text-sm font-medium',
                    item.done ? 'text-muted-foreground line-through' : 'text-foreground',
                  )}
                >
                  {item.title}
                </Text>
                {!item.done ? (
                  <Text className="mt-0.5 text-xs text-muted-foreground">{item.description}</Text>
                ) : null}
              </View>
              {!item.done && item.onPress ? (
                <ChevronRight size={16} className="text-muted-foreground" />
              ) : null}
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  )
}
