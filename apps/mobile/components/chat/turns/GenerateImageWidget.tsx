// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * GenerateImageWidget
 *
 * Renders an inline image preview for the generate_image tool output.
 * Constructs the workspace download URL from the agent proxy base URL
 * and the image path returned in the tool result.
 */

import { useState, useCallback, useEffect, useMemo } from "react"
import {
  View,
  Text,
  Image,
  Pressable,
  ActivityIndicator,
  Platform,
} from "react-native"
import { cn } from "@shogo/shared-ui/primitives"
import { Motion } from "@legendapp/motion"
import {
  Copy,
  Download,
  ImageIcon,
  Maximize2,
  MoreHorizontal,
  RefreshCw,
  Share2,
} from "lucide-react-native"
import type { ToolCallData } from "../tools/types"
import { useChatContextSafe } from "../ChatContext"
import { ChatImageContextMenu, ImagePreviewModal } from "../ImagePreviewModal"
import { downloadImage, isShogoDesktop } from "../chatImageActions"
import { useAgentImageSource } from "../../../lib/agent-image-source"
import { buildAgentWorkspaceUrl } from "../../../lib/agent-workspace-url"
import { useChatImageWidth } from "./use-chat-image-width"
import { clampAspectRatio, parseImageSize } from "./image-sizing"
import { runGeneratedImageAction } from "../generated-image-actions"
import { GeneratedImageGallery } from "./GeneratedImageGallery"
import {
  getGenerateImagePaths,
  parseGenerateImageResult,
} from "./generate-image-result"

export interface GenerateImageWidgetProps {
  tool: ToolCallData
}

export function GenerateImageWidget({ tool }: GenerateImageWidgetProps) {
  const chatContext = useChatContextSafe()
  const [hasError, setHasError] = useState(false)
  const [isLoaded, setIsLoaded] = useState(false)
  const [showPreview, setShowPreview] = useState(false)
  const [showMore, setShowMore] = useState(false)
  const [showPrompt, setShowPrompt] = useState(false)
  const [action, setAction] = useState<"save" | "share" | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const [aspectRatio, setAspectRatio] = useState(4 / 3)
  const [imageAttempt, setImageAttempt] = useState(0)
  const [contextMenu, setContextMenu] = useState<{
    x: number
    y: number
  } | null>(null)

  const result = useMemo(
    () => parseGenerateImageResult(tool.result),
    [tool.result],
  )
  const imagePaths = useMemo(() => getGenerateImagePaths(result), [result])
  const args = (tool.args ?? {}) as Record<string, unknown>
  const prompt =
    typeof args.prompt === "string" ? args.prompt : "AI generated image"
  const imageWidth = useChatImageWidth(220, 420)

  const imageUrl = useMemo(() => {
    if (!result?.path || !chatContext?.agentUrl) return null
    return buildAgentWorkspaceUrl(chatContext.agentUrl, result.path)
  }, [result?.path, chatContext?.agentUrl])
  const imageSource = useAgentImageSource(imageUrl)

  useEffect(() => {
    if (tool.state !== "streaming") {
      setElapsed(0)
      return
    }
    const startedAt = Date.now()
    const interval = setInterval(() => setElapsed(Date.now() - startedAt), 1000)
    return () => clearInterval(interval)
  }, [tool.state])

  useEffect(() => {
    setAspectRatio(
      parseImageSize(
        result?.size ?? (typeof args.size === "string" ? args.size : undefined),
      ),
    )
    setHasError(false)
    setIsLoaded(false)
  }, [args.size, result?.path, result?.size])

  const handlePress = useCallback(() => {
    if (imageUrl) setShowPreview(true)
  }, [imageUrl])

  const handleContextMenu = useCallback(
    (event: any) => {
      // The custom right-click menu is desktop-only; on web we let the browser
      // show its native context menu.
      if (!isShogoDesktop() || !imageUrl) return
      event.preventDefault?.()
      event.stopPropagation?.()
      const nativeEvent = event.nativeEvent ?? event
      setContextMenu({
        x: nativeEvent.clientX ?? 0,
        y: nativeEvent.clientY ?? 0,
      })
    },
    [imageUrl],
  )

  const handleDownloadImage = useCallback(() => {
    if (imageUrl) void downloadImage(imageUrl, "generated-image", "image/png")
  }, [imageUrl])

  const handleRetry = useCallback(() => {
    if (prompt && chatContext?.sendMessage) chatContext.sendMessage(prompt)
  }, [chatContext?.sendMessage, prompt])

  const handleAction = useCallback(
    async (nextAction: "save" | "share") => {
      if (!imageUrl || action) return
      setAction(nextAction)
      setActionError(null)
      try {
        await runGeneratedImageAction(
          nextAction,
          imageUrl,
          "generated-image",
          "image/png",
        )
      } catch (error) {
        setActionError(
          error instanceof Error ? error.message : "Image action failed",
        )
      } finally {
        setAction(null)
      }
    },
    [action, imageUrl],
  )

  if (imagePaths.length > 1 && !result?.error) {
    return <GeneratedImageGallery tools={[{ tool, id: tool.id }]} />
  }

  if (result?.error) {
    return (
      <View className="mx-3 my-1.5 rounded-xl border border-destructive/30 bg-destructive/5 p-3">
        <View className="flex-row items-center gap-2">
          <ImageIcon size={16} className="text-destructive" />
          <Text className="flex-1 text-sm font-medium text-destructive">
            Image generation failed
          </Text>
          <Pressable
            onPress={handleRetry}
            className="min-h-11 flex-row items-center gap-1 rounded-lg px-2 active:bg-destructive/10"
            accessibilityRole="button"
            accessibilityLabel="Try generating the image again"
          >
            <RefreshCw size={14} className="text-destructive" />
            <Text className="text-xs font-medium text-destructive">
              Try again
            </Text>
          </Pressable>
        </View>
        <Text className="mt-1 text-xs text-muted-foreground">
          {typeof result.error === "string"
            ? result.error
            : String(result.error)}
        </Text>
      </View>
    )
  }

  if (!result?.path || !imageUrl) {
    return (
      <View
        testID="generated-image-card"
        className="mx-3 my-1.5 overflow-hidden rounded-xl border border-border bg-muted/50"
        style={{ width: imageWidth, aspectRatio }}
      >
        <View className="flex-1 items-center justify-center p-4">
          <Motion.View
            initial={{ opacity: 0.45, scale: 0.92 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{
              type: "timing",
              duration: 900,
              repeat: Infinity,
              repeatReverse: true,
            }}
            className="h-12 w-12 items-center justify-center rounded-full bg-primary/10"
          >
            <ActivityIndicator size="small" />
          </Motion.View>
          <Text className="mt-2 text-sm font-medium text-foreground">
            Creating image{elapsed ? ` · ${Math.floor(elapsed / 1000)}s` : "…"}
          </Text>
          <Text
            className="mt-1 text-center text-xs text-muted-foreground"
            numberOfLines={2}
          >
            {prompt}
          </Text>
        </View>
      </View>
    )
  }

  return (
    <View testID="generated-image-card" className="mx-3 my-1.5">
      <Pressable
        onPress={handlePress}
        {...(Platform.OS === "web"
          ? ({ onContextMenu: handleContextMenu } as any)
          : {})}
        className={cn(
          "rounded-lg overflow-hidden border border-border",
          Platform.OS === "web" && "cursor-zoom-in",
        )}
        accessibilityRole="button"
        accessibilityLabel="Open generated image preview"
        accessibilityHint="Opens a larger preview."
      >
        <View
          className="items-center justify-center bg-muted/50"
          style={{ width: imageWidth, aspectRatio }}
        >
          {!isLoaded && !hasError ? <ActivityIndicator size="small" /> : null}
          {hasError ? (
            <>
              <ImageIcon size={24} className="text-muted-foreground" />
              <Text className="mt-2 text-xs text-muted-foreground">
                Failed to load image
              </Text>
              <Pressable
                onPress={() => {
                  setHasError(false)
                  setIsLoaded(false)
                  setImageAttempt((attempt) => attempt + 1)
                }}
                className="mt-2 min-h-11 flex-row items-center gap-1 rounded-lg border border-border px-3 active:bg-muted"
              >
                <RefreshCw size={13} className="text-foreground" />
                <Text className="text-xs font-medium text-foreground">
                  Retry
                </Text>
              </Pressable>
            </>
          ) : null}
          {imageSource ? (
            <Image
              key={imageAttempt}
              source={imageSource}
              className="rounded-t-lg"
              resizeMode="contain"
              accessibilityLabel={`Generated image: ${result.revised_prompt || prompt}`}
              onError={() => setHasError(true)}
              onLoad={(event) => {
                const source = event.nativeEvent?.source
                if (source?.width && source?.height) {
                  setAspectRatio(clampAspectRatio(source.width, source.height))
                }
                setIsLoaded(true)
              }}
              style={{
                position: "absolute",
                width: imageWidth,
                height: imageWidth / aspectRatio,
                opacity: isLoaded && !hasError ? 1 : 0,
              }}
            />
          ) : null}
        </View>
      </Pressable>

      <View className="mt-1 flex-row items-center gap-1 px-1">
        <Pressable
          onPress={() => void handleAction("save")}
          disabled={!!action}
          className="min-h-11 flex-1 flex-row items-center justify-center gap-1 rounded-lg active:bg-muted"
          accessibilityRole="button"
          accessibilityLabel="Save generated image"
        >
          {action === "save" ? (
            <ActivityIndicator size="small" />
          ) : (
            <Download size={14} className="text-foreground" />
          )}
          <Text className="text-xs font-medium text-foreground">Save</Text>
        </Pressable>
        <Pressable
          onPress={() => void handleAction("share")}
          disabled={!!action}
          className="min-h-11 flex-1 flex-row items-center justify-center gap-1 rounded-lg active:bg-muted"
          accessibilityRole="button"
          accessibilityLabel="Share generated image"
        >
          {action === "share" ? (
            <ActivityIndicator size="small" />
          ) : (
            <Share2 size={14} className="text-foreground" />
          )}
          <Text className="text-xs font-medium text-foreground">Share</Text>
        </Pressable>
        <Pressable
          onPress={() => setShowMore((value) => !value)}
          className="min-h-11 w-11 items-center justify-center rounded-lg active:bg-muted"
          accessibilityRole="button"
          accessibilityLabel="More image actions"
        >
          <MoreHorizontal size={18} className="text-muted-foreground" />
        </Pressable>
      </View>
      {actionError ? (
        <Text className="px-1 text-[11px] text-destructive">{actionError}</Text>
      ) : null}
      {showMore ? (
        <View className="mt-1 rounded-xl border border-border bg-background p-1">
          <Pressable
            onPress={() => {
              setShowPreview(true)
              setShowMore(false)
            }}
            className="min-h-11 flex-row items-center gap-2 rounded-lg px-3 active:bg-muted"
          >
            <Maximize2 size={14} className="text-muted-foreground" />
            <Text className="flex-1 text-xs text-foreground">
              Open full screen
            </Text>
          </Pressable>
          <Pressable
            onPress={async () => {
              const Clipboard = await import("expo-clipboard")
              await Clipboard.setStringAsync(prompt)
              setShowMore(false)
            }}
            className="min-h-11 flex-row items-center gap-2 rounded-lg px-3 active:bg-muted"
          >
            <Copy size={14} className="text-muted-foreground" />
            <Text className="text-xs text-foreground">Copy prompt</Text>
          </Pressable>
          <View className="px-3 py-2">
            <Text className="text-[11px] text-muted-foreground">
              {result.model || "AI"} · {result.size || "1024x1024"}
              {result.reference_image
                ? ` · Edited from ${result.reference_image}`
                : ""}
            </Text>
          </View>
        </View>
      ) : null}
      {result.revised_prompt && result.revised_prompt !== prompt ? (
        <Pressable
          onPress={() => setShowPrompt((value) => !value)}
          className="px-1 py-1"
        >
          <Text
            className="text-[11px] text-muted-foreground/80"
            numberOfLines={showPrompt ? undefined : 2}
          >
            {showPrompt ? "Revised prompt: " : "Prompt: "}
            {result.revised_prompt}
          </Text>
        </Pressable>
      ) : null}
      <ImagePreviewModal
        visible={showPreview}
        onClose={() => setShowPreview(false)}
        url={imageUrl}
        mediaType="image/png"
        title="Generated image"
        alt={`Generated image: ${result.revised_prompt || prompt}`}
        onSave={() => handleAction("save")}
        onShare={() => handleAction("share")}
      />
      {contextMenu ? (
        <ChatImageContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onDownload={handleDownloadImage}
          onClose={() => setContextMenu(null)}
        />
      ) : null}
    </View>
  )
}

export default GenerateImageWidget
