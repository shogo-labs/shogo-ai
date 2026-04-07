// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * InlineToolWidget Component (React Native)
 *
 * Compact inline tool display with expand/collapse for interleaved rendering.
 * Shows tool name, key argument, and state in collapsed view.
 * Expands to show full args and result.
 */

import { useState, useMemo, useCallback } from "react"
import { View, Text, Pressable, ScrollView, Image } from "react-native"
import { cn } from "@shogo/shared-ui/primitives"
import { CheckCircle2, XCircle, Loader2, AlertTriangle, ChevronRight } from "lucide-react-native"
import {
  type ToolCallData,
  formatToolName,
  getToolKeyArg,
} from "../tools/types"
import { useChatContextSafe } from "../ChatContext"

const MD_IMAGE_RE = /\[([^\]]*)\]\(([^)]+\.(png|jpg|jpeg|gif|webp))\)/gi

const AUTH_ERROR_PATTERNS = [
  'unauthorized', 'forbidden', 'not_authed', 'invalid_auth',
  'token expired', 'refresh token', 'invalid_grant', 'expired',
  'revoked', 'auth_expired', 'authexpired', 'credentials',
  'authorization failed', 'connection expired', 'authentication failed',
]

function detectAuthError(tool: ToolCallData): boolean {
  if (tool.state !== 'error') return false
  const errorText = (tool.error ?? '').toLowerCase()
  const resultText = typeof tool.result === 'string' ? tool.result.toLowerCase()
    : typeof tool.result === 'object' && tool.result ? JSON.stringify(tool.result).toLowerCase()
    : ''
  const combined = errorText + ' ' + resultText
  return AUTH_ERROR_PATTERNS.some(p => combined.includes(p))
}

export interface InlineToolWidgetProps {
  tool: ToolCallData
  isExpanded?: boolean
  onToggle?: () => void
  className?: string
}

export function InlineToolWidget({
  tool,
  isExpanded: controlledExpanded,
  onToggle,
  className,
}: InlineToolWidgetProps) {
  const [internalExpanded, setInternalExpanded] = useState(false)
  const isExpanded = controlledExpanded ?? internalExpanded

  const handleToggle = () => {
    if (onToggle) {
      onToggle()
    } else {
      setInternalExpanded(!internalExpanded)
    }
  }

  const chatContext = useChatContextSafe()
  const displayName = formatToolName(tool.toolName)
  const keyArg = getToolKeyArg(tool.toolName, tool.args)
  const isAuthErr = detectAuthError(tool)
  const [failedImages, setFailedImages] = useState<Set<string>>(new Set())

  const handleImageError = useCallback((uri: string) => {
    setFailedImages(prev => new Set(prev).add(uri))
  }, [])

  const resultImageUrls = useMemo(() => {
    const urls: string[] = []
    const agentUrl = chatContext?.agentUrl
    if (!agentUrl || !tool.result) return urls

    const resultText = typeof tool.result === 'string'
      ? tool.result
      : typeof tool.result === 'object' && (tool.result as any)?.text
        ? (tool.result as any).text
        : typeof tool.result === 'object'
          ? JSON.stringify(tool.result)
          : ''

    let match: RegExpExecArray | null
    MD_IMAGE_RE.lastIndex = 0
    while ((match = MD_IMAGE_RE.exec(resultText)) !== null) {
      const filePath = match[2]
      if (!filePath.startsWith('http')) {
        urls.push(`${agentUrl}/agent/workspace/download/${filePath}`)
      } else {
        urls.push(filePath)
      }
    }

    return urls
  }, [tool.result, chatContext?.agentUrl])

  const StateIcon = isAuthErr ? AlertTriangle : {
    streaming: Loader2,
    success: CheckCircle2,
    error: XCircle,
  }[tool.state]

  const formatJson = (data: unknown): string => {
    if (typeof data === 'string') {
      try {
        return JSON.stringify(JSON.parse(data), null, 2)
      } catch {
        return data
      }
    }
    try {
      return JSON.stringify(data, null, 2)
    } catch {
      return String(data)
    }
  }

  const getDisplayableResult = (): string => {
    if (tool.error) return typeof tool.error === 'string' ? tool.error : String(tool.error)
    if (tool.result === undefined || tool.result === null) return ""
    if (typeof tool.result === "string") return tool.result
    const r = tool.result as Record<string, unknown>
    if (r.stderr && typeof r.stderr === "string") {
      const stdout = typeof r.stdout === "string" ? r.stdout : ""
      return stdout ? `${stdout}\n${r.stderr}` : r.stderr
    }
    if (r.stdout && typeof r.stdout === "string") return r.stdout
    if (r.text && typeof r.text === "string") return r.text
    return formatJson(tool.result)
  }

  return (
    <View className={cn("overflow-hidden rounded-lg border border-border/60 bg-muted/50 dark:bg-muted/30", className)}>
      <Pressable
        onPress={handleToggle}
        className="group w-full flex-row items-center gap-2 px-1 py-1"
      >
        <View className="group-hover:hidden">
          <StateIcon
            className={cn(
              "w-3 h-3",
              tool.state === "streaming" && "text-muted-foreground/60",
              tool.state === "success" && "text-muted-foreground/60",
              tool.state === "error" && (isAuthErr ? "text-orange-500" : "text-red-500"),
            )}
          />
        </View>
        <View className="hidden group-hover:flex">
          <ChevronRight className="w-3 h-3 text-muted-foreground" />
        </View>

        <Text className="flex-1 text-[11px] text-muted-foreground" numberOfLines={1}>
          <Text className="font-medium text-muted-foreground">{displayName}</Text>
          {keyArg ? (
            <Text className="text-muted-foreground/50"> {keyArg}</Text>
          ) : null}
        </Text>
      </Pressable>

      {isExpanded && (
        <View className="border-t border-border/60 px-2 py-2 gap-1.5">
          {tool.args && Object.keys(tool.args).length > 0 && (
            <View className="gap-0.5">
              <Text className="text-[9px] font-medium text-muted-foreground uppercase tracking-wide">
                Args
              </Text>
              <ScrollView nestedScrollEnabled className="bg-background/50 rounded p-1.5 max-h-32">
                <Text className="text-[10px] font-mono text-foreground" selectable>
                  {formatJson(tool.args)}
                </Text>
              </ScrollView>
            </View>
          )}

          {tool.state === "success" && tool.result !== undefined && (
            <View className="gap-1">
              {resultImageUrls.length > 0 && (
                <View className="gap-1">
                  {resultImageUrls.filter(uri => !failedImages.has(uri)).map((uri, i) => (
                    <Image
                      key={uri}
                      source={{ uri }}
                      style={{ width: '100%' as any, aspectRatio: 16 / 10, borderRadius: 6 }}
                      className="border border-border"
                      resizeMode="contain"
                      onError={() => handleImageError(uri)}
                    />
                  ))}
                </View>
              )}
              <View className="gap-0.5">
                <Text className="text-[9px] font-medium text-muted-foreground uppercase tracking-wide">
                  Result
                </Text>
                <ScrollView nestedScrollEnabled className="bg-background/50 rounded p-1.5 max-h-32">
                  <Text className="text-[10px] font-mono text-foreground" selectable>
                    {formatJson(tool.result)}
                  </Text>
                </ScrollView>
              </View>
            </View>
          )}

          {tool.state === "error" && isAuthErr && (
            <View className="gap-0.5">
              <Text className="text-[9px] font-medium text-orange-500 uppercase tracking-wide">
                Connection Expired
              </Text>
              <View className="bg-orange-500/10 rounded p-1.5">
                <Text className="text-[10px] font-mono text-orange-600 dark:text-orange-400" selectable>
                  {getDisplayableResult() || "Authorization failed or token expired"}
                </Text>
                <Text className="text-[9px] text-orange-500 mt-1">
                  Reconnect from the banner above or the Capabilities tab.
                </Text>
              </View>
            </View>
          )}

          {tool.state === "error" && !isAuthErr && (
            <View className="gap-0.5">
              <Text className="text-[9px] font-medium text-red-500 uppercase tracking-wide">
                Error
              </Text>
              <ScrollView nestedScrollEnabled className="bg-red-500/10 rounded p-1.5 max-h-32">
                <Text className="text-[10px] font-mono text-red-500" selectable>
                  {getDisplayableResult() || "No output captured"}
                </Text>
              </ScrollView>
            </View>
          )}

          {tool.duration !== undefined && tool.duration > 0 && (
            <Text className="text-[9px] text-muted-foreground">
              {tool.duration < 1000 ? `${tool.duration}ms` : `${(tool.duration / 1000).toFixed(2)}s`}
            </Text>
          )}
        </View>
      )}
    </View>
  )
}

export default InlineToolWidget
