// SPDX-License-Identifier: MIT
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
  ClipboardList,
  ArrowLeft,
  Circle,
  CheckCircle2,
  Trash2,
  Search,
  RefreshCw,
  Play,
  Languages,
  GitCompareArrows,
  CheckSquare,
  Square,
  X,
} from "lucide-react-native"
import { MarkdownText } from "../../chat/MarkdownText"
import { AgentClient, type AgentPlanSummary } from "@shogo-ai/sdk/agent"
import { agentFetch } from "../../../lib/agent-fetch"
import { API_URL } from "../../../lib/api"
import { DEFAULT_MODEL_PRO } from "../../chat/ChatInput"
import type { PlanData } from "../../chat/PlanCard"
import { useDualPlan } from "../../../lib/dual-plan-preference"
import { ModelPicker } from "./ModelPicker"
import { usePlanStreamSafe } from "../../chat/PlanStreamContext"

/* ─── Status badge helper ─────────────────────────────────────────── */

const STATUS_BADGE_STYLES: Record<string, { bg: string; text: string; label: string }> = {
  draft:     { bg: "bg-zinc-500/15",   text: "text-zinc-400",    label: "Draft"     },
  active:    { bg: "bg-blue-500/15",    text: "text-blue-400",    label: "Active"    },
  completed: { bg: "bg-emerald-500/15", text: "text-emerald-400", label: "Completed" },
  building:  { bg: "bg-amber-500/15",   text: "text-amber-400",   label: "Building"  },
  error:     { bg: "bg-red-500/15",     text: "text-red-400",     label: "Error"     },
}

function StatusBadge({ status }: { status: string }) {
  const s = STATUS_BADGE_STYLES[status.toLowerCase()] ?? STATUS_BADGE_STYLES.draft
  return (
    <View className={cn("rounded-full px-2 py-0.5", s.bg)}>
      <Text className={cn("text-[10px] font-semibold", s.text)}>
        {s.label}
      </Text>
    </View>
  )
}

/* ─── Progress bar for tasks ──────────────────────────────────────── */

function TaskProgressBar({ todos }: { todos: Array<{ status: string }> }) {
  if (todos.length === 0) return null
  const completed = todos.filter((t) => t.status === "completed").length
  const pct = Math.round((completed / todos.length) * 100)
  return (
    <View className="flex-row items-center gap-2 mt-1">
      <View className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
        <View
          className={cn(
            "h-full rounded-full",
            pct === 100 ? "bg-emerald-500" : "bg-primary"
          )}
          style={{ width: `${pct}%` }}
        />
      </View>
      <Text className="text-[10px] text-muted-foreground">{completed}/{todos.length}</Text>
    </View>
  )
}

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

const BUSINESS_SECTION_START = "<!-- :::business-plan::: -->"
const BUSINESS_SECTION_END = "<!-- :::end-business-plan::: -->"

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

const BUSINESS_SECTION_RE = new RegExp(
  `\\n*${escapeRegex(BUSINESS_SECTION_START)}\\n([\\s\\S]*?)\\n${escapeRegex(BUSINESS_SECTION_END)}\\n*$`
)

function extractBusinessFromContent(content: string): string | null {
  const match = content.match(BUSINESS_SECTION_RE)
  return match ? match[1].trim() : null
}

function stripBusinessFromContent(content: string): string {
  return content.replace(BUSINESS_SECTION_RE, "").trimEnd()
}

function extractPlanBody(content: string): string {
  const stripped = stripBusinessFromContent(content)
  const fmEnd = stripped.indexOf("---", 4)
  if (fmEnd === -1) return stripped
  return stripped.substring(fmEnd + 3).trim()
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
  const [buildStarted, setBuildStarted] = useState(false)
  const [activeTab, setActiveTab] = useState<"technical" | "business">("technical")
  const [dualPlan, setDualPlanAsync] = useDualPlan()
  const [translateLoading, setTranslateLoading] = useState<string | null>(null)
  const [translateError, setTranslateError] = useState<string | null>(null)
  const prevSelectedPlanRef = useRef<string | null>(null)

  // Bulk selection state
  const [bulkMode, setBulkMode] = useState(false)
  const [selectedForBulk, setSelectedForBulk] = useState<Set<string>>(new Set())

  // Diff / comparison state
  const [diffMode, setDiffMode] = useState(false)
  const [diffTargets, setDiffTargets] = useState<[string | null, string | null]>([null, null])
  const [diffContents, setDiffContents] = useState<[string | null, string | null]>([null, null])
  const [diffLoading, setDiffLoading] = useState(false)

  const handleDualPlanToggle = useCallback(() => {
    void setDualPlanAsync(!dualPlan)
  }, [dualPlan, setDualPlanAsync])

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

  const handleBulkDelete = useCallback(async () => {
    if (selectedForBulk.size === 0) return
    const filenames = [...selectedForBulk]
    try {
      await Promise.all(filenames.map((f) => agentClient.deletePlan(f)))
      setPlans((prev) => prev.filter((p) => !selectedForBulk.has(p.filename)))
      if (selectedPlan && selectedForBulk.has(selectedPlan)) {
        setSelectedPlan(null)
        setPlanContent(null)
      }
    } catch (err) {
      console.error("[PlansPanel] Bulk delete failed:", err)
    } finally {
      setSelectedForBulk(new Set())
      setBulkMode(false)
    }
  }, [agentClient, selectedForBulk, selectedPlan])

  const toggleBulkSelection = useCallback((filename: string) => {
    setSelectedForBulk((prev) => {
      const next = new Set(prev)
      if (next.has(filename)) next.delete(filename)
      else next.add(filename)
      return next
    })
  }, [])

  const handleStartDiff = useCallback(async () => {
    const [a, b] = diffTargets
    if (!a || !b) return
    setDiffLoading(true)
    try {
      const [planA, planB] = await Promise.all([
        agentClient.getPlan(a),
        agentClient.getPlan(b),
      ])
      setDiffContents([planA.content, planB.content])
    } catch (err) {
      console.error("[PlansPanel] Diff fetch failed:", err)
      setDiffContents([null, null])
    } finally {
      setDiffLoading(false)
    }
  }, [agentClient, diffTargets])

  const exitDiffMode = useCallback(() => {
    setDiffMode(false)
    setDiffTargets([null, null])
    setDiffContents([null, null])
    setDiffLoading(false)
  }, [])

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
    setActiveTab("technical")
    setTranslateError(null)
  }, [selectedPlan])

  const handleTranslate = useCallback(async () => {
    if (!selectedPlan || selectedPlan === "__streaming__") return
    if (translateLoading) return
    setTranslateLoading(selectedPlan)
    setTranslateError(null)
    try {
      await agentClient.translatePlan(selectedPlan)
      // Re-fetch the file so extractBusinessFromContent picks up the new
      // section; switching the active tab gives the user immediate feedback.
      await fetchPlanDetail(selectedPlan)
      setActiveTab("business")
    } catch (err: any) {
      const message = err?.message || "Failed to generate business summary"
      console.error("[PlansPanel] Translate failed:", err)
      setTranslateError(message)
    } finally {
      setTranslateLoading((cur) => (cur === selectedPlan ? null : cur))
    }
  }, [agentClient, fetchPlanDetail, selectedPlan, translateLoading])

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

    // Resolve the business translation from either the live stream (while the
    // plan is being generated) or the persisted file. We also surface the
    // translation lifecycle so the Business tab can spin or show errors.
    const businessFromStream = planStream?.streamingBusinessPlan ?? null
    const businessFromFile = planContent
      ? extractBusinessFromContent(planContent)
      : null
    const businessText = isStreamingDetail
      ? businessFromStream
      : (businessFromFile ?? businessFromStream)
    const isTranslatingThisPlan = translateLoading === selectedPlan
    const businessStatus = isStreamingDetail
      ? (planStream?.businessStatus ?? "idle")
      : isTranslatingThisPlan
        ? "pending"
        : (businessText ? "ready" : (planStream?.businessStatus ?? "idle"))
    const businessAvailable = businessStatus !== "idle" || !!businessText
    const isBusinessTab = activeTab === "business" && businessAvailable
    // The on-demand Generate action shows up when this plan is missing a
    // business translation and we're not already producing one. It works
    // regardless of the global Dual Plan toggle so historic plans aren't
    // stuck without the feature.
    const canGenerateOnDemand =
      !isStreamingDetail &&
      !!planContent &&
      !detailLoading &&
      !businessText &&
      !isTranslatingThisPlan

    return (
      <View className="flex-1 bg-background">
        {/* Detail header */}
        <View className="flex-row items-center gap-2 px-4 py-3 border-b border-border" style={{ zIndex: 10, overflow: "visible" as any }}>
          <Pressable
            onPress={() => {
              setSelectedPlan(null)
              setPlanContent(null)
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
              <View className="flex-row items-center gap-1.5 mt-0.5">
                <Text className="text-xs text-muted-foreground">
                  {formatDate(plan.createdAt)}
                </Text>
                <StatusBadge status={plan.status} />
              </View>
            ) : null}
          </View>

          {/* Model selector — shared Popover-based component */}
          <ModelPicker
            selectedModelId={buildMode}
            onModelChange={setBuildMode}
            placement="bottom right"
          />

          {/* Generate business summary — sits beside Build so it's the
              primary discovery surface for historic plans without a
              translation. Hidden when the plan already has one or while
              one is being produced. */}
          {canGenerateOnDemand && (
            <Pressable
              onPress={handleTranslate}
              className="flex-row items-center gap-1.5 rounded-lg border border-sky-500/40 bg-sky-500/10 px-3 py-1.5"
            >
              <Languages className="h-3.5 w-3.5 text-sky-400" size={14} />
              <Text className="text-xs font-semibold text-sky-400">Business</Text>
            </Pressable>
          )}
          {isTranslatingThisPlan && (
            <View className="flex-row items-center gap-1.5 rounded-lg border border-sky-500/30 bg-sky-500/5 px-3 py-1.5">
              <ActivityIndicator size="small" />
              <Text className="text-xs font-semibold text-sky-400">Translating...</Text>
            </View>
          )}

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

        {/* Tab strip — only when a business translation exists or is in flight */}
        {businessAvailable && (
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
                  activeTab === "technical"
                    ? "text-foreground"
                    : "text-muted-foreground"
                )}
              >
                Technical
              </Text>
            </Pressable>
            <Pressable
              onPress={() => setActiveTab("business")}
              className={cn(
                "flex-1 flex-row items-center justify-center gap-1.5 py-2",
                activeTab === "business" && "border-b-2 border-sky-400"
              )}
            >
              <Text
                className={cn(
                  "text-xs font-semibold",
                  activeTab === "business"
                    ? "text-sky-400"
                    : "text-muted-foreground"
                )}
              >
                Business
              </Text>
              {businessStatus === "pending" && <ActivityIndicator size="small" />}
            </Pressable>
          </View>
        )}

        {/* Detail body */}
        <ScrollView className="flex-1 px-4 py-3">
          {!isStreamingDetail && detailLoading ? (
            <ActivityIndicator className="mt-8" />
          ) : isBusinessTab ? (
            businessText ? (
              <MarkdownText>{businessText}</MarkdownText>
            ) : businessStatus === "pending" ? (
              <View className="flex-row items-center gap-2 py-3">
                <ActivityIndicator size="small" />
                <Text className="text-xs text-muted-foreground">
                  Generating business summary...
                </Text>
              </View>
            ) : businessStatus === "error" ? (
              <Text className="text-xs text-destructive">
                Failed to generate business summary. The technical plan is unaffected.
              </Text>
            ) : null
          ) : (
            <>
              {translateError ? (
                <Text className="mb-3 text-xs text-destructive">{translateError}</Text>
              ) : null}
              <MarkdownText>{body}</MarkdownText>

              {todos.length > 0 && (
                <View className="mt-4 border-t border-border pt-4">
                  <Text className="text-xs font-semibold text-muted-foreground mb-1">
                    TASKS ({todos.length})
                  </Text>
                  <TaskProgressBar todos={todos} />
                  <View className="mt-2">
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
                </View>
              )}
            </>
          )}
        </ScrollView>
      </View>
    )
  }

  // ── Diff comparison view ────────────────────────────────────────────
  if (diffMode && diffContents[0] && diffContents[1]) {
    const nameA = plans.find((p) => p.filename === diffTargets[0])?.name ?? diffTargets[0] ?? ""
    const nameB = plans.find((p) => p.filename === diffTargets[1])?.name ?? diffTargets[1] ?? ""
    const bodyA = extractPlanBody(diffContents[0])
    const bodyB = extractPlanBody(diffContents[1])

    const linesA = bodyA.split("\n")
    const linesB = bodyB.split("\n")
    const maxLen = Math.max(linesA.length, linesB.length)
    const diffLines: Array<{ type: "same" | "added" | "removed"; text: string }> = []
    for (let i = 0; i < maxLen; i++) {
      const la = linesA[i] ?? ""
      const lb = linesB[i] ?? ""
      if (la === lb) {
        diffLines.push({ type: "same", text: la })
      } else {
        if (la) diffLines.push({ type: "removed", text: la })
        if (lb) diffLines.push({ type: "added", text: lb })
      }
    }

    return (
      <View className="flex-1 bg-background">
        <View className="flex-row items-center gap-2 px-4 py-3 border-b border-border">
          <Pressable onPress={exitDiffMode} className="h-8 w-8 items-center justify-center rounded-lg">
            <ArrowLeft className="h-4 w-4 text-foreground" size={16} />
          </Pressable>
          <GitCompareArrows className="h-4 w-4 text-foreground" size={16} />
          <View className="flex-1 min-w-0">
            <Text className="font-semibold text-sm text-foreground" numberOfLines={1}>
              Comparing Plans
            </Text>
            <Text className="text-xs text-muted-foreground" numberOfLines={1}>
              {nameA} vs {nameB}
            </Text>
          </View>
        </View>
        <ScrollView className="flex-1 px-4 py-3">
          {diffLines.map((line, idx) => (
            <View
              key={idx}
              className={cn(
                "px-2 py-0.5 rounded-sm mb-0.5",
                line.type === "added" && "bg-emerald-500/10",
                line.type === "removed" && "bg-red-500/10"
              )}
            >
              <Text
                className={cn(
                  "text-xs font-mono",
                  line.type === "added" && "text-emerald-400",
                  line.type === "removed" && "text-red-400",
                  line.type === "same" && "text-foreground"
                )}
              >
                {line.type === "added" ? "+ " : line.type === "removed" ? "- " : "  "}
                {line.text}
              </Text>
            </View>
          ))}
        </ScrollView>
      </View>
    )
  }

  // ── Diff target selection UI ──────────────────────────────────────
  if (diffMode) {
    return (
      <View className="flex-1 bg-background">
        <View className="flex-row items-center gap-2 px-4 py-3 border-b border-border">
          <Pressable onPress={exitDiffMode} className="h-8 w-8 items-center justify-center rounded-lg">
            <ArrowLeft className="h-4 w-4 text-foreground" size={16} />
          </Pressable>
          <GitCompareArrows className="h-4 w-4 text-foreground" size={16} />
          <Text className="flex-1 font-semibold text-sm text-foreground">Select two plans to compare</Text>
          <Pressable
            onPress={handleStartDiff}
            disabled={!diffTargets[0] || !diffTargets[1] || diffLoading}
            className={cn(
              "rounded-lg px-3 py-1.5",
              diffTargets[0] && diffTargets[1] ? "bg-primary" : "bg-muted opacity-50"
            )}
          >
            {diffLoading ? (
              <ActivityIndicator size="small" />
            ) : (
              <Text className="text-xs font-bold text-primary-foreground">Compare</Text>
            )}
          </Pressable>
        </View>

        <View className="px-4 py-2 border-b border-border/60">
          <View className="flex-row items-center gap-2">
            <View className={cn("flex-1 rounded-md border px-2 py-1", diffTargets[0] ? "border-primary bg-primary/5" : "border-border")}>
              <Text className="text-[10px] text-muted-foreground">Plan A</Text>
              <Text className="text-xs text-foreground" numberOfLines={1}>
                {diffTargets[0] ? (plans.find((p) => p.filename === diffTargets[0])?.name ?? diffTargets[0]) : "Tap a plan"}
              </Text>
            </View>
            <Text className="text-xs text-muted-foreground">vs</Text>
            <View className={cn("flex-1 rounded-md border px-2 py-1", diffTargets[1] ? "border-primary bg-primary/5" : "border-border")}>
              <Text className="text-[10px] text-muted-foreground">Plan B</Text>
              <Text className="text-xs text-foreground" numberOfLines={1}>
                {diffTargets[1] ? (plans.find((p) => p.filename === diffTargets[1])?.name ?? diffTargets[1]) : "Tap a plan"}
              </Text>
            </View>
          </View>
        </View>

        <ScrollView className="flex-1">
          {plans.map((plan) => {
            const isA = diffTargets[0] === plan.filename
            const isB = diffTargets[1] === plan.filename
            return (
              <Pressable
                key={plan.filename}
                onPress={() => {
                  setDiffTargets(([a, b]) => {
                    if (isA) return [null, b]
                    if (isB) return [a, null]
                    if (!a) return [plan.filename, b]
                    if (!b && plan.filename !== a) return [a, plan.filename]
                    return [plan.filename, b]
                  })
                }}
                className={cn(
                  "flex-row items-center gap-3 px-4 py-3 border-b border-border/40",
                  (isA || isB) && "bg-primary/5"
                )}
              >
                <View className={cn("h-5 w-5 items-center justify-center rounded-full border", isA ? "border-primary bg-primary" : isB ? "border-sky-400 bg-sky-400" : "border-border")}>
                  {isA && <Text className="text-[9px] font-bold text-primary-foreground">A</Text>}
                  {isB && <Text className="text-[9px] font-bold text-white">B</Text>}
                </View>
                <View className="flex-1 min-w-0">
                  <Text className="font-medium text-sm text-foreground" numberOfLines={1}>{plan.name || plan.filename}</Text>
                  <Text className="text-xs text-muted-foreground/70 mt-0.5">{formatDate(plan.createdAt)}</Text>
                </View>
                <StatusBadge status={plan.status} />
              </Pressable>
            )
          })}
        </ScrollView>
      </View>
    )
  }

  // ── List view ─────────────────────────────────────────────────────
  return (
    <View className="flex-1 bg-background">
      {/* Header */}
      <View className="flex-row items-center justify-between px-4 py-3 border-b border-border">
        <View className="flex-row items-center gap-2">
          <ClipboardList className="h-4 w-4 text-foreground" size={16} />
          <Text className="font-semibold text-sm text-foreground">Plans</Text>
        </View>
        <View className="flex-row items-center gap-1.5">
          <Pressable
            testID="plans-dual-plan-toggle"
            onPress={handleDualPlanToggle}
            accessibilityLabel="Toggle business-language summaries for new plans"
            className={cn(
              "h-7 flex-row items-center gap-1 rounded-md px-2",
              dualPlan
                ? "border border-sky-500/45 bg-sky-500/12"
                : "bg-muted/50"
            )}
          >
            <Languages
              className={cn(
                "h-3 w-3",
                dualPlan ? "text-sky-400" : "text-muted-foreground"
              )}
              size={12}
            />
            <Text
              className={cn(
                "text-[11px] font-medium",
                dualPlan ? "text-sky-400" : "text-muted-foreground"
              )}
            >
              Business
            </Text>
          </Pressable>

          {/* Compare button */}
          {filteredPlans.length >= 2 && (
            <Pressable
              onPress={() => { setDiffMode(true); setBulkMode(false); setSelectedForBulk(new Set()) }}
              className="h-7 w-7 items-center justify-center rounded-md bg-muted/50"
            >
              <GitCompareArrows className="h-3.5 w-3.5 text-muted-foreground" size={14} />
            </Pressable>
          )}

          {/* Bulk select toggle */}
          {filteredPlans.length > 0 && (
            <Pressable
              onPress={() => {
                setBulkMode((v) => !v)
                setSelectedForBulk(new Set())
                setDiffMode(false)
              }}
              className={cn(
                "h-7 w-7 items-center justify-center rounded-md",
                bulkMode ? "bg-destructive/10" : "bg-muted/50"
              )}
            >
              <CheckSquare
                className={cn("h-3.5 w-3.5", bulkMode ? "text-destructive" : "text-muted-foreground")}
                size={14}
              />
            </Pressable>
          )}

          <Pressable onPress={fetchPlans} className="h-8 w-8 items-center justify-center rounded-lg">
            <RefreshCw className="h-3.5 w-3.5 text-muted-foreground" size={14} />
          </Pressable>
        </View>
      </View>

      {/* Bulk actions toolbar */}
      {bulkMode && (
        <View className="flex-row items-center justify-between px-4 py-2 border-b border-destructive/20 bg-destructive/5">
          <View className="flex-row items-center gap-2">
            <Pressable
              onPress={() => {
                if (selectedForBulk.size === filteredPlans.length) {
                  setSelectedForBulk(new Set())
                } else {
                  setSelectedForBulk(new Set(filteredPlans.map((p) => p.filename)))
                }
              }}
            >
              <Text className="text-xs font-medium text-foreground">
                {selectedForBulk.size === filteredPlans.length ? "Deselect all" : "Select all"}
              </Text>
            </Pressable>
            <Text className="text-xs text-muted-foreground">
              {selectedForBulk.size} selected
            </Text>
          </View>
          <View className="flex-row items-center gap-2">
            <Pressable
              onPress={() => { setBulkMode(false); setSelectedForBulk(new Set()) }}
              className="h-7 w-7 items-center justify-center rounded-md"
            >
              <X className="h-3.5 w-3.5 text-muted-foreground" size={14} />
            </Pressable>
            <Pressable
              onPress={handleBulkDelete}
              disabled={selectedForBulk.size === 0}
              className={cn(
                "flex-row items-center gap-1.5 rounded-lg px-3 py-1.5",
                selectedForBulk.size > 0 ? "bg-destructive" : "bg-muted opacity-50"
              )}
            >
              <Trash2 className="h-3 w-3 text-white" size={12} />
              <Text className="text-xs font-semibold text-white">Delete</Text>
            </Pressable>
          </View>
        </View>
      )}

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
          <ActivityIndicator className="mt-8" />
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
          filteredPlans.map((plan) => {
            const isChecked = selectedForBulk.has(plan.filename)
            return (
              <Pressable
                key={plan.filename}
                onPress={() => bulkMode ? toggleBulkSelection(plan.filename) : setSelectedPlan(plan.filename)}
                onLongPress={() => {
                  if (!bulkMode) {
                    setBulkMode(true)
                    setSelectedForBulk(new Set([plan.filename]))
                  }
                }}
                className={cn(
                  "flex-row items-center gap-3 px-4 py-3 border-b border-border/40",
                  bulkMode && isChecked ? "bg-destructive/5" : "active:bg-accent"
                )}
              >
                {bulkMode && (
                  <View className="items-center justify-center">
                    {isChecked ? (
                      <CheckSquare className="h-4 w-4 text-destructive" size={16} />
                    ) : (
                      <Square className="h-4 w-4 text-muted-foreground" size={16} />
                    )}
                  </View>
                )}
                <View className="flex-1 min-w-0">
                  <Text className="font-medium text-sm text-foreground" numberOfLines={1}>
                    {plan.name || plan.filename}
                  </Text>
                  {plan.overview ? (
                    <Text className="text-xs text-muted-foreground mt-0.5" numberOfLines={2}>
                      {plan.overview}
                    </Text>
                  ) : null}
                  <View className="flex-row items-center gap-2 mt-1">
                    <Text className="text-xs text-muted-foreground/70">
                      {formatDate(plan.createdAt)}
                    </Text>
                    <StatusBadge status={plan.status} />
                  </View>
                </View>
              </Pressable>
            )
          })
        ) : null}
      </ScrollView>
    </View>
  )
}
