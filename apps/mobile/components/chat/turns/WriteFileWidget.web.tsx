// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * WriteFileWidget (Web) — write_file / Write display with Shiki
 * syntax highlighting for the code preview.
 */

import { useState, useEffect, useRef, useMemo, memo } from "react"
import { View, Text, Pressable, ScrollView } from "react-native"
import { useResolvedTheme } from "../../../contexts/theme"
import { cn } from "@shogo/shared-ui/primitives"
import { FilePlus2, Loader2, CheckCircle2, XCircle, ChevronRight, ChevronDown } from "lucide-react-native"
import type { ToolCallData } from "../tools/types"
import { getBasename, getLanguageFromPath, getLanguageLabel } from "./file-lang-map"

const MAX_PREVIEW_LINES = 40
const MAX_PREVIEW_CHARS = 4000

export interface WriteFileWidgetProps {
  tool: ToolCallData
  isExpanded?: boolean
  onToggle?: () => void
  className?: string
}

function extractWriteData(tool: ToolCallData) {
  const path = (tool.args?.path ?? tool.args?.file_path) as string | undefined
  const content = (tool.args?.content ?? "") as string
  const append = tool.args?.append as boolean | undefined
  const bytes = typeof (tool.result as any)?.bytes === "number"
    ? (tool.result as any).bytes
    : content.length
  return { path: path || "unknown", content, append, bytes }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`
  return `${(n / (1024 * 1024)).toFixed(1)}MB`
}

function truncateContent(text: string): { display: string; truncated: boolean; totalLines: number } {
  const lines = text.split("\n")
  const totalLines = lines.length
  if (text.length <= MAX_PREVIEW_CHARS && totalLines <= MAX_PREVIEW_LINES) {
    return { display: text, truncated: false, totalLines }
  }
  const kept = lines.slice(0, MAX_PREVIEW_LINES)
  const trimmed = kept.join("\n").slice(0, MAX_PREVIEW_CHARS)
  return { display: trimmed, truncated: true, totalLines }
}

const SHIKI_DEBOUNCE_MS = 150

const HighlightedCode = memo(function HighlightedCode({ code, language }: { code: string; language: string }) {
  const isDark = useResolvedTheme() === "dark"
  const containerRef = useRef<HTMLDivElement>(null)
  const [fallback, setFallback] = useState(false)

  useEffect(() => {
    let cancelled = false
    const timer = setTimeout(() => {
      ;(async () => {
        try {
          const { codeToHtml } = await import("shiki")
          const html = await codeToHtml(code, {
            lang: language === "text" ? "plaintext" : language,
            theme: isDark ? "github-dark-default" : "github-light-high-contrast",
          })
          if (!cancelled && containerRef.current) {
            containerRef.current.innerHTML = html
            const pre = containerRef.current.querySelector("pre")
            if (pre) {
              pre.style.margin = "0"
              pre.style.padding = "0"
              pre.style.background = "transparent"
              pre.style.fontSize = "11px"
              pre.style.lineHeight = "18px"
              pre.style.fontFamily = "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace"
            }
            const codeEl = containerRef.current.querySelector("code")
            if (codeEl) {
              codeEl.style.background = "transparent"
            }
          }
        } catch {
          if (!cancelled) setFallback(true)
        }
      })()
    }, SHIKI_DEBOUNCE_MS)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [code, language, isDark])

  if (fallback) {
    return (
      <Text className="text-[11px] font-mono text-foreground leading-[18px]" selectable>
        {code}
      </Text>
    )
  }

  return <div ref={containerRef} style={{ minHeight: 18 }} />
})

function stableStringify(val: unknown): string {
  if (val === null || val === undefined) return ""
  if (typeof val === "string") return val
  try { return JSON.stringify(val) } catch { return "" }
}

// See WriteFileWidget.tsx for rationale on the terminal-state fast path.
function toolWidgetPropsEqual(
  prev: WriteFileWidgetProps,
  next: WriteFileWidgetProps,
) {
  if (
    prev.isExpanded !== next.isExpanded ||
    prev.onToggle !== next.onToggle ||
    prev.className !== next.className
  ) {
    return false
  }
  if (prev.tool.state !== next.tool.state) return false
  if (prev.tool.error !== next.tool.error) return false
  if (
    prev.tool.id === next.tool.id &&
    next.tool.state !== "streaming"
  ) {
    return true
  }
  return (
    stableStringify(prev.tool.args) === stableStringify(next.tool.args) &&
    stableStringify(prev.tool.result) === stableStringify(next.tool.result)
  )
}

export const WriteFileWidget = memo(function WriteFileWidget({
  tool,
  isExpanded: controlledExpanded,
  onToggle,
  className,
}: WriteFileWidgetProps) {
  const [internalExpanded, setInternalExpanded] = useState(false)
  const [showFull, setShowFull] = useState(false)

  const isExpanded = controlledExpanded ?? internalExpanded
  const handleToggle = () => {
    if (onToggle) onToggle()
    else setInternalExpanded(!internalExpanded)
  }

  const { path, content, append, bytes } = useMemo(() => extractWriteData(tool), [tool.args, tool.result])
  const basename = getBasename(path)
  const langLabel = getLanguageLabel(path)
  const language = getLanguageFromPath(path)
  const { display, truncated, totalLines } = truncateContent(content)
  const shownCode = showFull ? content : display
  const lineCount = shownCode.split("\n").length

  const StateIcon = {
    streaming: Loader2,
    success: CheckCircle2,
    error: XCircle,
  }[tool.state]

  return (
    <View className={cn("overflow-hidden rounded-md", className)}>
      {/* Header */}
      <Pressable
        onPress={handleToggle}
        className="group w-full flex-row items-center gap-1.5 py-1.5 px-2 bg-gray-100 dark:bg-gray-950 border border-gray-200 dark:border-transparent"
      >
        <View className="group-hover:hidden">
          <FilePlus2 className="w-3 h-3 text-emerald-600 dark:text-emerald-500" size={12} />
        </View>
        <View className="hidden group-hover:flex">
          {isExpanded ? (
            <ChevronDown className="w-3 h-3 text-gray-800 dark:text-gray-400" size={12} />
          ) : (
            <ChevronRight className="w-3 h-3 text-gray-800 dark:text-gray-400" size={12} />
          )}
        </View>

        <View className="bg-gray-200 dark:bg-gray-800 rounded px-1 py-0.5">
          <Text className="text-[8px] font-medium text-gray-800 dark:text-gray-300 uppercase tracking-wide">
            {langLabel}
          </Text>
        </View>

        <Text className="flex-1 font-mono text-[11px] font-medium text-foreground" numberOfLines={1}>
          {basename}
        </Text>

        <Text className="font-mono text-[9px] text-gray-700 dark:text-gray-500 mr-1">
          {append ? "Append" : totalLines > 1 ? `${totalLines} lines` : ""}{" "}
          {formatBytes(bytes)}
        </Text>

        <StateIcon
          className={cn(
            "w-3 h-3",
            tool.state === "streaming" && "text-primary animate-spin",
            tool.state === "success" && "text-emerald-500",
            tool.state === "error" && "text-red-500",
          )}
          size={12}
        />
      </Pressable>

      {/* Expanded code preview */}
      {isExpanded && (
        <View className="bg-gray-50 dark:bg-gray-950 border-t border-gray-200 dark:border-gray-800">
          {tool.state === "streaming" && !content && (
            <View className="flex-row items-center gap-1.5 px-2 py-2">
              <Loader2 className="w-3 h-3 text-primary animate-spin" size={12} />
              <Text className="text-[10px] text-gray-800 dark:text-gray-400">Writing…</Text>
            </View>
          )}

          {content.length > 0 && (
            <ScrollView nestedScrollEnabled className="max-h-64">
              <View className="flex-row">
                {/* Line number gutter */}
                <View className="px-1.5 py-1.5 border-r border-gray-200 dark:border-gray-800 items-end select-none">
                  {Array.from({ length: lineCount }, (_, i) => (
                    <Text key={i} className="text-[10px] font-mono text-gray-700 dark:text-gray-500 leading-[18px]">
                      {i + 1}
                    </Text>
                  ))}
                </View>
                {/* Syntax-highlighted code */}
                <View className="flex-1 px-2 py-1.5 overflow-x-auto">
                  <HighlightedCode code={shownCode} language={language} />
                </View>
              </View>
            </ScrollView>
          )}

          {truncated && !showFull && (
            <Pressable onPress={() => setShowFull(true)} className="px-2 py-1 border-t border-gray-200 dark:border-gray-800">
              <Text className="text-[9px] text-gray-800 dark:text-gray-400">
                Show all {totalLines} lines
              </Text>
            </Pressable>
          )}

          {tool.state === "error" && tool.error && (
            <View className="bg-red-500/10 px-2 py-1.5 border-t border-gray-200 dark:border-gray-800">
              <Text className="text-[10px] font-mono text-red-600 dark:text-red-400" selectable>
                {tool.error}
              </Text>
            </View>
          )}
        </View>
      )}
    </View>
  )
}, toolWidgetPropsEqual)

export default WriteFileWidget
