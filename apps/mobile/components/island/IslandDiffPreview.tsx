// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useMemo } from "react"
import { ScrollView, Text, View } from "react-native"
import { cn } from "@shogo/shared-ui/primitives"
import { computeLineDiff, type DiffLine } from "../chat/turns/diff-utils"

const MAX_PREVIEW_LINES = 80
/** computeLineDiff is O(n·m); past this the preview shows the new text only. */
const MAX_DIFF_CELLS = 400_000

export type IslandFileChange =
  | { kind: "edit"; path: string; lines: DiffLine[]; added: number; removed: number }
  | { kind: "write"; path: string; lines: string[]; totalLines: number }

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

/** Reads the file change a permission request is asking about, if any. */
export function fileChangeFromParams(
  toolName: string,
  params: Record<string, unknown>,
): IslandFileChange | null {
  const path = str(params.path) ?? str(params.file_path) ?? str(params.target_file) ?? ""
  const oldString = str(params.old_string)
  const newString = str(params.new_string)
  if (oldString !== undefined && newString !== undefined) {
    const oldCount = oldString.split("\n").length
    const newCount = newString.split("\n").length
    const lines: DiffLine[] =
      oldCount * newCount <= MAX_DIFF_CELLS
        ? computeLineDiff(oldString, newString)
        : [
            ...oldString.split("\n").map((text) => ({ type: "removed" as const, text })),
            ...newString.split("\n").map((text) => ({ type: "added" as const, text })),
          ]
    return {
      kind: "edit",
      path,
      lines,
      added: lines.filter((line) => line.type === "added").length,
      removed: lines.filter((line) => line.type === "removed").length,
    }
  }
  const content = str(params.content) ?? str(params.contents)
  if (content !== undefined && /write|create|file/i.test(toolName)) {
    const all = content.split("\n")
    return { kind: "write", path, lines: all.slice(0, MAX_PREVIEW_LINES), totalLines: all.length }
  }
  return null
}

/** Unified diff with a few lines of context around each change. */
function trimContext(lines: DiffLine[], context = 3): Array<DiffLine | { type: "gap" }> {
  const keep = new Set<number>()
  lines.forEach((line, index) => {
    if (line.type === "context") return
    for (let offset = -context; offset <= context; offset++) keep.add(index + offset)
  })
  const out: Array<DiffLine | { type: "gap" }> = []
  let skipped = false
  lines.forEach((line, index) => {
    if (keep.has(index)) {
      if (skipped && out.length) out.push({ type: "gap" })
      skipped = false
      out.push(line)
    } else {
      skipped = true
    }
  })
  return out
}

export function IslandDiffPreview({
  change,
  truncated,
}: {
  change: IslandFileChange
  truncated?: boolean
}) {
  const rows = useMemo(
    () => (change.kind === "edit" ? trimContext(change.lines).slice(0, MAX_PREVIEW_LINES) : []),
    [change],
  )
  const fileName = change.path.split("/").pop() || change.path || "file"

  return (
    <View className="overflow-hidden rounded-lg border border-white/10 bg-black/40">
      <View className="flex-row items-center gap-2 border-b border-white/10 px-2.5 py-1.5">
        <Text className="flex-1 font-mono text-[11px] text-zinc-200" numberOfLines={1}>
          {fileName}
        </Text>
        {change.kind === "edit" ? (
          <Text className="text-[10px] font-semibold">
            <Text className="text-emerald-400">+{change.added}</Text>{" "}
            <Text className="text-rose-400">−{change.removed}</Text>
          </Text>
        ) : (
          <Text className="rounded bg-sky-500/20 px-1.5 text-[10px] font-semibold text-sky-300">
            {change.totalLines} lines
          </Text>
        )}
      </View>
      <ScrollView style={{ maxHeight: 180 }} horizontal={false}>
        <View className="py-1">
          {change.kind === "edit"
            ? rows.map((row, index) =>
                row.type === "gap" ? (
                  <Text key={index} className="px-2.5 font-mono text-[10px] text-zinc-600">
                    ⋯
                  </Text>
                ) : (
                  <Text
                    key={index}
                    className={cn(
                      "px-2.5 font-mono text-[10.5px] leading-[15px]",
                      row.type === "added" && "bg-emerald-500/15 text-emerald-200",
                      row.type === "removed" && "bg-rose-500/15 text-rose-200",
                      row.type === "context" && "text-zinc-400",
                    )}
                    numberOfLines={1}
                  >
                    {row.type === "added" ? "+ " : row.type === "removed" ? "- " : "  "}
                    {row.text}
                  </Text>
                ),
              )
            : change.lines.map((line, index) => (
                <Text
                  key={index}
                  className="px-2.5 font-mono text-[10.5px] leading-[15px] text-zinc-300"
                  numberOfLines={1}
                >
                  {line || " "}
                </Text>
              ))}
        </View>
      </ScrollView>
      {truncated ||
      (change.kind === "write" && change.totalLines > change.lines.length) ? (
        <Text className="border-t border-white/10 px-2.5 py-1 text-[10px] text-zinc-500">
          Preview truncated. Open in Shogo for the full change.
        </Text>
      ) : null}
    </View>
  )
}
