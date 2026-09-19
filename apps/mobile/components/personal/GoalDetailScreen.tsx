// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * One goal, in full: the plan the companion is following, its next
 * check-in, any pending "Needs your OK" approvals, deliverables it has
 * produced, and the event timeline behind all of that. This is the
 * detail view every goal row in `PersonalGoalsScreen` and every
 * `goal_event` activity row links to.
 */
import { useCallback, useState } from 'react'
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, Text, View } from 'react-native'
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router'
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
import { useDomainHttp } from '../../contexts/domain'
import { useActiveWorkspace } from '../../hooks/useActiveWorkspace'
import { setChatPrefill } from '../../hooks/useChatPrefill'
import { api, type PersonalGoal, type PersonalGoalEvent, type PersonalAgentTaskSummary } from '../../lib/api'
import { ArtifactCardList } from './ArtifactCard'

type GoalWithDetail = PersonalGoal & { events: PersonalGoalEvent[]; agentTasks: PersonalAgentTaskSummary[] }

export const GoalDetailScreen = observer(function GoalDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const router = useRouter()
  const http = useDomainHttp()
  const workspace = useActiveWorkspace()
  const [goal, setGoal] = useState<GoalWithDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [decidingEventId, setDecidingEventId] = useState<string | null>(null)

  const load = useCallback(async (refresh = false) => {
    if (!workspace?.id || !id) return
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
  }, [http, id, workspace?.id])

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
            ? { ...current, events: current.events.map((e) => (e.id === eventId ? updated : e)) }
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

  if (loading) {
    return (
      <View className="flex-1 items-center justify-center bg-background">
        <ActivityIndicator />
      </View>
    )
  }

  if (error || !goal) {
    return (
      <View className="flex-1 bg-background">
        <DetailHeader title="Goal" onBack={goBack} />
        <View className="flex-1 items-center justify-center px-6">
          <Text className="text-center text-sm text-destructive">{error || 'Goal not found'}</Text>
        </View>
      </View>
    )
  }

  const planSteps = parseGoalPlan(goal.plan)
  const deliverables = parseGoalDeliverables(goal.deliverables)
  const pendingEvents = goal.events.filter(isGoalEventApprovalPending)
  const timelineEvents = goal.events.filter((e) => !isGoalEventApprovalPending(e))

  return (
    <View className="flex-1 bg-background">
      <DetailHeader title={goal.title} onBack={goBack} />
      <ScrollView
        contentContainerClassName="mx-auto w-full max-w-2xl px-4 pb-10 pt-5"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void load(true)} />}
      >
        <View className="flex-row items-center gap-2">
          <GoalStatusBadge status={goal.status} />
          {goal.nextCheckInAt ? (
            <View className="flex-row items-center gap-1 rounded-full bg-muted px-2.5 py-1">
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

        {pendingEvents.length > 0 ? (
          <View className="mt-6 gap-2.5">
            <View className="flex-row items-center gap-1.5">
              <CircleAlert size={14} className="text-amber-500" />
              <Text className="text-xs font-semibold uppercase tracking-[1.5px] text-amber-600">
                Needs your OK
              </Text>
            </View>
            {pendingEvents.map((event) => (
              <View key={event.id} className="rounded-2xl border border-amber-500/30 bg-amber-500/5 p-4">
                <Pressable onPress={() => replyInChat(event.message, 'About')}>
                  <Text className="text-sm leading-5 text-foreground">{event.message}</Text>
                </Pressable>
                <View className="mt-3 flex-row items-center gap-2">
                  <Pressable
                    onPress={() => void decide(event.id, 'approved')}
                    disabled={decidingEventId === event.id}
                    className="flex-1 items-center rounded-xl bg-emerald-600 px-3 py-2 active:opacity-80 disabled:opacity-50"
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
                    className="flex-1 items-center rounded-xl border border-border bg-card px-3 py-2 active:opacity-80 disabled:opacity-50"
                  >
                    <Text className="text-sm font-semibold text-foreground">Decline</Text>
                  </Pressable>
                </View>
              </View>
            ))}
          </View>
        ) : null}

        {planSteps.length > 0 ? (
          <View className="mt-7">
            <SectionLabel icon={ListChecks} label="Plan" />
            <View className="mt-3 gap-2.5">
              {planSteps.map((step, i) => (
                <View key={i} className="flex-row items-start gap-2.5 rounded-xl border border-border bg-card p-3">
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
                      <Text className="mt-0.5 text-xs text-muted-foreground">{step.detail}</Text>
                    ) : null}
                  </View>
                </View>
              ))}
            </View>
          </View>
        ) : null}

        {deliverables.length > 0 ? (
          <View className="mt-7">
            <SectionLabel icon={Sparkles} label="Deliverables" />
            <View className="mt-3">
              <ArtifactCardList deliverables={deliverables} />
            </View>
          </View>
        ) : null}

        <View className="mt-7">
          <SectionLabel icon={Clock3} label="Timeline" />
          {timelineEvents.length === 0 ? (
            <Text className="mt-3 text-sm text-muted-foreground">No updates yet.</Text>
          ) : (
            <View className="mt-3 gap-2.5">
              {timelineEvents.map((event) => (
                <View key={event.id} className="rounded-xl border border-border bg-card p-3">
                  <View className="flex-row items-center gap-1.5">
                    {event.kind === 'blocker' ? (
                      <CircleAlert size={13} className="text-destructive" />
                    ) : (
                      <CircleDot size={13} className="text-muted-foreground" />
                    )}
                    <Text className="text-[11px] uppercase tracking-wide text-muted-foreground">
                      {event.kind}
                    </Text>
                  </View>
                  <Text className="mt-1.5 text-sm leading-5 text-foreground">{event.message}</Text>
                  <Text className="mt-1.5 text-xs text-muted-foreground">{formatDate(event.createdAt)}</Text>
                </View>
              ))}
            </View>
          )}
        </View>

        {goal.agentTasks.length > 0 ? (
          <View className="mt-7">
            <SectionLabel icon={Sparkles} label="Related work" />
            <View className="mt-3 gap-2.5">
              {goal.agentTasks.map((task) => (
                <View key={task.id} className="rounded-xl border border-border bg-card p-3">
                  <Text className="text-sm font-medium text-foreground">{task.title}</Text>
                  <Text className="mt-1 text-xs capitalize text-muted-foreground">
                    {task.status}
                    {task.currentStep ? ` · ${task.currentStep}` : ''}
                  </Text>
                </View>
              ))}
            </View>
          </View>
        ) : null}
      </ScrollView>
    </View>
  )
})

function DetailHeader({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <View className="flex-row items-center gap-2 border-b border-border px-4 py-4">
      <Pressable onPress={onBack} accessibilityLabel="Back" className="-ml-2 rounded-md p-2 active:bg-muted">
        <ArrowLeft size={22} className="text-foreground" />
      </Pressable>
      <Text className="flex-1 text-lg font-semibold text-foreground" numberOfLines={1}>
        {title}
      </Text>
    </View>
  )
}

function SectionLabel({ icon: Icon, label }: { icon: typeof ListChecks; label: string }) {
  return (
    <View className="flex-row items-center gap-1.5">
      <Icon size={14} className="text-muted-foreground" />
      <Text className="text-xs font-semibold uppercase tracking-[1.5px] text-muted-foreground">{label}</Text>
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
