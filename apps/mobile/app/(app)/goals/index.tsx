// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useCallback, useMemo, useState } from 'react'
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, Text, View, useWindowDimensions } from 'react-native'
import { Redirect, useFocusEffect, useRouter } from 'expo-router'
import { observer } from 'mobx-react-lite'
import { CheckCircle2, ChevronRight, CircleDot, PauseCircle, Target } from 'lucide-react-native'
import { isApprovalPending } from '@shogo/shared-app'
import { NeedsYourOkSection } from '../../../components/personal/NeedsYourOkSection'
import { useDomainHttp } from '../../../contexts/domain'
import { useActiveWorkspace } from '../../../hooks/useActiveWorkspace'
import { useWorkspaceExperience } from '../../../hooks/useWorkspaceExperience'
import { api, type PersonalGoal, type PersonalWorkspaceActivity } from '../../../lib/api'

function GoalStatusIcon({ status }: { status: PersonalGoal['status'] }) {
  if (status === 'done') return <CheckCircle2 size={18} className="text-emerald-500" />
  if (status === 'paused') return <PauseCircle size={18} className="text-muted-foreground" />
  return <CircleDot size={18} className="text-primary" />
}

const GoalsPage = observer(function GoalsPage() {
  const http = useDomainHttp()
  const router = useRouter()
  const workspace = useActiveWorkspace()
  const experience = useWorkspaceExperience()
  const { width } = useWindowDimensions()
  const isWide = width >= 768
  const [goals, setGoals] = useState<PersonalGoal[]>([])
  const [activity, setActivity] = useState<PersonalWorkspaceActivity[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (refresh = false) => {
    if (!workspace?.id || experience.kind !== 'personal') return
    if (refresh) setRefreshing(true)
    try {
      setError(null)
      const [nextGoals, nextActivity] = await Promise.all([
        api.listWorkspaceGoals(http, workspace.id),
        api.listWorkspaceActivity(http, workspace.id),
      ])
      setGoals(nextGoals)
      setActivity(nextActivity)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load goals')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [experience.kind, http, workspace?.id])

  useFocusEffect(useCallback(() => {
    void load()
  }, [load]))

  const pendingApprovals = useMemo(() => activity.filter(isApprovalPending), [activity])
  const activeGoals = goals.filter((goal) => goal.status === 'active')
  const completedGoals = goals.filter((goal) => goal.status !== 'active')

  const dismissApproval = useCallback((eventId: string) => {
    setActivity((current) => current.filter((item) => item.id !== eventId))
  }, [])

  const openGoal = useCallback(
    (goalId: string) => router.push({ pathname: '/(app)/goals/[id]', params: { id: goalId } } as any),
    [router],
  )

  const contentWidth = isWide ? 760 : undefined

  // Goals are a personal-workspace surface. A team workspace can still be
  // opened through a stale URL or browser history, but must not call the
  // personal goals API and show a misleading "No access" error.
  if (workspace?.id && experience.kind !== 'personal') {
    return <Redirect href="/(app)" />
  }

  return (
    <View className="flex-1 bg-background">
      <View className="border-b border-border/70 bg-card/80">
        <View
          className="mx-auto w-full flex-row items-center gap-3 py-4"
          style={{ maxWidth: contentWidth, paddingHorizontal: isWide ? 32 : 16 }}
        >
          <View className="h-10 w-10 items-center justify-center rounded-2xl border border-primary/15 bg-primary/10">
            <Target size={19} className="text-primary" />
          </View>
          <View className="min-w-0 flex-1">
            <Text className="text-xl font-semibold tracking-tight text-foreground">Goals</Text>
            <Text className="mt-0.5 text-sm text-muted-foreground" numberOfLines={1}>
              The direction your companion is carrying forward.
            </Text>
          </View>
          {!loading && goals.length > 0 ? (
            <View className="rounded-full border border-border/70 bg-background px-3 py-1.5">
              <Text className="text-xs font-medium text-muted-foreground">
                {activeGoals.length} active
              </Text>
            </View>
          ) : null}
        </View>
      </View>

      <ScrollView
        className="flex-1"
        contentContainerStyle={{ paddingBottom: isWide ? 52 : 128 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void load(true)} />}
      >
        <View
          className="mx-auto w-full pt-5"
          style={{ maxWidth: contentWidth, paddingHorizontal: isWide ? 32 : 16 }}
        >
          {loading ? (
            <View className="items-center py-16"><ActivityIndicator /></View>
          ) : error ? (
            <View className="mt-2 rounded-2xl border border-destructive/30 bg-destructive/5 px-4 py-4">
              <Text className="text-center text-sm leading-5 text-destructive">{error}</Text>
            </View>
          ) : goals.length === 0 && pendingApprovals.length === 0 ? (
            <View className="mt-2 rounded-3xl border border-dashed border-border/80 bg-card/40 px-6 py-10">
              <View className="mx-auto h-11 w-11 items-center justify-center rounded-2xl bg-muted">
                <Target size={20} className="text-muted-foreground" />
              </View>
              <Text className="mt-4 text-center text-base font-semibold text-foreground">No goals yet</Text>
              <Text className="mx-auto mt-2 max-w-sm text-center text-sm leading-5 text-muted-foreground">
                Tell your companion what you want to work toward and it will keep the plan here.
              </Text>
            </View>
          ) : (
            <>
              {pendingApprovals.length > 0 && workspace?.id ? (
                <View className="rounded-3xl border border-border/70 bg-card/55 p-4">
                  <NeedsYourOkSection
                    workspaceId={workspace.id}
                    items={pendingApprovals}
                    onResolved={dismissApproval}
                  />
                </View>
              ) : null}
              {activeGoals.length > 0 ? (
                <GoalSection title="In progress" goals={activeGoals} onPress={openGoal} />
              ) : null}
              {completedGoals.length > 0 ? (
                <GoalSection title="Paused and complete" goals={completedGoals} onPress={openGoal} />
              ) : null}
            </>
          )}
        </View>
      </ScrollView>
    </View>
  )
})

function GoalSection({
  title,
  goals,
  onPress,
}: {
  title: string
  goals: PersonalGoal[]
  onPress: (goalId: string) => void
}) {
  return (
    <View className="mt-8">
      <View className="mb-3 flex-row items-center justify-between">
        <Text className="text-xs font-semibold uppercase tracking-[1.5px] text-muted-foreground">
          {title}
        </Text>
        <Text className="text-xs text-muted-foreground">{goals.length}</Text>
      </View>
      <View className="overflow-hidden rounded-3xl border border-border/70 bg-card/70">
        {goals.map((goal, index) => (
          <Pressable
            key={goal.id}
            onPress={() => onPress(goal.id)}
            accessibilityRole="button"
            accessibilityLabel={`Open goal ${goal.title}`}
            className="px-4 py-4 active:bg-muted/60"
          >
            <View className="flex-row items-start gap-3">
              <View className="pt-0.5"><GoalStatusIcon status={goal.status} /></View>
              <View className="min-w-0 flex-1">
                <Text className="text-base font-semibold text-foreground">{goal.title}</Text>
                {goal.why ? (
                  <Text className="mt-1 text-sm leading-5 text-muted-foreground">{goal.why}</Text>
                ) : null}
                <Text className="mt-3 text-xs capitalize text-muted-foreground">
                  {goal.status}
                  {goal.lastProgressAt ? ` · Updated ${formatDate(goal.lastProgressAt)}` : ''}
                </Text>
              </View>
              <ChevronRight size={17} className="mt-1 text-muted-foreground" />
            </View>
            {index < goals.length - 1 ? <View className="ml-8 mt-4 h-px bg-border/70" /> : null}
          </Pressable>
        ))}
      </View>
    </View>
  )
}

function formatDate(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'recently'
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export default GoalsPage
