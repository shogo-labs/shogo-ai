// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * EditFileWidget (Web) — Unified diff display with Shiki syntax
 * highlighting on individual diff lines.
 */

import { useState, useEffect, useRef, useMemo, memo } from "react"
import { View, Text, Pressable, ScrollView } from "react-native"
import { cn } from "@shogo/shared-ui/primitives"
import { FileEdit, Loader2, CheckCircle2, XCircle, ChevronRight, ChevronDown } from "lucide-react-native"
import type { ToolCallData } from "../tools/types"
import { getBasename, getLanguageFromPath, getLanguageLabel } from "./file-lang-map"
import { type DiffLine, computeLineDiff } from "./diff-utils"

export interface EditFileWidgetProps {
  tool: ToolCallData
  isExpanded?: boolean
  onToggle?: () => void
  className?: string
}

function extractEditData(tool: ToolCallData) {
  const path = (tool.args?.path ?? tool.args?.file_path) as string | undefined
  const oldString = (tool.args?.old_string ?? "") as string
  const newString = (tool.args?.new_string ?? "") as string
  const replaceAll = tool.args?.replace_all as boolean | undefined
  return { path: path || "unknown", oldString, newString, replaceAll }
}

const LINE_BG: Record<DiffLine["type"], string> = {
  removed: "rgba(248, 81, 73, 0.15)",
  added: "rgba(63, 185, 80, 0.15)",
  context: "transparent",
}

const GUTTER_COLOR: Record<DiffLine["type"], string> = {
  removed: "#f85149",
  added: "#3fb950",
  context: "#484f58",
}

const FALLBACK_COLOR: Record<DiffLine["type"], string> = {
  removed: "#ffa198",
  added: "#7ee787",
  context: "#8b949e",
}

const SHIKI_DEBOUNCE_MS = 150

const HighlightedDiffLines = memo(function HighlightedDiffLines({
  lines,
  language,
}: {
  lines: DiffLine[]
  language: string
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [tokenMap, setTokenMap] = useState<Map<number, string> | null>(null)

  useEffect(() => {
    let cancelled = false
    const timer = setTimeout(() => {
      ;(async () => {
        try {
          const { codeToTokens } = await import("shiki")
          const allOldLines: string[] = []
          const allNewLines: string[] = []
          for (const l of lines) {
            if (l.type === "removed" || l.type === "context") allOldLines.push(l.text)
            if (l.type === "added" || l.type === "context") allNewLines.push(l.text)
          }
          const combined = [...new Set([...allOldLines, ...allNewLines])]
          const fullCode = combined.join("\n")

          const result = await codeToTokens(fullCode, {
            lang: language === "text" ? "plaintext" : language,
            theme: "github-dark-default",
          })

          const lineHtmlMap = new Map<string, string>()
          for (let ti = 0; ti < result.tokens.length; ti++) {
            const tokenLine = result.tokens[ti]
            const lineText = combined[ti]
            const spans = tokenLine
              .map(t => `<span style="color:${t.color || '#e6edf3'}">${escapeHtml(t.content)}</span>`)
              .join("")
            lineHtmlMap.set(lineText, spans)
          }

          if (cancelled) return
          const indexMap = new Map<number, string>()
          for (let i = 0; i < lines.length; i++) {
            const html = lineHtmlMap.get(lines[i].text)
            if (html) indexMap.set(i, html)
          }
          setTokenMap(indexMap)
        } catch {
          // Shiki unavailable — fall back to plain text
        }
      })()
    }, SHIKI_DEBOUNCE_MS)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [lines, language])

  return (
    <div ref={containerRef} style={{ fontFamily: "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace" }}>
      {lines.map((line, i) => (
        <div
          key={i}
          style={{
            display: "flex",
            flexDirection: "row",
            minHeight: 16,
            backgroundColor: LINE_BG[line.type],
          }}
        >
          {/* Gutter */}
          <div style={{
            width: 20,
            textAlign: "center",
            fontSize: 10,
            lineHeight: "16px",
            color: GUTTER_COLOR[line.type],
            userSelect: "none",
            flexShrink: 0,
          }}>
            {line.type === "removed" ? "−" : line.type === "added" ? "+" : " "}
          </div>
          {/* Code */}
          <div
            style={{
              flex: 1,
              fontSize: 10,
              lineHeight: "16px",
              paddingLeft: 4,
              paddingRight: 4,
              whiteSpace: "pre",
              overflowX: "auto",
              color: FALLBACK_COLOR[line.type],
            }}
            dangerouslySetInnerHTML={
              tokenMap?.has(i)
                ? { __html: tokenMap.get(i)! }
                : { __html: escapeHtml(line.text || " ") }
            }
          />
        </div>
      ))}
    </div>
  )
})

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

function stableStringify(val: unknown): string {
  if (val === null || val === undefined) return ""
  if (typeof val === "string") return val
  try { return JSON.stringify(val) } catch { return "" }
}

function toolWidgetPropsEqual(
  prev: EditFileWidgetProps,
  next: EditFileWidgetProps,
) {
  const equal =
    prev.tool.state === next.tool.state &&
    stableStringify(prev.tool.args) === stableStringify(next.tool.args) &&
    prev.tool.error === next.tool.error &&
    stableStringify(prev.tool.result) === stableStringify(next.tool.result) &&
    prev.isExpanded === next.isExpanded &&
    prev.onToggle === next.onToggle &&
    prev.className === next.className
  return equal
}

export const EditFileWidget = memo(function EditFileWidget({
  tool,
  isExpanded: controlledExpanded,
  onToggle,
  className,
}: EditFileWidgetProps) {
  const [internalExpanded, setInternalExpanded] = useState(false)
  const isExpanded = controlledExpanded ?? internalExpanded
  const handleToggle = () => {
    if (onToggle) onToggle()
    else setInternalExpanded(!internalExpanded)
  }

  const { path, oldString, newString } = useMemo(() => extractEditData(tool), [tool.args])
  const basename = getBasename(path)
  const langLabel = getLanguageLabel(path)
  const language = getLanguageFromPath(path)

  const diffLines = useMemo(
    () => computeLineDiff(oldString, newString),
    [oldString, newString],
  )

  const added = diffLines.filter(l => l.type === "added").length
  const removed = diffLines.filter(l => l.type === "removed").length

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
        className="group w-full flex-row items-center gap-1.5 py-1.5 px-2 bg-gray-900 dark:bg-gray-950"
      >
        <View className="group-hover:hidden">
          <FileEdit className="w-3 h-3 text-primary" size={12} />
        </View>
        <View className="hidden group-hover:flex">
          {isExpanded ? (
            <ChevronDown className="w-3 h-3 text-gray-500" size={12} />
          ) : (
            <ChevronRight className="w-3 h-3 text-gray-500" size={12} />
          )}
        </View>

        <View className="bg-gray-800 rounded px-1 py-0.5">
          <Text className="text-[8px] font-medium text-gray-400 uppercase tracking-wide">
            {langLabel}
          </Text>
        </View>

        <Text className="flex-1 font-mono text-[10px] text-gray-300" numberOfLines={1}>
          {basename}
        </Text>

        {(added > 0 || removed > 0) && (
          <Text className="font-mono text-[9px] mr-1">
            {added > 0 && <Text className="text-emerald-500">+{added}</Text>}
            {added > 0 && removed > 0 && <Text className="text-gray-600"> </Text>}
            {removed > 0 && <Text className="text-red-400">-{removed}</Text>}
          </Text>
        )}

        <StateIcon
          className={cn(
            "w-3 h-3",
            tool.state === "streaming" && "text-primary",
            tool.state === "success" && "text-emerald-500",
            tool.state === "error" && "text-red-500",
          )}
          size={12}
        />
      </Pressable>

      {/* Expanded diff view */}
      {isExpanded && (
        <View className="bg-gray-900 dark:bg-gray-950 border-t border-gray-800">
          {tool.state === "streaming" && !oldString && !newString && (
            <View className="flex-row items-center gap-1.5 px-2 py-2">
              <Loader2 className="w-3 h-3 text-primary" size={12} />
              <Text className="text-[10px] text-gray-500">Editing…</Text>
            </View>
          )}

          {(oldString || newString) && (
            <ScrollView nestedScrollEnabled className="max-h-64">
              <HighlightedDiffLines lines={diffLines} language={language} />
            </ScrollView>
          )}

          {tool.state === "error" && tool.error && (
            <View className="bg-red-500/10 px-2 py-1.5 border-t border-gray-800">
              <Text className="text-[10px] font-mono text-red-400" selectable>
                {tool.error}
              </Text>
            </View>
          )}
        </View>
      )}
    </View>
  )
}, toolWidgetPropsEqual)

export default EditFileWidget
