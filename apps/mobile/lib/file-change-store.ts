// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Per-chat store for files the agent has touched this session — feeds the
 * chat dock's "Changes" panel.
 *
 * Same shape as `todo-state-store.ts`: a small external store populated by
 * `AssistantContent` as it renders write/edit/delete tool parts (mirroring
 * how it already calls `todoStateStore.registerWrite`), exposed via React
 * context so multiple open chat tabs don't share state.
 *
 * Deliberately keyed on the canonical tool names the agent runtime actually
 * emits (`write_file` / `edit_file` / `delete_file`, plus the legacy
 * `Write` / `Edit` / `StrReplace` / `Delete` aliases the UI still renders
 * for older sessions) — the same set `EditingGroup.tsx` and
 * `tool-categories.ts` group on. This supersedes `getModifiedFilePaths` in
 * `ChatPanel.tsx`, which matched `Write`/`Edit`/`StrReplace` but not the
 * `write_file`/`edit_file` names the agent actually emits, and whose
 * `onFilesChanged` callback no parent ever passed.
 */

import { createContext, useContext } from "react"

export type FileChangeKind = "write" | "edit" | "delete"

export const WRITE_TOOL_NAMES = new Set(["write_file", "Write"])
export const EDIT_TOOL_NAMES = new Set(["edit_file", "Edit", "StrReplace"])
export const DELETE_TOOL_NAMES = new Set(["delete_file", "Delete"])

export function classifyFileToolName(toolName: string): FileChangeKind | null {
  if (WRITE_TOOL_NAMES.has(toolName)) return "write"
  if (EDIT_TOOL_NAMES.has(toolName)) return "edit"
  if (DELETE_TOOL_NAMES.has(toolName)) return "delete"
  return null
}

/** Pulls a file path out of the handful of arg shapes tool calls use. */
export function extractFilePath(args?: Record<string, unknown>): string | undefined {
  if (!args) return undefined
  const path = args.file_path ?? args.path ?? args.filePath
  return typeof path === "string" && path.length > 0 ? path : undefined
}

export interface FileChangeItem {
  path: string
  /** Most recent operation kind recorded for this path. */
  kind: FileChangeKind
}

export interface FileChangeStore {
  getVersion(): number
  /** Ordered by first-touched. */
  getAll(): FileChangeItem[]
  registerChange(toolId: string, path: string, kind: FileChangeKind): void
  subscribe(fn: () => void): () => void
  clear(): void
}

export function createFileChangeStore(): FileChangeStore {
  const order: string[] = []
  const items = new Map<string, FileChangeItem>()
  // Guards against re-registering the same tool-call + path pair every time
  // AssistantContent's effect re-runs during streaming.
  const seenKeys = new Set<string>()
  const listeners = new Set<() => void>()
  let version = 0

  function notify() {
    version++
    listeners.forEach((fn) => fn())
  }

  return {
    getVersion() {
      return version
    },
    getAll() {
      return order.map((path) => items.get(path)!).filter(Boolean)
    },
    registerChange(toolId, path, kind) {
      const key = `${toolId}:${path}:${kind}`
      if (seenKeys.has(key)) return
      seenKeys.add(key)
      if (!items.has(path)) order.push(path)
      items.set(path, { path, kind })
      notify()
    },
    subscribe(fn) {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    },
    clear() {
      order.length = 0
      items.clear()
      seenKeys.clear()
      notify()
    },
  }
}

export const FileChangeStoreContext = createContext<FileChangeStore | null>(null)

let fallbackStore: FileChangeStore | null = null

function getFallbackStore(): FileChangeStore {
  if (!fallbackStore) fallbackStore = createFileChangeStore()
  return fallbackStore
}

export function useFileChangeStore(): FileChangeStore {
  const store = useContext(FileChangeStoreContext)
  return store ?? getFallbackStore()
}
