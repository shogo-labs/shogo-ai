// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useState, useEffect, useCallback, useMemo, useRef } from "react"
import {
  View,
  Text,
  Pressable,
  ScrollView,
  TextInput,
  ActivityIndicator,
  Platform,
} from "react-native"
import { cn } from "@shogo/shared-ui/primitives"
import {
  getModelsByProvider,
  getModelShortDisplayName,
  type ModelTier,
} from "@shogo/model-catalog"
import {
  ClipboardList,
  ArrowLeft,
  Circle,
  CheckCircle2,
  Trash2,
  Search,
  RefreshCw,
  Play,
  ChevronDown,
  Check,
} from "lucide-react-native"
import { MarkdownText } from "../../chat/MarkdownText"
import { AgentClient, type AgentPlanSummary } from "@shogo-ai/sdk/agent"
import { agentFetch } from "../../../lib/agent-fetch"
import { API_URL } from "../../../lib/api"
import { DEFAULT_MODEL_PRO } from "../../chat/ChatInput"
import type { PlanData } from "../../chat/PlanCard"
import { PlansSkeleton } from "./PanelSkeletons"

const PLAN_MODEL_GROUPS = getModelsByProvider().map((g) => ({
  label: g.label,
  models: g.models.map((e) => ({
    id: e.id,
    displayName: e.displayName,
    tier: e.tier as ModelTier,
  })),
}))

const TIER_LABELS: Record<ModelTier, string> = {
  premium: "Premium",
  standard: "Standard",
  economy: "Economy",
}
import { usePlanStreamSafe } from "../../chat/PlanStreamContext"

interface PlansPanelProps {
  visible: boolean
  projectId: string
  agentUrl?: string | null
  selectedModel?: string
  requestedPlanPath?: { filepath: string | null; nonce: number } | null
  onBuildPlan?: (plan: PlanData, modelId: string) => void
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso)
    return d.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    })
  } catch {
    return iso
  }
}

function extractPlanBody(content: string): string {
  const fmEnd = content.indexOf("---", 4)
  if (fmEnd === -1) return content
  return content.substring(fmEnd + 3).trim()
}

function extractTodos(
  content: string
): Array<{ id: string; content: string; status: string }> {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/)
  if (!fmMatch) return []
  const fm = fmMatch[1]
  const todos: Array<{ id: string; content: string; status: string }> = []
  const todoBlocks = fm.split(/\n  - id: /).slice(1)
  for (const block of todoBlocks) {
    const idMatch = block.match(/^(\S+)/)
    const contentMatch = block.match(/content:\s*"?([^"\n]*)"?/)
    const statusMatch = block.match(/status:\s*(\S+)/)
    if (idMatch && contentMatch) {
      todos.push({
        id: idMatch[1],
        content: contentMatch[1],
        status: statusMatch?.[1] || "pending",
      })
    }
  }
  return todos
}

function normalizePlanFilepath(filepath?: string | null): string | undefined {
  if (!filepath) return undefined
  const normalized = filepath.replace(/^\/+/, "").replace(/\\/g, "/")
  const filename = normalized.split("/").pop()
  if (!filename || !/^[a-zA-Z0-9._-]+\.plan\.md$/.test(filename)) return undefined
  return `.shogo/plans/${filename}`
}

function filenameFromPlanPath(filepath?: string | null): string | null {
  if (!filepath) return null
  return normalizePlanFilepath(filepath)?.split("/").pop() ?? null
}

export function PlansPanel({ visible, projectId, agentUrl, selectedModel, requestedPlanPath, onBuildPlan }: PlansPanelProps) {
  const planStream = usePlanStreamSafe()
  const [plans, setPlans] = useState<AgentPlanSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [selectedPlan, setSelectedPlan] = useState<string | null>(null)
  const [planContent, setPlanContent] = useState<string | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [searchQuery, setSearchQuery] = useState("")
  const [buildMode, setBuildMode] = useState<string>(selectedModel || DEFAULT_MODEL_PRO)
  const [showModelPicker, setShowModelPicker] = useState(false)
  const [buildStarted, setBuildStarted] = useState(false)
  const prevSelectedPlanRef = useRef<string | null>(null)

  // Align Build model with chat when opening a plan or switching plans — not when only
  // `selectedModel` changes while staying on the same plan (preserves Plans-picker override).
  useEffect(() => {
    const prev = prevSelectedPlanRef.current
    prevSelectedPlanRef.current = selectedPlan

    if (!selectedPlan || selectedPlan === "__streaming__") return

    const enteredFromList = !prev && !!selectedPlan
    const switchedBetweenPlans =
      !!prev && prev !== "__streaming__" && prev !== selectedPlan
    const leftStreamingToFile =
      prev === "__streaming__" && selectedPlan !== "__streaming__"

    if (enteredFromList || switchedBetweenPlans || leftStreamingToFile) {
      setBuildMode(selectedModel || DEFAULT_MODEL_PRO)
    }
  }, [selectedPlan, selectedModel])

  const baseUrl = agentUrl || `${API_URL}/api/projects/${projectId}/agent-proxy`

  const agentClient = useMemo(
    () =>
      new AgentClient({
        baseUrl: baseUrl.replace(/\/$/, ""),
        fetch: agentFetch,
      }),
    [baseUrl]
  )

  const fetchPlans = useCallback(async () => {
    setLoading(true)
    try {
      const list = await agentClient.listPlans()
      setPlans(list)
    } catch (err) {
      console.error("[PlansPanel] Failed to fetch plans:", err)
    } finally {
      setLoading(false)
    }
  }, [agentClient])

  const fetchPlanDetail = useCallback(
    async (filename: string) => {
      setDetailLoading(true)
      try {
        const data = await agentClient.getPlan(filename)
        setPlanContent(data.content)
      } catch (err) {
        console.error("[PlansPanel] Failed to fetch plan detail:", err)
        setPlanContent(null)
      } finally {
        setDetailLoading(false)
      }
    },
    [agentClient]
  )

  const handleDelete = useCallback(
    async (filename: string) => {
      try {
        await agentClient.deletePlan(filename)
        setPlans((prev) => prev.filter((p) => p.filename !== filename))
        if (selectedPlan === filename) {
          setSelectedPlan(null)
          setPlanContent(null)
        }
      } catch (err) {
        console.error("[PlansPanel] Failed to delete plan:", err)
      }
    },
    [agentClient, selectedPlan]
  )

  useEffect(() => {
    if (visible) {
      fetchPlans()
    } else {
      setSelectedPlan(null)
      setPlanContent(null)
    }
  }, [visible, fetchPlans, planStream?.planRefreshNonce])

  useEffect(() => {
    if (selectedPlan && selectedPlan !== "__streaming__") {
      fetchPlanDetail(selectedPlan)
    }
  }, [selectedPlan, fetchPlanDetail, planStream?.planRefreshNonce])

  useEffect(() => {
    if (!visible) return
    const requestedFilename = filenameFromPlanPath(requestedPlanPath?.filepath)
    if (!requestedFilename) return
    setSelectedPlan(requestedFilename)
    setPlanContent(null)
    setBuildStarted(false)
  }, [visible, requestedPlanPath?.nonce])

  useEffect(() => {
    setBuildStarted(false)
  }, [selectedPlan])

  // Transition from streaming to persisted plan once the file is saved
  useEffect(() => {
    if (selectedPlan !== "__streaming__") return
    const filepath = planStream?.streamingPlanFilepath
    if (!filepath) return
    const filename = filepath.split("/").pop()
    if (!filename) return
    setSelectedPlan(filename)
    setPlanContent(null)
    setBuildStarted(false)
  }, [selectedPlan, planStream?.streamingPlanFilepath])

  const handleBuild = useCallback(() => {
    if (buildStarted || !planContent || !selectedPlan || !onBuildPlan) return
    const plan = plans.find((p) => p.filename === selectedPlan)
    const todos = extractTodos(planContent)
    const body = extractPlanBody(planContent)
    const planData: PlanData = {
      name: plan?.name || selectedPlan,
      overview: plan?.overview || "",
      plan: body,
      todos: todos.map((t) => ({ id: t.id, content: t.content })),
      filepath: normalizePlanFilepath(selectedPlan),
    }
    setBuildStarted(true)
    onBuildPlan(planData, buildMode)
  }, [buildStarted, planContent, selectedPlan, plans, onBuildPlan, buildMode])

  if (!visible) return null

  const filteredPlans = searchQuery
    ? plans.filter(
        (p) =>
          p.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
          p.overview.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : plans

  const isStreamingDetail = selectedPlan === "__streaming__"
  const streamingData = planStream?.streamingPlan

  // Detail view — works for both persisted plans and the live streaming plan
  if (selectedPlan) {
    const plan = isStreamingDetail ? null : plans.find((p) => p.filename === selectedPlan)
    const todos = isStreamingDetail
      ? (streamingData?.todos ?? []).map((t) => ({ ...t, status: "pending" }))
      : planContent ? extractTodos(planContent) : []
    const body = isStreamingDetail
      ? (streamingData?.plan ?? "")
      : planContent ? extractPlanBody(planContent) : ""
    const detailName = isStreamingDetail
      ? (streamingData?.name || "Creating plan...")
      : (plan?.name || selectedPlan)
    const isBuildDisabled = isStreamingDetail || !onBuildPlan || detailLoading || !planContent || buildStarted

    return (
      <View className="flex-1 bg-background">
        {/* Detail header */}
        <View className="flex-row items-center gap-2 px-4 py-3 border-b border-border" style={{ zIndex: 10, overflow: "visible" as any }}>
          <Pressable
            onPress={() => {
              setSelectedPlan(null)
              setPlanContent(null)
              setShowModelPicker(false)
            }}
            className="h-8 w-8 items-center justify-center rounded-lg"
          >
            <ArrowLeft className="h-4 w-4 text-foreground" size={16} />
          </Pressable>
          <View className="flex-1 min-w-0">
            <View className="flex-row items-center gap-2">
              {isStreamingDetail && <ActivityIndicator size="small" />}
              <Text className="font-semibold text-sm text-foreground flex-shrink" numberOfLines={1}>
                {detailName}
              </Text>
            </View>
            {isStreamingDetail ? (
              <Text className="text-xs text-primary">Generating...</Text>
            ) : plan ? (
              <Text className="text-xs text-muted-foreground">
                {formatDate(plan.createdAt)} · {plan.status}
              </Text>
            ) : null}
          </View>

          {/* Model selector */}
          <View className="relative">
            <Pressable
              onPress={() => setShowModelPicker((p) => !p)}
              className="flex-row items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 bg-muted/30"
            >
              <Text className="text-xs font-medium text-foreground">
                {getModelShortDisplayName(buildMode)}
              </Text>
              <ChevronDown className="h-3 w-3 text-muted-foreground" size={12} />
            </Pressable>

            {showModelPicker && (
              <>
              <Pressable
                onPress={() => setShowModelPicker(false)}
                style={{ position: "fixed" as any, top: 0, left: 0, right: 0, bottom: 0, zIndex: 40 }}
              />
              <ScrollView className="absolute right-0 top-9 z-50 w-56 max-h-[280px] rounded-lg border border-border bg-popover shadow-lg">
                {PLAN_MODEL_GROUPS.map((group) => (
                  <View key={group.label}>
                    <View className="px-3 pt-2.5 pb-1">
                      <Text className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                        {group.label}
                      </Text>
                    </View>
                    {group.models.map((model) => {
                      const isSelected = buildMode === model.id
                      return (
                        <Pressable
                          key={model.id}
                          onPress={() => { setBuildMode(model.id); setShowModelPicker(false) }}
                          className={cn(
                            "flex-row items-center gap-2.5 px-3 py-2",
                            isSelected && "bg-accent"
                          )}
                        >
                          <View className="flex-1">
                            <Text className="text-xs text-foreground">{model.displayName}</Text>
                          </View>
                          {isSelected ? (
                            <Check className="h-3.5 w-3.5 text-primary" size={14} />
                          ) : (
                            <Text
                              className={cn(
                                "text-[10px]",
                                model.tier === "premium" ? "text-amber-500" :
                                model.tier === "economy" ? "text-emerald-500" :
                                "text-muted-foreground"
                              )}
                            >
                              {TIER_LABELS[model.tier]}
                            </Text>
                          )}
                        </Pressable>
                      )
                    })}
                  </View>
                ))}
              </ScrollView>
              </>
            )}
          </View>

          {/* Build button */}
          <Pressable
            onPress={handleBuild}
            disabled={isBuildDisabled}
            className={cn(
              "flex-row items-center gap-1.5 rounded-lg px-3.5 py-1.5",
              !isBuildDisabled ? "bg-amber-400 dark:bg-amber-500 active:bg-amber-500 dark:active:bg-amber-600" : "bg-muted opacity-50"
            )}
          >
            <Play className="h-3.5 w-3.5 text-black" size={14} />
            <Text className="text-xs font-bold text-black">{buildStarted ? "Building..." : "Build"}</Text>
          </Pressable>

          {!isStreamingDetail && (
            <Pressable
              onPress={() => handleDelete(selectedPlan)}
              className="h-8 w-8 items-center justify-center rounded-lg"
            >
              <Trash2 className="h-4 w-4 text-destructive" size={16} />
            </Pressable>
          )}
        </View>

        {/* Detail body */}
        <ScrollView className="flex-1 px-4 py-3" onScrollBeginDrag={() => setShowModelPicker(false)}>
          {!isStreamingDetail && detailLoading ? (
            <PlansSkeleton />
          ) : (
            <>
              <MarkdownText>{body}</MarkdownText>

              {todos.length > 0 && (
                <View className="mt-4 border-t border-border pt-4">
                  <Text className="text-xs font-semibold text-muted-foreground mb-2">
                    TASKS ({todos.length})
                  </Text>
                  {todos.map((todo) => (
                    <View key={todo.id} className="flex-row items-start gap-2 py-1.5">
                      {todo.status === "completed" ? (
                        <CheckCircle2
                          className="h-3.5 w-3.5 text-green-600 dark:text-green-400 mt-0.5"
                          size={14}
                        />
                      ) : (
                        <Circle className="h-3.5 w-3.5 text-muted-foreground mt-0.5" size={14} />
                      )}
                      <Text
                        className={cn(
                          "text-xs flex-1",
                          todo.status === "completed"
                            ? "text-muted-foreground line-through"
                            : "text-foreground"
                        )}
                      >
                        {todo.content}
                      </Text>
                    </View>
                  ))}
                </View>
              )}
            </>
          )}
        </ScrollView>
      </View>
    )
  }

  // List view
  return (
    <View className="flex-1 bg-background">
      {/* Header */}
      <View className="flex-row items-center justify-between px-4 py-3 border-b border-border">
        <View className="flex-row items-center gap-2">
          <ClipboardList className="h-4 w-4 text-foreground" size={16} />
          <Text className="font-semibold text-sm text-foreground">Plans</Text>
        </View>
        <Pressable onPress={fetchPlans} className="h-8 w-8 items-center justify-center rounded-lg">
          <RefreshCw className="h-3.5 w-3.5 text-muted-foreground" size={14} />
        </Pressable>
      </View>

      {/* Search */}
      <View className="px-4 py-2 border-b border-border/60">
        <View className="flex-row items-center gap-2 rounded-lg bg-muted/50 px-3 py-2">
          <Search className="h-3.5 w-3.5 text-muted-foreground" size={14} />
          <TextInput
            value={searchQuery}
            onChangeText={setSearchQuery}
            placeholder="Search plans..."
            placeholderTextColor="#9ca3af"
            className={cn(
              "flex-1 text-xs text-foreground",
              Platform.OS === "web" && "outline-none"
            )}
          />
        </View>
      </View>

      {/* List */}
      <ScrollView className="flex-1">
        {/* Streaming plan — clickable list entry that opens the detail view */}
        {planStream?.streamingPlan ? (
          <Pressable
            onPress={() => setSelectedPlan("__streaming__")}
            className="flex-row items-center gap-3 px-4 py-3 border-b border-primary/30 bg-primary/5 active:bg-primary/10"
          >
            <ActivityIndicator size="small" />
            <View className="flex-1 min-w-0">
              <Text className="font-medium text-sm text-foreground" numberOfLines={1}>
                {planStream.streamingPlan.name || "Creating plan..."}
              </Text>
              {planStream.streamingPlan.overview ? (
                <Text className="text-xs text-muted-foreground mt-0.5" numberOfLines={2}>
                  {planStream.streamingPlan.overview}
                </Text>
              ) : null}
              <Text className="text-xs text-primary mt-1">Generating...</Text>
            </View>
          </Pressable>
        ) : planStream?.isPlanStreaming && filteredPlans.length === 0 && !loading ? (
          <View className="items-center justify-center py-12 px-4">
            <ActivityIndicator className="mb-3" />
            <Text className="text-sm text-muted-foreground text-center">
              Shogo is researching...
            </Text>
            <Text className="text-xs text-muted-foreground/70 text-center mt-1">
              A plan will appear here shortly
            </Text>
          </View>
        ) : null}

        {/* Researching banner when plans already exist */}
        {planStream?.isPlanStreaming && !planStream.streamingPlan && filteredPlans.length > 0 && (
          <View className="flex-row items-center gap-2 px-4 py-2.5 border-b border-primary/20 bg-primary/5">
            <ActivityIndicator size="small" />
            <Text className="text-xs text-primary">Creating a new plan...</Text>
          </View>
        )}

        {loading && !planStream?.isPlanStreaming ? (
          <PlansSkeleton />
        ) : filteredPlans.length === 0 && !planStream?.isPlanStreaming && !planStream?.streamingPlan ? (
          <View className="items-center justify-center py-12 px-4">
            <ClipboardList className="h-8 w-8 text-muted-foreground/40 mb-3" size={32} />
            <Text className="text-sm text-muted-foreground text-center">
              {searchQuery ? "No plans match your search" : "No plans yet"}
            </Text>
            <Text className="text-xs text-muted-foreground/70 text-center mt-1">
              Switch to Plan mode in the chat to create one
            </Text>
          </View>
        ) : filteredPlans.length > 0 ? (
          filteredPlans.map((plan) => (
            <Pressable
              key={plan.filename}
              onPress={() => setSelectedPlan(plan.filename)}
              className="flex-row items-center gap-3 px-4 py-3 border-b border-border/40 active:bg-accent"
            >
              <View className="flex-1 min-w-0">
                <Text className="font-medium text-sm text-foreground" numberOfLines={1}>
                  {plan.name || plan.filename}
                </Text>
                {plan.overview ? (
                  <Text className="text-xs text-muted-foreground mt-0.5" numberOfLines={2}>
                    {plan.overview}
                  </Text>
                ) : null}
                <Text className="text-xs text-muted-foreground/70 mt-1">
                  {formatDate(plan.createdAt)} · {plan.status}
                </Text>
              </View>
            </Pressable>
          ))
        ) : null}
      </ScrollView>
    </View>
  )
}
