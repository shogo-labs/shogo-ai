// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Files touched this session, from the per-chat `file-change-store`.
 */

import { useMemo, useSyncExternalStore } from "react"
import { View, Text } from "react-native"
import { cn } from "@shogo/shared-ui/primitives"
import { FileEdit, FilePlus, FileX, Files } from "lucide-react-native"
import { useFileChangeStore, type FileChangeKind } from "../../../../lib/file-change-store"
import { useDockPanel } from "../useDockPanel"
import type { DockPanelDescriptor } from "../../../../lib/chat-dock-store"

const KIND_ICON: Record<FileChangeKind, typeof FileEdit> = {
  write: FilePlus,
  edit: FileEdit,
  delete: FileX,
}

const KIND_COLOR: Record<FileChangeKind, string> = {
  write: "text-emerald-500",
  edit: "text-sky-500",
  delete: "text-red-500",
}

function ChangesBody({ files }: { files: { path: string; kind: FileChangeKind }[] }) {
  return (
    <View className="gap-1">
      {files.map(({ path, kind }) => {
        const Icon = KIND_ICON[kind]
        const fileName = path.split("/").pop() || path
        return (
          <View key={path} className="flex-row items-center gap-1.5">
            <Icon size={12} className={cn("shrink-0", KIND_COLOR[kind])} />
            <Text className="flex-1 text-[11px] text-foreground" numberOfLines={1}>
              {fileName}
            </Text>
            <Text className="text-[9px] text-muted-foreground" numberOfLines={1}>
              {path}
            </Text>
          </View>
        )
      })}
    </View>
  )
}

export function ChangesDockPanel() {
  const store = useFileChangeStore()
  // `store.getAll()` returns a cached array that's only reallocated when
  // `version` changes, so gating on `version` here (rather than calling
  // `getAll()` directly in the dep array) keeps `files` — and therefore
  // `descriptor` below — referentially stable across renders that don't
  // touch this store, e.g. ones forced by `ChatPanel`'s own subscription
  // to the *dock* store's version. See `chat-dock-store.ts`'s
  // `panelsObservablyEqual` for why that stability matters.
  const version = useSyncExternalStore(store.subscribe, store.getVersion, store.getVersion)
  const files = useMemo(() => store.getAll(), [store, version])

  const descriptor = useMemo<DockPanelDescriptor | null>(() => {
    if (files.length === 0) return null
    return {
      id: "changes",
      kind: "status",
      order: 30,
      title: "Changed files",
      icon: Files,
      summary: `${files.length} file${files.length === 1 ? "" : "s"} changed`,
      render: () => <ChangesBody files={files} />,
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files])

  useDockPanel(descriptor)
  return null
}
