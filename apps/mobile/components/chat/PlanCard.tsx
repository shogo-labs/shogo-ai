// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useState } from "react"
import { View, Text, Pressable, ScrollView } from "react-native"
import { cn } from "@shogo/shared-ui/primitives"
import { CheckCircle2, Circle, Play, ClipboardList, ChevronDown, ChevronUp, ChevronRight, FileText } from "lucide-react-native"
import { MarkdownText } from "./MarkdownText"

export interface PlanData {
  name: string
  overview: string
  plan: string
  todos: Array<{ id: string; content: string }>
  filepath?: string
  toolCallId?: string
}

const PLAN_TRUNCATE_LENGTH = 2000

interface PlanCardProps {
  plan: PlanData
  onBuild?: () => void
  onConfirm?: () => void
  onOpenPlan?: () => void
  onViewFull?: () => void
  isConfirmed?: boolean
}

export function PlanCard({ plan, onBuild, onConfirm, onOpenPlan, onViewFull, isConfirmed }: PlanCardProps) {
  const [expanded, setExpanded] = useState(false)
  const [tasksExpanded, setTasksExpanded] = useState(false)
  const isTruncatable = plan.plan.length > PLAN_TRUNCATE_LENGTH
  const buildAction = onBuild ?? onConfirm
  const displayedPlan = expanded || !isTruncatable
    ? plan.plan
    : plan.plan.substring(0, PLAN_TRUNCATE_LENGTH) + "\n\n..."

  const handleViewFull = onViewFull ?? (isTruncatable ? () => setExpanded(prev => !prev) : undefined)

  return (
    <View className="mx-2 my-3 rounded-xl border border-border bg-card overflow-hidden">
      {/* Header */}
      <View className="flex-row items-center gap-2 px-4 py-3 border-b border-border bg-muted/30">
        <ClipboardList className="h-4 w-4 text-primary" size={16} />
        <View className="flex-1">
          <Text className="font-semibold text-sm text-foreground">{plan.name}</Text>
          <Text className="text-xs text-muted-foreground mt-0.5">{plan.overview}</Text>
          {plan.filepath ? (
            <Text className="text-[10px] text-muted-foreground/70 mt-1" numberOfLines={1}>
              Saved as {plan.filepath}
            </Text>
          ) : null}
        </View>
      </View>

      {/* Plan body */}
      <ScrollView className={cn("px-4 py-3", expanded ? "max-h-[600px]" : "max-h-[300px]")}>
        <MarkdownText>{displayedPlan}</MarkdownText>
      </ScrollView>

      {/* Todos */}
      {plan.todos.length > 0 && (
        <View className="border-t border-border/50">
          <Pressable
            onPress={() => setTasksExpanded(prev => !prev)}
            className="flex-row items-center gap-1.5 px-4 py-3"
          >
            {tasksExpanded
              ? <ChevronDown className="h-3 w-3 text-muted-foreground" size={12} />
              : <ChevronRight className="h-3 w-3 text-muted-foreground" size={12} />}
            <Text className="text-xs font-semibold text-muted-foreground">
              TASKS ({plan.todos.length})
            </Text>
          </Pressable>
          {tasksExpanded && (
            <View className="px-4 pb-3">
              {plan.todos.map((todo) => (
                <View key={todo.id} className="flex-row items-start gap-2 py-1">
                  <Circle className="h-3.5 w-3.5 text-muted-foreground mt-0.5" size={14} />
                  <Text className="text-xs text-foreground flex-1">{todo.content}</Text>
                </View>
              ))}
            </View>
          )}
        </View>
      )}

      {/* Actions */}
      {!isConfirmed && (
        <View className="flex-row flex-wrap items-center gap-2 px-4 py-3 border-t border-border bg-muted/20">
          {buildAction && (
            <Pressable
              onPress={buildAction}
              className="flex-row items-center gap-1.5 rounded-lg bg-primary px-4 py-2"
            >
              <Play className="h-3.5 w-3.5 text-primary-foreground" size={14} />
              <Text className="text-xs font-semibold text-primary-foreground">
                Build Plan
              </Text>
            </Pressable>
          )}
          {onOpenPlan && plan.filepath && (
            <Pressable
              onPress={onOpenPlan}
              className="flex-row items-center gap-1.5 rounded-lg border border-border px-4 py-2"
            >
              <FileText className="h-3 w-3 text-muted-foreground" size={12} />
              <Text className="text-xs text-muted-foreground">Open Plan</Text>
            </Pressable>
          )}
          {handleViewFull && (
            <Pressable
              onPress={handleViewFull}
              className="flex-row items-center gap-1.5 rounded-lg border border-border px-4 py-2"
            >
              {expanded
                ? <ChevronUp className="h-3 w-3 text-muted-foreground" size={12} />
                : <ChevronDown className="h-3 w-3 text-muted-foreground" size={12} />}
              <Text className="text-xs text-muted-foreground">
                {expanded ? "Collapse Plan" : "View Full Plan"}
              </Text>
            </Pressable>
          )}
        </View>
      )}

      {isConfirmed && (
        <View className="flex-row items-center gap-2 px-4 py-3 border-t border-border bg-green-50 dark:bg-green-950/30">
          <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-400" size={16} />
          <Text className="text-xs font-medium text-green-700 dark:text-green-400">
            Plan build started - executing in Agent mode...
          </Text>
        </View>
      )}
    </View>
  )
}
