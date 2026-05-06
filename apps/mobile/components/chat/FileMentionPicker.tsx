// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * FileMentionPicker — popover/sheet that lists project files for the
 * Cursor-style `@` tagging affordance.
 *
 * Behavior:
 *   - On web: floats above the textarea (the parent positions us absolutely).
 *   - On native: renders as a bottom-sheet style panel above the keyboard.
 *   - First match is auto-selected; ↑/↓/Tab move selection, Enter inserts,
 *     Esc closes (these are handled by the parent so we just expose
 *     selectedIndex + setSelectedIndex via props).
 *
 * The picker is intentionally dumb about state — the parent (ChatInput)
 * owns query / project files / selection so keyboard shortcuts work
 * natively in the textarea.
 */

import { memo, useRef, useEffect } from "react"
import { View, Text, Pressable, Platform } from "react-native"
import { FlatList } from "react-native"
import {
  Check,
  File,
  FileText,
  Folder,
  Image as ImageIcon,
  RefreshCw,
  Search,
  X,
} from "lucide-react-native"
import { cn } from "@shogo/shared-ui/primitives"
import { basename } from "./file-mention-utils"
import type { ProjectFileEntry, ProjectFilesStatus } from "../../hooks/useProjectFiles"

export interface FileMentionPickerProps {
  open: boolean
  query: string
  /** Pre-ranked results (parent owns ranking so it can commit on Enter). */
  results: ProjectFileEntry[]
  status: ProjectFilesStatus
  selectedIndex: number
  onChangeSelectedIndex: (index: number) => void
  onSelect: (file: ProjectFileEntry) => void
  onClose: () => void
  onClearQuery?: () => void
  onRetry?: () => void
  /** Render hint: web floats above textarea, native pins to bottom. */
  variant?: "popover" | "sheet"
  /** Ids already mentioned, so we can mark them. */
  mentionedPaths?: string[]
}

const ROW_HEIGHT = 44

function formatSize(bytes?: number) {
  if (typeof bytes !== "number") return null
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function getIcon(entry: ProjectFileEntry) {
  if (entry.type === "directory") {
    return <Folder size={14} className="text-muted-foreground" />
  }
  const ext = (entry.extension || "").toLowerCase()
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"].includes(ext)) {
    return <ImageIcon size={14} className="text-muted-foreground" />
  }
  if ([".md", ".txt", ".json"].includes(ext)) {
    return <FileText size={14} className="text-muted-foreground" />
  }
  return <File size={14} className="text-muted-foreground" />
}

function ParentPath({ path }: { path: string }) {
  const slash = path.lastIndexOf("/")
  if (slash === -1) return null
  return (
    <Text
      className="text-[10px] text-muted-foreground"
      numberOfLines={1}
      ellipsizeMode="head"
    >
      {path.slice(0, slash)}
    </Text>
  )
}

export const FileMentionPicker = memo(function FileMentionPicker({
  open,
  query,
  results,
  status,
  selectedIndex,
  onChangeSelectedIndex,
  onSelect,
  onClose,
  onClearQuery,
  onRetry,
  variant = "popover",
  mentionedPaths,
}: FileMentionPickerProps) {
  const listRef = useRef<FlatList>(null)
  const isNative = Platform.OS !== "web"

  useEffect(() => {
    if (!open || results.length === 0) return
    const clamped = Math.min(selectedIndex, results.length - 1)
    if (clamped !== selectedIndex) {
      onChangeSelectedIndex(clamped)
    }
    if (clamped >= 0) {
      try {
        listRef.current?.scrollToIndex({ index: clamped, animated: true, viewPosition: 0.4 })
      } catch {
        // FlatList may not be mounted yet
      }
    }
  }, [onChangeSelectedIndex, open, selectedIndex, results.length])

  if (!open) return null
  const ranked = results

  const containerCls =
    variant === "sheet"
      ? "absolute left-0 right-0 bottom-full mb-2 rounded-t-xl border-t border-x border-border bg-popover shadow-lg max-h-[320px] overflow-hidden"
      : "absolute left-2 right-2 bottom-full mb-2 rounded-lg border border-border bg-popover shadow-lg max-h-[320px] overflow-hidden"

  const activeDescendant =
    ranked.length > 0 && selectedIndex < ranked.length
      ? `mention-option-${ranked[selectedIndex].path.replace(/[^a-zA-Z0-9]/g, "-")}`
      : undefined

  return (
    <View
      className={containerCls}
      {...(Platform.OS === "web"
        ? ({
            accessibilityRole: "listbox",
            "aria-activedescendant": activeDescendant,
            "aria-label": `File picker${query ? `, filtered by "${query}"` : ""}`,
          } as any)
        : {
            accessibilityRole: "menu" as any,
            accessibilityLabel: `File picker, ${ranked.length} results`,
          })}
    >
      <View className="border-b border-border/60 px-3 py-2">
        <View className="flex-row items-center gap-2">
          <View className="h-6 w-6 items-center justify-center rounded-md bg-primary/10">
            <Search size={13} className="text-primary" />
          </View>
          <View className="flex-1 min-w-0">
            <Text className="text-xs font-semibold text-foreground">
              Add project context
            </Text>
            <Text className="text-[10px] text-muted-foreground" numberOfLines={1}>
              {status === "ready" || status === "idle"
                ? query
                  ? `${ranked.length} result${ranked.length === 1 ? "" : "s"} for "${query}"`
                  : `${ranked.length} available file${ranked.length === 1 ? "" : "s"}`
                : status === "loading"
                  ? "Loading project files..."
                  : status === "no-project"
                    ? "Connect a project to tag files"
                    : "Couldn't load project files"}
            </Text>
          </View>
        {isNative ? (
          <Pressable
            onPress={onClose}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            accessibilityLabel="Close file picker"
            accessibilityRole="button"
            className="h-5 w-5 items-center justify-center rounded-full bg-muted/60"
          >
            <X size={12} className="text-muted-foreground" />
          </Pressable>
        ) : (
          <Text className="text-[10px] text-muted-foreground">
            ↑↓ ↵ esc
          </Text>
        )}
        </View>
      </View>

      {/* Body */}
      {status === "loading" && ranked.length === 0 ? (
        <View className="px-3 py-4">
          {[0, 1, 2].map((i) => (
            <View
              key={i}
              className="h-7 mb-2 rounded bg-muted/40"
              style={{ width: `${70 - i * 10}%` }}
            />
          ))}
        </View>
      ) : status === "error" ? (
        <View className="px-3 py-6 items-center gap-2">
          <Text className="text-xs font-medium text-foreground">
            Files could not be loaded
          </Text>
          <Text className="text-[11px] text-muted-foreground text-center">
            Check the project connection and try again.
          </Text>
          {onRetry && (
            <Pressable
              onPress={onRetry}
              className="mt-1 flex-row items-center gap-1 rounded-md border border-border px-2 py-1"
              accessibilityRole="button"
              accessibilityLabel="Retry loading project files"
            >
              <RefreshCw size={11} className="text-foreground" />
              <Text className="text-[11px] text-foreground">Retry</Text>
            </Pressable>
          )}
        </View>
      ) : ranked.length === 0 ? (
        <View className="px-3 py-6 items-center">
          <Text className="text-xs font-medium text-foreground">
            {status === "no-project"
              ? "No project connected"
              : query
                ? "No matching files"
                : "No files in this project yet"}
          </Text>
          <Text className="mt-1 text-[11px] text-muted-foreground text-center">
            {status === "no-project"
              ? "Open a project chat to tag files as context."
              : query
                ? `Nothing matched "${query}".`
                : "Once files exist, they will appear here."}
          </Text>
          {!!query && onClearQuery && (
            <Pressable
              onPress={onClearQuery}
              className="mt-2 rounded-md border border-border px-2 py-1"
              accessibilityRole="button"
              accessibilityLabel="Browse all files"
            >
              <Text className="text-[11px] text-foreground">Browse all</Text>
            </Pressable>
          )}
        </View>
      ) : (
        <FlatList
          ref={listRef}
          data={ranked}
          keyExtractor={(item) => item.path}
          getItemLayout={(_, i) => ({
            length: ROW_HEIGHT,
            offset: ROW_HEIGHT * i,
            index: i,
          })}
          keyboardShouldPersistTaps="handled"
          renderItem={({ item, index }) => {
            const isSelected = index === selectedIndex
            const isMentioned = mentionedPaths?.includes(item.path)
            const rowId = `mention-option-${item.path.replace(/[^a-zA-Z0-9]/g, "-")}`
            const sizeLabel = formatSize(item.size)
            return (
              <Pressable
                onPress={() => {
                  if (!isMentioned) onSelect(item)
                }}
                style={{ height: ROW_HEIGHT }}
                className={cn(
                  "flex-row items-center gap-2 px-3",
                  isSelected && "bg-accent",
                  isMentioned && "opacity-65",
                )}
                accessibilityRole="button"
                accessibilityLabel={`Tag ${item.type === "directory" ? "folder" : "file"} ${item.path}${isMentioned ? ", already added" : ""}`}
                accessibilityState={{ selected: isSelected, disabled: isMentioned }}
                {...(Platform.OS === "web"
                  ? ({
                      id: rowId,
                      role: "option",
                      "aria-selected": isSelected,
                    } as any)
                  : {})}
              >
                <View className="h-6 w-6 items-center justify-center rounded-md bg-muted/60">
                  {getIcon(item)}
                </View>
                <View className="flex-1 min-w-0">
                  <Text
                    className={cn(
                      "text-xs font-medium",
                      isMentioned ? "text-muted-foreground" : "text-foreground",
                    )}
                    numberOfLines={1}
                  >
                    {basename(item.path)}
                  </Text>
                  <View className="flex-row items-center gap-1 min-w-0">
                    <View className="flex-1 min-w-0">
                      <ParentPath path={item.path} />
                    </View>
                    {sizeLabel && (
                      <Text className="text-[10px] text-muted-foreground">
                        {sizeLabel}
                      </Text>
                    )}
                  </View>
                </View>
                {isMentioned && (
                  <View className="flex-row items-center gap-1 rounded-full bg-primary/10 px-1.5 py-0.5">
                    <Check size={10} className="text-primary" />
                    <Text className="text-[10px] text-primary">Added</Text>
                  </View>
                )}
              </Pressable>
            )
          }}
        />
      )}
    </View>
  )
})

export default FileMentionPicker
