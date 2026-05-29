// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * GenerateImageWidget
 *
 * Renders an inline image preview for the generate_image tool output.
 * Constructs the workspace download URL from the agent proxy base URL
 * and the image path returned in the tool result.
 */

import { useState, useCallback, useMemo } from "react"
import { View, Text, Image, Pressable, ActivityIndicator, Platform } from "react-native"
import { cn } from "@shogo/shared-ui/primitives"
import { ImageIcon, Pencil } from "lucide-react-native"
import type { ToolCallData } from "../tools/types"
import { useChatContextSafe } from "../ChatContext"
import { ChatImageContextMenu, ImagePreviewModal } from "../ImagePreviewModal"
import { downloadImage, isShogoDesktop } from "../chatImageActions"

export interface GenerateImageWidgetProps {
  tool: ToolCallData
}

interface GenerateImageResult {
  path?: string
  size?: string
  model?: string
  quality?: string
  bytes?: number
  revised_prompt?: string
  reference_image?: string
  error?: string
}

function parseResult(result: unknown): GenerateImageResult | null {
  if (!result) return null
  if (typeof result === "string") {
    try {
      return JSON.parse(result)
    } catch {
      return null
    }
  }
  return result as GenerateImageResult
}

export function GenerateImageWidget({ tool }: GenerateImageWidgetProps) {
  const chatContext = useChatContextSafe()
  const [hasError, setHasError] = useState(false)
  const [isLoaded, setIsLoaded] = useState(false)
  const [showPreview, setShowPreview] = useState(false)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)

  const result = useMemo(() => parseResult(tool.result), [tool.result])

  const imageUrl = useMemo(() => {
    if (!result?.path || !chatContext?.agentUrl) return null
    return `${chatContext.agentUrl}/agent/workspace/download/${result.path}`
  }, [result?.path, chatContext?.agentUrl])

  const handlePress = useCallback(() => {
    if (imageUrl) setShowPreview(true)
  }, [imageUrl])

  const handleContextMenu = useCallback((event: any) => {
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
  }, [imageUrl])

  const handleDownloadImage = useCallback(() => {
    if (imageUrl) void downloadImage(imageUrl, "generated-image", "image/png")
  }, [imageUrl])

  if (tool.state === "streaming") {
    return (
      <View className="mx-3 my-1.5 rounded-lg border border-border bg-muted/50 p-3">
        <View className="flex-row items-center gap-2">
          <ActivityIndicator size="small" />
          <Text className="text-xs text-muted-foreground">Generating image...</Text>
        </View>
      </View>
    )
  }

  if (result?.error) {
    return (
      <View className="mx-3 my-1.5 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
        <View className="flex-row items-center gap-2">
          <ImageIcon size={14} className="text-destructive" />
          <Text className="text-xs text-destructive">Image generation failed</Text>
        </View>
        <Text className="mt-1 text-xs text-muted-foreground">{typeof result.error === 'string' ? result.error : String(result.error)}</Text>
      </View>
    )
  }

  if (!result?.path || !imageUrl) {
    return (
      <View className="mx-3 my-1.5 rounded-lg border border-border bg-muted/50 p-3">
        <View className="flex-row items-center gap-2">
          <ImageIcon size={14} className="text-muted-foreground" />
          <Text className="text-xs text-muted-foreground">Image generated</Text>
        </View>
      </View>
    )
  }

  return (
    <View className="mx-3 my-1.5">
      <Pressable
        onPress={handlePress}
        {...(Platform.OS === "web" ? { onContextMenu: handleContextMenu } as any : {})}
        className={cn(
          "rounded-lg overflow-hidden border border-border",
          Platform.OS === "web" && "cursor-zoom-in",
        )}
        accessibilityRole="button"
        accessibilityLabel="Open generated image preview"
        accessibilityHint="Opens a larger preview."
      >
        {!isLoaded && !hasError && (
          <View className="w-[280px] bg-muted/50 items-center justify-center" style={{ aspectRatio: 1 }}>
            <ActivityIndicator size="small" />
          </View>
        )}
        {hasError ? (
          <View className="w-[280px] bg-muted/50 items-center justify-center rounded-lg p-4" style={{ aspectRatio: 1 }}>
            <ImageIcon size={24} className="text-muted-foreground" />
            <Text className="mt-2 text-xs text-muted-foreground">Failed to load image</Text>
          </View>
        ) : (
          <Image
            source={{ uri: imageUrl }}
            className="max-w-[280px] rounded-t-lg"
            resizeMode="contain"
            accessibilityLabel={`Generated image: ${result.revised_prompt || "AI generated"}`}
            onError={() => setHasError(true)}
            onLoad={() => setIsLoaded(true)}
            style={[
              { width: 280, aspectRatio: 1 },
              !isLoaded && { height: 0, opacity: 0 },
            ]}
          />
        )}
      </Pressable>

      <View className="mt-1.5 px-1 gap-0.5">
        <View className="flex-row items-center gap-1.5">
          {result.reference_image ? (
            <Pencil size={10} className="text-muted-foreground" />
          ) : (
            <ImageIcon size={10} className="text-muted-foreground" />
          )}
          <Text className="text-[10px] text-muted-foreground" numberOfLines={1}>
            {result.model || "AI"} · {result.size || "1024x1024"}
            {result.reference_image ? ` · Edited from ${result.reference_image}` : ""}
          </Text>
        </View>
        {result.revised_prompt && typeof result.revised_prompt === 'string' && result.revised_prompt !== tool.args?.prompt && (
          <Text className="text-[10px] text-muted-foreground/70" numberOfLines={2}>
            {result.revised_prompt}
          </Text>
        )}
      </View>
      <ImagePreviewModal
        visible={showPreview}
        onClose={() => setShowPreview(false)}
        url={imageUrl}
        mediaType="image/png"
        title="Generated image"
        alt={`Generated image: ${result.revised_prompt || "AI generated"}`}
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
