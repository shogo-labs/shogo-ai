// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { memo, useState } from "react"
import { ActivityIndicator, View, Text, Pressable, ScrollView } from "react-native"
import { cn } from "@shogo/shared-ui/primitives"
import {
  CheckCircle2,
  Circle,
  ClipboardList,
  ChevronDown,
  ChevronRight,
  Languages,
} from "lucide-react-native"
import { MarkdownText } from "./MarkdownText"
import { PlanBuildActions } from "./PlanBuildActions"
import { usePlanBuildModel } from "./usePlanBuildModel"
import { usePhoneLayout } from "../../lib/native-phone-layout"

export type PlanSummaryStatus = "idle" | "pending" | "ready" | "error"

export interface PlanData {
  name: string
  overview: string
  plan: string
  todos: Array<{ id: string; content: string }>
  filepath?: string
  toolCallId?: string
  /** Stakeholder-friendly summary, populated asynchronously by the runtime
   *  when the user has the Dual Plan preference enabled. */
  summary?: string
  /** Lifecycle of the summary. Absent / `idle` means the user did not opt
   *  in for this plan; "pending" shows a spinner; "ready" enables the
   *  Summary tab; "error" surfaces an inline message. */
  summaryStatus?: PlanSummaryStatus
  /** True when this plan came from an update_plan tool call. */
  isUpdate?: boolean
}

type PlanTab = "technical" | "summary"

const PLAN_TRUNCATE_LENGTH = 2000
/** Pixel caps — NativeWind `max-h-[300px]` does not bound Yoga on native, so
 *  an expanded plan in the dock grew until the composer left the screen. */
const PLAN_BODY_MAX_HEIGHT = 300

interface PlanCardProps {
  plan: PlanData
  onBuild?: (modelId?: string) => void
  onConfirm?: () => void
  onOpenPlan?: () => void
  onViewFull?: () => void
  isConfirmed?: boolean
  /** Triggers an on-demand summary generation for a plan that does not yet
   *  have one. Surfaced when summary is missing and idle. */
  onGenerateSummary?: () => void | Promise<void>
  /** Set by `PlanDockPanel`: drops the outer rounded/border/bg card so this
   *  doesn't nest a card inside `DockPanel`'s own zone-level card — see
   *  `ChatDock`'s file header comment. Internal section dividers are kept. */
  embedded?: boolean
  /** Chat's current model — the Build picker starts here. */
  selectedModel?: string
  /** When false, non-economy models in the Build picker stay locked. */
  isPro?: boolean
}

// `AssistantContent` rebuilds the `plan` object literal on every commit while
// the `create_plan` tool's args stream in (the AI SDK reassembles the args
// object on every chunk). With reference equality, `memo` would never bail
// out, so PlanCard re-renders end-to-end on every partial token — which the
// CPU profile shows as a 21 % `createElement` bottleneck. Compare on shallow
// content equality of the fields PlanCard actually reads.
function planCardPropsEqual(prev: PlanCardProps, next: PlanCardProps) {
  if (prev.isConfirmed !== next.isConfirmed) return false
  if (prev.onBuild !== next.onBuild) return false
  if (prev.onConfirm !== next.onConfirm) return false
  if (prev.onOpenPlan !== next.onOpenPlan) return false
  if (prev.onViewFull !== next.onViewFull) return false
  if (prev.onGenerateSummary !== next.onGenerateSummary) return false
  if (prev.embedded !== next.embedded) return false
  if (prev.selectedModel !== next.selectedModel) return false
  if (prev.isPro !== next.isPro) return false
  const a = prev.plan
  const b = next.plan
  if (a === b) return true
  if (
    a.name !== b.name ||
    a.overview !== b.overview ||
    a.plan !== b.plan ||
    a.filepath !== b.filepath ||
    a.toolCallId !== b.toolCallId ||
    a.todos.length !== b.todos.length ||
    a.summary !== b.summary ||
    a.summaryStatus !== b.summaryStatus
  ) {
    return false
  }
  for (let i = 0; i < a.todos.length; i++) {
    if (a.todos[i].id !== b.todos[i].id) return false
    if (a.todos[i].content !== b.todos[i].content) return false
  }
  return true
}

function PlanCardImpl({
  plan,
  onBuild,
  onConfirm,
  onOpenPlan,
  onViewFull,
  isConfirmed,
  onGenerateSummary,
  embedded = false,
  selectedModel,
  isPro = true,
}: PlanCardProps) {
  const [tasksExpanded, setTasksExpanded] = useState(false)
  const [activeTab, setActiveTab] = useState<PlanTab>("technical")
  const [generating, setGenerating] = useState(false)
  const [generateError, setGenerateError] = useState<string | null>(null)
  const isPhoneChrome = usePhoneLayout()
  const planKey = plan.filepath ?? plan.toolCallId ?? plan.name
  const [buildModelId, setBuildModelId] = usePlanBuildModel(selectedModel, planKey)

  const handleGenerate = onGenerateSummary
    ? async () => {
        if (generating) return
        setGenerating(true)
        setGenerateError(null)
        try {
          await onGenerateSummary()
        } catch (err: any) {
          setGenerateError(err?.message || "Failed to generate summary")
        } finally {
          setGenerating(false)
        }
      }
    : undefined
  const isTruncatable = plan.plan.length > PLAN_TRUNCATE_LENGTH
  const handleBuildPress =
    onBuild || onConfirm
      ? (modelId?: string) => {
          if (onBuild) onBuild(modelId || buildModelId || undefined)
          else onConfirm?.()
        }
      : undefined
  const technicalDisplayedPlan = isTruncatable
    ? plan.plan.substring(0, PLAN_TRUNCATE_LENGTH) + "\n\n..."
    : plan.plan
  const summaryStatus: PlanSummaryStatus = plan.summaryStatus ?? "idle"
  const summaryAvailable = summaryStatus !== "idle"
  const isSummaryTab = activeTab === "summary" && summaryAvailable
  const summaryTextRaw = plan.summary ?? ""
  const summaryIsTruncatable = summaryTextRaw.length > PLAN_TRUNCATE_LENGTH
  const summaryDisplayed = summaryIsTruncatable
    ? summaryTextRaw.substring(0, PLAN_TRUNCATE_LENGTH) + "\n\n..."
    : summaryTextRaw

  // Opens the Plans tab for the full document. Never expand in the dock —
  // the card is a preview, and growing it covers the composer.
  const handleViewFull = onViewFull ?? onOpenPlan

  return (
    <View className={cn(!embedded && "mx-2 my-3 rounded-xl border border-border bg-card overflow-hidden")}>
      {/* Header */}
      <View className={cn("flex-row items-center gap-2 px-4 py-3", !embedded && "border-b border-border bg-muted/30")}>
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

      {/* Tab strip — only visible when a summary exists or is in flight */}
      {summaryAvailable && (
        <View className="flex-row items-center border-b border-border/40">
          <Pressable
            onPress={() => setActiveTab("technical")}
            className={cn(
              "flex-1 items-center justify-center py-2",
              activeTab === "technical" && "border-b-2 border-primary"
            )}
          >
            <Text
              className={cn(
                "text-xs font-semibold",
                activeTab === "technical" ? "text-foreground" : "text-muted-foreground"
              )}
            >
              Technical
            </Text>
          </Pressable>
          <Pressable
            onPress={() => setActiveTab("summary")}
            className={cn(
              "flex-1 flex-row items-center justify-center gap-1 py-2",
              activeTab === "summary" && "border-b-2 border-sky-400"
            )}
          >
            <Text
              className={cn(
                "text-xs font-semibold",
                activeTab === "summary" ? "text-sky-400" : "text-muted-foreground"
              )}
            >
              Summary
            </Text>
            {summaryStatus === "pending" && <ActivityIndicator size="small" />}
          </Pressable>
        </View>
      )}

      {/* Plan body */}
      <ScrollView
        className="px-4 py-3"
        style={{ maxHeight: PLAN_BODY_MAX_HEIGHT }}
        nestedScrollEnabled
        bounces={false}
        alwaysBounceVertical={false}
      >
        {isSummaryTab ? (
          summaryStatus === "pending" ? (
            <View className="flex-row items-center gap-2 py-3">
              <ActivityIndicator size="small" />
              <Text className="text-xs text-muted-foreground">Generating summary...</Text>
            </View>
          ) : summaryStatus === "error" ? (
            <Text className="text-xs text-destructive">
              Failed to generate summary. The technical plan above is unaffected.
            </Text>
          ) : (
            <MarkdownText>{summaryDisplayed}</MarkdownText>
          )
        ) : (
          <MarkdownText>{technicalDisplayedPlan}</MarkdownText>
        )}
      </ScrollView>

      {/* Todos */}
      {plan.todos.length > 0 && (
        <View className="border-t border-border/50">
          <Pressable
            onPress={() => setTasksExpanded((prev) => !prev)}
            className="flex-row items-center gap-1.5 px-4 py-3"
          >
            {tasksExpanded ? (
              <ChevronDown className="h-3 w-3 text-muted-foreground" size={12} />
            ) : (
              <ChevronRight className="h-3 w-3 text-muted-foreground" size={12} />
            )}
            <Text className="text-xs font-semibold text-muted-foreground">TASKS ({plan.todos.length})</Text>
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
        <View className="gap-2 px-4 py-3 border-t border-border bg-muted/20">
          <View className="flex-row flex-wrap items-center gap-x-2 gap-y-2">
            <PlanBuildActions
              buildModelId={buildModelId}
              isPro={isPro}
              nativeSheet={isPhoneChrome}
              onSelectModel={setBuildModelId}
              onBuild={handleBuildPress}
              onViewPlan={handleViewFull ?? undefined}
            />
            {handleGenerate && !summaryAvailable && !!plan.filepath ? (
              <Pressable
                onPress={handleGenerate}
                disabled={generating}
                className={cn(
                  "flex-row items-center gap-1 py-1",
                  generating && "opacity-70"
                )}
              >
                {generating ? (
                  <ActivityIndicator size="small" />
                ) : (
                  <Languages className="h-3.5 w-3.5 text-sky-400" size={14} />
                )}
                <Text className="text-xs font-semibold text-sky-400">{generating ? "Generating..." : "Summary"}</Text>
              </Pressable>
            ) : null}
          </View>
        </View>
      )}

      {generateError && !summaryAvailable && (
        <Text className="px-4 pb-2 text-xs text-destructive">{generateError}</Text>
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

export const PlanCard = memo(PlanCardImpl, planCardPropsEqual)
