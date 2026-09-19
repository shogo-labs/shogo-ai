// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useCallback, useState } from 'react'
import { ActivityIndicator, RefreshControl, ScrollView, Text, View } from 'react-native'
import { useFocusEffect } from 'expo-router'
import { observer } from 'mobx-react-lite'
import { CheckCircle2, CircleDot, PauseCircle, Target } from 'lucide-react-native'
import { useDomainHttp } from '../../contexts/domain'
import { useActiveWorkspace } from '../../hooks/useActiveWorkspace'
import { api, type PersonalGoal } from '../../lib/api'

function GoalStatusIcon({ status }: { status: PersonalGoal['status'] }) {
  if (status === 'done') return <CheckCircle2 size={19} className="text-emerald-500" />
  if (status === 'paused') return <PauseCircle size={19} className="text-muted-foreground" />
  return <CircleDot size={19} className="text-primary" />
}

export const PersonalGoalsScreen = observer(function PersonalGoalsScreen() {
  const http = useDomainHttp()
  const workspace = useActiveWorkspace()
  const [goals, setGoals] = useState<PersonalGoal[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (refresh = false) => {
    if (!workspace?.id) return
    if (refresh) setRefreshing(true)
    try {
      setError(null)
      setGoals(await api.listWorkspaceGoals(http, workspace.id))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load goals')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [http, workspace?.id])

  useFocusEffect(useCallback(() => {
    void load()
  }, [load]))

  const activeGoals = goals.filter((goal) => goal.status === 'active')
  const completedGoals = goals.filter((goal) => goal.status !== 'active')

  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerClassName="mx-auto w-full max-w-2xl px-4 pb-10 pt-5"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void load(true)} />}
    >
      <View className="flex-row items-center gap-3">
        <View className="h-10 w-10 items-center justify-center rounded-2xl bg-primary/10">
          <Target size={21} className="text-primary" />
        </View>
        <View className="flex-1">
          <Text className="text-2xl font-semibold text-foreground">Goals</Text>
          <Text className="mt-1 text-sm text-muted-foreground">
            The things your companion is carrying forward.
          </Text>
        </View>
      </View>

      {loading ? (
        <View className="items-center py-14"><ActivityIndicator /></View>
      ) : error ? (
        <Text className="mt-8 text-center text-sm text-destructive">{error}</Text>
      ) : goals.length === 0 ? (
        <View className="mt-8 rounded-2xl border border-dashed border-border px-5 py-8">
          <Text className="text-center text-base font-medium text-foreground">No goals yet</Text>
          <Text className="mt-2 text-center text-sm leading-5 text-muted-foreground">
            Tell your companion what you want to work toward and it will keep the plan here.
          </Text>
        </View>
      ) : (
        <>
          {activeGoals.length > 0 ? (
            <GoalSection title="In progress" goals={activeGoals} />
          ) : null}
          {completedGoals.length > 0 ? (
            <GoalSection title="Paused and complete" goals={completedGoals} />
          ) : null}
        </>
      )}
    </ScrollView>
  )
})

function GoalSection({ title, goals }: { title: string; goals: PersonalGoal[] }) {
  return (
    <View className="mt-7">
      <Text className="mb-3 text-xs font-semibold uppercase tracking-[1.5px] text-muted-foreground">
        {title}
      </Text>
      <View className="gap-3">
        {goals.map((goal) => (
          <View key={goal.id} className="rounded-2xl border border-border bg-card p-4">
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
            </View>
          </View>
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
