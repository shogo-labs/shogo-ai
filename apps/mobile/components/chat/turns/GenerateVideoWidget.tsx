// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * GenerateVideoWidget
 *
 * Card for the generate_video tool: an elapsed-time spinner while the clip
 * renders, then an inline player with save/share. A `wait: false` job shows
 * as queued with the path it will be saved to.
 */

import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react"
import { View, Text, Pressable, ActivityIndicator } from "react-native"
import { Motion } from "@legendapp/motion"
import { Clapperboard, Download, RefreshCw, Share2 } from "lucide-react-native"
import type { ToolCallData } from "../tools/types"
import { useChatContextSafe } from "../ChatContext"
import { buildAgentWorkspaceUrl } from "../../../lib/agent-workspace-url"
import { useChatImageWidth } from "./use-chat-image-width"
import { runGeneratedImageAction } from "../generated-image-actions"
import { parseGenerateVideoResult, videoCardState } from "./generate-video-result"

const GeneratedVideoPlayer = lazy(() => import("./GeneratedVideoPlayer"))

function aspectFromArg(value: unknown): number {
  if (typeof value !== "string") return 16 / 9
  const [w, h] = value.split(":").map(Number)
  return w > 0 && h > 0 ? w / h : 16 / 9
}

export interface GenerateVideoWidgetProps {
  tool: ToolCallData
}

export function GenerateVideoWidget({ tool }: GenerateVideoWidgetProps) {
  const chatContext = useChatContextSafe()
  const [elapsed, setElapsed] = useState(0)
  const [action, setAction] = useState<"save" | "share" | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [playerFailed, setPlayerFailed] = useState(false)

  const result = useMemo(() => parseGenerateVideoResult(tool.result), [tool.result])
  const args = (tool.args ?? {}) as Record<string, unknown>
  const prompt = typeof args.prompt === "string" ? args.prompt : result?.prompt || "AI generated video"
  const aspectRatio = aspectFromArg(args.aspect_ratio)
  const width = useChatImageWidth(240, 480)
  const state = videoCardState(result, tool.state)

  const videoUrl = useMemo(() => {
    if (state !== "ready" || !result?.path || !chatContext?.agentUrl) return null
    return buildAgentWorkspaceUrl(chatContext.agentUrl, result.path)
  }, [state, result?.path, chatContext?.agentUrl])

  useEffect(() => {
    if (tool.state !== "streaming") {
      setElapsed(0)
      return
    }
    const startedAt = Date.now()
    const interval = setInterval(() => setElapsed(Date.now() - startedAt), 1000)
    return () => clearInterval(interval)
  }, [tool.state])

  useEffect(() => setPlayerFailed(false), [videoUrl])

  const handleAction = useCallback(
    async (next: "save" | "share") => {
      if (!videoUrl || action) return
      setAction(next)
      setActionError(null)
      try {
        await runGeneratedImageAction(next, videoUrl, "generated-video", "video/mp4")
      } catch (error) {
        setActionError(error instanceof Error ? error.message : "Video action failed")
      } finally {
        setAction(null)
      }
    },
    [action, videoUrl],
  )

  const handleRetry = useCallback(() => {
    if (prompt && chatContext?.sendMessage) chatContext.sendMessage(prompt)
  }, [chatContext?.sendMessage, prompt])

  const meta = [
    result?.model,
    result?.duration ? `${result.duration}s` : null,
    result?.audio ? "with audio" : null,
  ].filter(Boolean).join(" · ")

  if (state === "failed") {
    return (
      <View className="mx-3 my-1.5 rounded-xl border border-destructive/30 bg-destructive/5 p-3">
        <View className="flex-row items-center gap-2">
          <Clapperboard size={16} className="text-destructive" />
          <Text className="flex-1 text-sm font-medium text-destructive">Video generation failed</Text>
          <Pressable
            onPress={handleRetry}
            className="min-h-11 flex-row items-center gap-1 rounded-lg px-2 active:bg-destructive/10"
            accessibilityRole="button"
            accessibilityLabel="Try generating the video again"
          >
            <RefreshCw size={14} className="text-destructive" />
            <Text className="text-xs font-medium text-destructive">Try again</Text>
          </Pressable>
        </View>
        <Text className="mt-1 text-xs text-muted-foreground">{String(result?.error ?? "Unknown error")}</Text>
      </View>
    )
  }

  if (state === "rendering" || state === "queued") {
    const minutes = Math.floor(elapsed / 60_000)
    const seconds = Math.floor((elapsed % 60_000) / 1000)
    const clock = elapsed ? ` · ${minutes ? `${minutes}m ` : ""}${seconds}s` : "…"
    return (
      <View
        testID="generated-video-card"
        className="mx-3 my-1.5 overflow-hidden rounded-xl border border-border bg-muted/50"
        style={{ width, aspectRatio }}
      >
        <View className="flex-1 items-center justify-center p-4">
          {state === "rendering" ? (
            <Motion.View
              initial={{ opacity: 0.45, scale: 0.92 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ type: "timing", duration: 900, repeat: Infinity, repeatReverse: true }}
              className="h-12 w-12 items-center justify-center rounded-full bg-primary/10"
            >
              <ActivityIndicator size="small" />
            </Motion.View>
          ) : (
            <View className="h-12 w-12 items-center justify-center rounded-full bg-primary/10">
              <Clapperboard size={20} className="text-primary" />
            </View>
          )}
          <Text className="mt-2 text-sm font-medium text-foreground">
            {state === "rendering" ? `Rendering video${clock}` : "Video queued"}
          </Text>
          <Text className="mt-1 text-center text-xs text-muted-foreground" numberOfLines={2}>
            {state === "queued" && result?.planned_path ? `Will be saved to ${result.planned_path}` : prompt}
          </Text>
        </View>
      </View>
    )
  }

  return (
    <View testID="generated-video-card" className="mx-3 my-1.5">
      {videoUrl && !playerFailed ? (
        <Suspense
          fallback={
            <View className="items-center justify-center rounded-lg bg-muted/50" style={{ width, aspectRatio }}>
              <ActivityIndicator size="small" />
            </View>
          }
        >
          <GeneratedVideoPlayer
            url={videoUrl}
            width={width}
            aspectRatio={aspectRatio}
            onError={() => setPlayerFailed(true)}
          />
        </Suspense>
      ) : (
        <View
          className="items-center justify-center rounded-lg border border-border bg-muted/50 p-4"
          style={{ width, aspectRatio }}
        >
          <Clapperboard size={24} className="text-muted-foreground" />
          <Text className="mt-2 text-xs text-muted-foreground">
            {playerFailed ? "Failed to load video" : result?.path}
          </Text>
        </View>
      )}

      <View className="mt-1 flex-row items-center gap-1 px-1" style={{ width }}>
        <Pressable
          onPress={() => void handleAction("save")}
          disabled={!!action || !videoUrl}
          className="min-h-11 flex-1 flex-row items-center justify-center gap-1 rounded-lg active:bg-muted"
          accessibilityRole="button"
          accessibilityLabel="Download generated video"
        >
          {action === "save" ? <ActivityIndicator size="small" /> : <Download size={14} className="text-foreground" />}
          <Text className="text-xs font-medium text-foreground">Download</Text>
        </Pressable>
        <Pressable
          onPress={() => void handleAction("share")}
          disabled={!!action || !videoUrl}
          className="min-h-11 flex-1 flex-row items-center justify-center gap-1 rounded-lg active:bg-muted"
          accessibilityRole="button"
          accessibilityLabel="Share generated video"
        >
          {action === "share" ? <ActivityIndicator size="small" /> : <Share2 size={14} className="text-foreground" />}
          <Text className="text-xs font-medium text-foreground">Share</Text>
        </Pressable>
      </View>
      {actionError ? <Text className="px-1 text-[11px] text-destructive">{actionError}</Text> : null}
      <Text className="px-1 py-1 text-[11px] text-muted-foreground/80" numberOfLines={2} style={{ width }}>
        {meta ? `${meta} · ` : ""}{result?.path}
      </Text>
    </View>
  )
}

export default GenerateVideoWidget
