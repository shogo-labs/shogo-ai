// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * BrowserWidget
 *
 * Renders an inline screenshot preview for the browser tool's screenshot action.
 * For non-screenshot actions (navigate, click, etc.), delegates to InlineToolWidget.
 */

import { useState, useCallback, useMemo } from "react"
import { View, Text, Image, Pressable, Linking, ActivityIndicator } from "react-native"
import { cn } from "@shogo/shared-ui/primitives"
import { Globe, ImageIcon } from "lucide-react-native"
import type { ToolCallData } from "../tools/types"
import { useChatContextSafe } from "../ChatContext"
import { InlineToolWidget, type InlineToolWidgetProps } from "./InlineToolWidget"

interface BrowserScreenshotDetails {
  ok?: boolean
  path?: string
  url?: string
  error?: string
}

function parseScreenshotResult(result: unknown): BrowserScreenshotDetails | null {
  if (!result || typeof result !== "object") return null
  const r = result as Record<string, unknown>

  if (r.details && typeof r.details === "object") {
    return r.details as BrowserScreenshotDetails
  }

  if (Array.isArray(r.content)) {
    const textPart = (r.content as any[]).find((c: any) => c.type === "text")
    if (textPart?.text) {
      try {
        return JSON.parse(textPart.text)
      } catch {
        return null
      }
    }
  }

  if (typeof r.path === "string") {
    return r as unknown as BrowserScreenshotDetails
  }

  return null
}

export interface BrowserWidgetProps extends Omit<InlineToolWidgetProps, "tool"> {
  tool: ToolCallData
}

export function BrowserWidget({ tool, ...inlineProps }: BrowserWidgetProps) {
  const isScreenshot = (tool.args as Record<string, unknown> | undefined)?.action === "screenshot"

  if (!isScreenshot) {
    return <InlineToolWidget tool={tool} {...inlineProps} />
  }

  return <BrowserScreenshotView tool={tool} />
}

function BrowserScreenshotView({ tool }: { tool: ToolCallData }) {
  const chatContext = useChatContextSafe()
  const [hasError, setHasError] = useState(false)
  const [isLoaded, setIsLoaded] = useState(false)

  const details = useMemo(() => parseScreenshotResult(tool.result), [tool.result])

  const imageUrl = useMemo(() => {
    const path = details?.path
    if (!path || !chatContext?.agentUrl) return null
    return `${chatContext.agentUrl}/agent/workspace/download/${path}?t=${Date.now()}`
  }, [details?.path, chatContext?.agentUrl])

  const pageUrl = details?.url

  const handlePress = useCallback(() => {
    if (imageUrl) Linking.openURL(imageUrl)
  }, [imageUrl])

  if (tool.state === "streaming") {
    return (
      <View className="overflow-hidden rounded-lg border border-border/60 bg-muted/50 dark:bg-muted/30 p-3">
        <View className="flex-row items-center gap-2">
          <ActivityIndicator size="small" />
          <Text className="text-xs text-muted-foreground">Taking screenshot...</Text>
        </View>
      </View>
    )
  }

  if (tool.state === "error") {
    return (
      <View className="overflow-hidden rounded-lg border border-destructive/30 bg-destructive/5 p-3">
        <View className="flex-row items-center gap-2">
          <Globe size={14} className="text-destructive" />
          <Text className="text-xs text-destructive">Screenshot failed</Text>
        </View>
        {tool.error && (
          <Text className="mt-1 text-xs text-muted-foreground">{tool.error}</Text>
        )}
      </View>
    )
  }

  if (!imageUrl) {
    return (
      <View className="overflow-hidden rounded-lg border border-border/60 bg-muted/50 dark:bg-muted/30 p-3">
        <View className="flex-row items-center gap-2">
          <Globe size={14} className="text-muted-foreground" />
          <Text className="text-xs text-muted-foreground">Screenshot taken</Text>
        </View>
      </View>
    )
  }

  return (
    <View>
      <Pressable onPress={handlePress} className="rounded-lg overflow-hidden border border-border/60">
        {!isLoaded && !hasError && (
          <View style={{ width: 320, aspectRatio: 16 / 10 }} className="bg-muted/50 items-center justify-center">
            <ActivityIndicator size="small" />
          </View>
        )}
        {hasError ? (
          <View style={{ width: 320, aspectRatio: 16 / 10 }} className="bg-muted/50 items-center justify-center rounded-lg p-4">
            <ImageIcon size={24} className="text-muted-foreground" />
            <Text className="mt-2 text-xs text-muted-foreground">Failed to load screenshot</Text>
          </View>
        ) : (
          <Image
            source={{ uri: imageUrl }}
            resizeMode="contain"
            accessibilityLabel="Browser screenshot"
            onError={() => setHasError(true)}
            onLoad={() => setIsLoaded(true)}
            style={[
              { width: 320, aspectRatio: 16 / 10 },
              !isLoaded && { height: 0, opacity: 0 },
            ]}
          />
        )}
      </Pressable>

      {pageUrl && (
        <View className="mt-1 px-0.5 flex-row items-center gap-1">
          <Globe size={10} className="text-muted-foreground/60" />
          <Text className="text-[10px] text-muted-foreground/60 flex-1" numberOfLines={1}>
            {pageUrl}
          </Text>
        </View>
      )}
    </View>
  )
}

export default BrowserWidget
