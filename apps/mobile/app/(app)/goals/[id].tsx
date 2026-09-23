// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useCallback, useState } from 'react'
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, Text, View, useWindowDimensions } from 'react-native'
import { Redirect, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router'
import { observer } from 'mobx-react-lite'
import {
  ArrowLeft,
  Bell,
  CheckCircle2,
  CircleAlert,
  CircleDot,
  Clock3,
  ListChecks,
  PauseCircle,
  Sparkles,
} from 'lucide-react-native'
import { isGoalEventApprovalPending, parseGoalDeliverables, parseGoalPlan } from '@shogo/shared-app'
import { ArtifactCardList } from '../../../components/personal/ArtifactCard'
import { useDomainHttp } from '../../../contexts/domain'
import { useActiveWorkspace } from '../../../hooks/useActiveWorkspace'
import { useWorkspaceExperience } from '../../../hooks/useWorkspaceExperience'
import { setChatPrefill } from '../../../hooks/useChatPrefill'
import { api, type PersonalGoal, type PersonalGoalEvent, type PersonalAgentTaskSummary } from '../../../lib/api'

type GoalWithDetail = PersonalGoal & { events: PersonalGoalEvent[]; agentTasks: PersonalAgentTaskSummary[] }

const GoalDetailPage = observer(function GoalDetailPage() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const router = useRouter()
  const http = useDomainHttp()
  const workspace = useActiveWorkspace()
  const experience = useWorkspaceExperience()
  const { width } = useWindowDimensions()
  const isWide = width >= 768
  const [goal, setGoal] = useState<GoalWithDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [decidingEventId, setDecidingEventId] = useState<string | null>(null)

  const load = useCallback(async (refresh = false) => {
    if (!workspace?.id || !id || experience.kind !== 'personal') return
    if (refresh) setRefreshing(true)
    try {
      setError(null)
      const result = await api.getGoal(http, workspace.id, id)
      if (!result) {
        setError('This goal could not be found.')
        setGoal(null)
        return
      }
      setGoal(result)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load this goal')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [experience.kind, http, id, workspace?.id])

  useFocusEffect(useCallback(() => {
    void load()
  }, [load]))

  const decide = useCallback(
    async (eventId: string, decision: 'approved' | 'declined') => {
      if (!workspace?.id || !id || decidingEventId) return
      setDecidingEventId(eventId)
      try {
        const updated = await api.resolveGoalApproval(http, workspace.id, id, eventId, decision)
        setGoal((current) =>
          current
            ? { ...current, events: current.events.map((event) => (event.id === eventId ? updated : event)) }
            : current,
        )
      } catch {
        // Leave the pending state so the user can retry.
      } finally {
        setDecidingEventId(null)
      }
    },
    [decidingEventId, http, id, workspace?.id],
  )

  const replyInChat = useCallback((message: string | undefined | null, prefix: string) => {
    const context = message ? `"${message}"` : 'this'
    setChatPrefill(`${prefix} ${context} — `)
    router.push('/(app)' as any)
  }, [router])

  const goBack = useCallback(() => {
    if (router.canGoBack()) router.back()
    else router.replace('/(app)/goals' as any)
  }, [router])

  const contentWidth = isWide ? 760 : undefined

  // A team workspace may reach this deep link from browser history, but
  // goals belong to the personal workspace experience only.
  if (workspace?.id && experience.kind !== 'personal') {
    return <Redirect href="/(app)" />
  }

  if (loading) {
    return (
      <View className="flex-1 bg-background">
        <DetailHeader title="Goal" onBack={goBack} contentWidth={contentWidth} isWide={isWide} />
        <View className="flex-1 items-center justify-center"><ActivityIndicator /></View>
      </View>
    )
  }

  if (error || !goal) {
    return (
      <View className="flex-1 bg-background">
        <DetailHeader title="Goal" onBack={goBack} contentWidth={contentWidth} isWide={isWide} />
        <View className="flex-1 items-center justify-center px-6">
          <View className="w-full max-w-md rounded-2xl border border-destructive/30 bg-destructive/5 px-4 py-4">
            <Text className="text-center text-sm leading-5 text-destructive">{error || 'Goal not found'}</Text>
          </View>
        </View>
      </View>
    )
  }

  const planSteps = parseGoalPlan(goal.plan)
  const deliverables = parseGoalDeliverables(goal.deliverables)
  const pendingEvents = goal.events.filter(isGoalEventApprovalPending)
  const timelineEvents = goal.events.filter((event) => !isGoalEventApprovalPending(event))

  return (
    <View className="flex-1 bg-background">
      <DetailHeader title={goal.title} onBack={goBack} contentWidth={contentWidth} isWide={isWide} />
      <ScrollView
        className="flex-1"
        contentContainerStyle={{ paddingBottom: isWide ? 52 : 128 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void load(true)} />}
      >
        <View
          className="mx-auto w-full pt-5"
          style={{ maxWidth: contentWidth, paddingHorizontal: isWide ? 32 : 16 }}
        >
          <View className="rounded-3xl border border-border/70 bg-card/60 p-4">
            <View className="flex-row flex-wrap items-center gap-2">
              <GoalStatusBadge status={goal.status} />
              {goal.nextCheckInAt ? (
                <View className="flex-row items-center gap-1 rounded-full border border-border/70 bg-background px-2.5 py-1">
                  <Bell size={11} className="text-muted-foreground" />
                  <Text className="text-xs text-muted-foreground">
                    Next check-in {formatDate(goal.nextCheckInAt)}
                  </Text>
                </View>
              ) : null}
            </View>
            {goal.why ? (
              <Text className="mt-3 text-sm leading-5 text-muted-foreground">{goal.why}</Text>
            ) : null}
          </View>

          {pendingEvents.length > 0 ? (
            <View className="mt-7">
              <SectionLabel icon={CircleAlert} label="Needs your OK" tone="amber" />
              <View className="mt-3 gap-2.5">
                {pendingEvents.map((event) => (
                  <View key={event.id} className="rounded-3xl border border-amber-500/30 bg-amber-500/5 p-4">
                    <Pressable onPress={() => replyInChat(event.message, 'About')}>
                      <Text className="text-sm leading-5 text-foreground">{event.message}</Text>
                    </Pressable>
                    <View className="mt-4 flex-row items-center gap-2">
                      <Pressable
                        onPress={() => void decide(event.id, 'approved')}
                        disabled={decidingEventId === event.id}
                        className="flex-1 items-center rounded-xl bg-emerald-600 px-3 py-2.5 active:opacity-80 disabled:opacity-50"
                      >
                        {decidingEventId === event.id ? (
                          <ActivityIndicator size="small" color="#fff" />
                        ) : (
                          <Text className="text-sm font-semibold text-white">Approve</Text>
                        )}
                      </Pressable>
                      <Pressable
                        onPress={() => void decide(event.id, 'declined')}
                        disabled={decidingEventId === event.id}
                        className="flex-1 items-center rounded-xl border border-border bg-card px-3 py-2.5 active:opacity-80 disabled:opacity-50"
                      >
                        <Text className="text-sm font-semibold text-foreground">Decline</Text>
                      </Pressable>
                    </View>
                  </View>
                ))}
              </View>
            </View>
          ) : null}

          {planSteps.length > 0 ? (
            <View className="mt-8">
              <SectionLabel icon={ListChecks} label="Plan" />
              <View className="mt-3 overflow-hidden rounded-3xl border border-border/70 bg-card/70">
                {planSteps.map((step, index) => (
                  <View key={index} className="px-4 py-3.5">
                    <View className="flex-row items-start gap-3">
                      {step.done ? (
                        <CheckCircle2 size={17} className="mt-0.5 text-emerald-500" />
                      ) : (
                        <View className="mt-0.5 h-[17px] w-[17px] items-center justify-center rounded-full border-2 border-border" />
                      )}
                      <View className="min-w-0 flex-1">
                        <Text className={step.done ? 'text-sm text-muted-foreground line-through' : 'text-sm text-foreground'}>
                          {step.title}
                        </Text>
                        {step.detail ? (
                          <Text className="mt-0.5 text-xs leading-4 text-muted-foreground">{step.detail}</Text>
                        ) : null}
                      </View>
                    </View>
                    {index < planSteps.length - 1 ? <View className="ml-7 mt-3.5 h-px bg-border/70" /> : null}
                  </View>
                ))}
              </View>
            </View>
          ) : null}

          {deliverables.length > 0 ? (
            <View className="mt-8">
              <SectionLabel icon={Sparkles} label="Deliverables" />
              <View className="mt-3">
                <ArtifactCardList deliverables={deliverables} />
              </View>
            </View>
          ) : null}

          <View className="mt-8">
            <SectionLabel icon={Clock3} label="Timeline" />
            {timelineEvents.length === 0 ? (
              <View className="mt-3 rounded-2xl border border-dashed border-border/80 px-4 py-5">
                <Text className="text-sm text-muted-foreground">No updates yet.</Text>
              </View>
            ) : (
              <View className="mt-3 gap-2.5">
                {timelineEvents.map((event) => (
                  <View key={event.id} className="rounded-2xl border border-border/70 bg-card/70 p-3.5">
                    <View className="flex-row items-center gap-1.5">
                      {event.kind === 'blocker' ? (
                        <CircleAlert size={13} className="text-destructive" />
                      ) : (
                        <CircleDot size={13} className="text-muted-foreground" />
                      )}
                      <Text className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                        {event.kind}
                      </Text>
                    </View>
                    <Text className="mt-2 text-sm leading-5 text-foreground">{event.message}</Text>
                    <Text className="mt-2 text-xs text-muted-foreground">{formatDate(event.createdAt)}</Text>
                  </View>
                ))}
              </View>
            )}
          </View>

          {goal.agentTasks.length > 0 ? (
            <View className="mt-8">
              <SectionLabel icon={Sparkles} label="Related work" />
              <View className="mt-3 overflow-hidden rounded-3xl border border-border/70 bg-card/70">
                {goal.agentTasks.map((task, index) => (
                  <View key={task.id} className="px-4 py-3.5">
                    <Text className="text-sm font-medium text-foreground">{task.title}</Text>
                    <Text className="mt-1 text-xs capitalize text-muted-foreground">
                      {task.status}
                      {task.currentStep ? ` · ${task.currentStep}` : ''}
                    </Text>
                    {index < goal.agentTasks.length - 1 ? <View className="mt-3.5 h-px bg-border/70" /> : null}
                  </View>
                ))}
              </View>
            </View>
          ) : null}
        </View>
      </ScrollView>
    </View>
  )
})

function DetailHeader({
  title,
  onBack,
  contentWidth,
  isWide,
}: {
  title: string
  onBack: () => void
  contentWidth?: number
  isWide: boolean
}) {
  return (
    <View className="border-b border-border/70 bg-card/80">
      <View
        className="mx-auto w-full flex-row items-center gap-2 py-3"
        style={{ maxWidth: contentWidth, paddingHorizontal: isWide ? 32 : 12 }}
      >
        <Pressable onPress={onBack} accessibilityLabel="Back" className="rounded-xl p-2 active:bg-muted">
          <ArrowLeft size={20} className="text-foreground" />
        </Pressable>
        <View className="min-w-0 flex-1">
          <Text className="text-[11px] font-medium uppercase tracking-[1.3px] text-muted-foreground">Goal</Text>
          <Text className="mt-0.5 text-base font-semibold text-foreground" numberOfLines={1}>
            {title}
          </Text>
        </View>
      </View>
    </View>
  )
}

function SectionLabel({
  icon: Icon,
  label,
  tone = 'default',
}: {
  icon: typeof ListChecks
  label: string
  tone?: 'default' | 'amber'
}) {
  const iconClass = tone === 'amber' ? 'text-amber-500' : 'text-muted-foreground'
  const textClass = tone === 'amber' ? 'text-amber-600' : 'text-muted-foreground'

  return (
    <View className="flex-row items-center gap-1.5">
      <Icon size={14} className={iconClass} />
      <Text className={`text-xs font-semibold uppercase tracking-[1.5px] ${textClass}`}>{label}</Text>
    </View>
  )
}

function GoalStatusBadge({ status }: { status: PersonalGoal['status'] }) {
  if (status === 'done') {
    return (
      <View className="flex-row items-center gap-1 rounded-full bg-emerald-500/10 px-2.5 py-1">
        <CheckCircle2 size={12} className="text-emerald-500" />
        <Text className="text-xs font-medium text-emerald-600">Done</Text>
      </View>
    )
  }
  if (status === 'paused') {
    return (
      <View className="flex-row items-center gap-1 rounded-full bg-muted px-2.5 py-1">
        <PauseCircle size={12} className="text-muted-foreground" />
        <Text className="text-xs font-medium text-muted-foreground">Paused</Text>
      </View>
    )
  }
  return (
    <View className="flex-row items-center gap-1 rounded-full bg-primary/10 px-2.5 py-1">
      <CircleDot size={12} className="text-primary" />
      <Text className="text-xs font-medium text-primary">Active</Text>
    </View>
  )
}

function formatDate(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'recently'
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

export default GoalDetailPage
