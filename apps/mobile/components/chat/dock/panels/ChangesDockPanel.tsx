// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Files touched this session, from the per-chat `file-change-store`.
 */

import { useMemo, useSyncExternalStore } from "react"
import { Files } from "lucide-react-native"
import { useFileChangeStore } from "../../../../lib/file-change-store"
import { useIsNativePhoneLayout } from "../../../../lib/native-phone-layout"
import { ChangedFilesList } from "../../sessionActivity"
import { useDockPanel } from "../useDockPanel"
import type { DockPanelDescriptor } from "../../../../lib/chat-dock-store"

export function ChangesDockPanel() {
  const nativePhone = useIsNativePhoneLayout()
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
    if (nativePhone || files.length === 0) return null
    return {
      id: "changes",
      kind: "status",
      order: 30,
      title: "Changed files",
      icon: Files,
      summary: `${files.length} file${files.length === 1 ? "" : "s"} changed`,
      render: () => <ChangedFilesList files={files} variant="dock" />,
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files, nativePhone])

  useDockPanel(descriptor)
  return null
}
