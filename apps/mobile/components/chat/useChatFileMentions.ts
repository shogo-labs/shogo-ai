// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react"
import { Platform, type TextInput } from "react-native"
import { API_URL } from "../../lib/api"
import { useProjectFiles, searchProjectFiles } from "../../hooks/useProjectFiles"
import {
  buildMentionAttachments,
  dedupMention,
  detectMentionTrigger,
  formatMentionIssueSummary,
  makeMention,
  rankFiles,
  MAX_MENTIONS,
  type FileMention,
  type FileMentionContent,
  type MentionAttachmentLike,
  type ResolveResult,
} from "./file-mention-utils"

interface UseChatFileMentionsOptions {
  projectId?: string
  enabled: boolean
  disabled: boolean
  valueRef: RefObject<string>
  setValue: (value: string) => void
  inputRef: RefObject<TextInput | null>
  setError: (message: string | null) => void
}

export interface MentionResolutionResult {
  attachments: MentionAttachmentLike[]
  failures: ResolveResult["failures"]
  truncated: string[]
}

const LARGE_PROJECT_THRESHOLD = 500

export { formatMentionIssueSummary }

export function useChatFileMentions({
  projectId,
  enabled,
  disabled,
  valueRef,
  setValue,
  inputRef,
  setError,
}: UseChatFileMentionsOptions) {
  const [mentions, setMentions] = useState<FileMention[]>([])
  const [pickerOpen, setPickerOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [anchor, setAnchor] = useState(-1)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [serverSearchResults, setServerSearchResults] = useState<ReturnType<typeof useProjectFiles>["files"]>([])
  const [isResolving, setIsResolving] = useState(false)
  const isResolvingRef = useRef(false)
  const selectionRef = useRef<{ start: number; end: number }>({ start: 0, end: 0 })
  const isComposingRef = useRef(false)

  const projectFiles = useProjectFiles(projectId, {
    enabled: !!projectId && enabled,
  })
  const mentionableFiles = useMemo(
    () => projectFiles.files.filter((file) => file.type === "file"),
    [projectFiles.files],
  )
  const isLargeProject = mentionableFiles.length >= LARGE_PROJECT_THRESHOLD

  const closePicker = useCallback(() => {
    setPickerOpen(false)
    setQuery("")
    setAnchor(-1)
    setSelectedIndex(0)
  }, [])

  const openPicker = useCallback(() => {
    if (!enabled || disabled) return
    setPickerOpen(true)
    setQuery("")
    setAnchor(-1)
    setSelectedIndex(0)
    setTimeout(() => inputRef.current?.focus(), 0)
  }, [disabled, enabled, inputRef])

  const clearQuery = useCallback(() => {
    setQuery("")
    setSelectedIndex(0)
  }, [])

  const removeMention = useCallback((id: string) => {
    setMentions((prev) => prev.filter((m) => m.id !== id))
  }, [])

  const insertMention = useCallback(
    (file: { path: string; extension?: string }) => {
      setMentions((prev) => {
        if (prev.length >= MAX_MENTIONS) {
          setError(`You can tag at most ${MAX_MENTIONS} files per message`)
          return prev
        }
        if (dedupMention(prev, file)) {
          setError(null)
          return prev
        }
        const mention = makeMention(file.path)
        if (file.extension) mention.extension = file.extension
        setError(null)
        return [...prev, mention]
      })

      const current = valueRef.current
      const caret = selectionRef.current.start
      let nextValue: string
      if (anchor >= 0 && anchor < current.length) {
        const before = current.slice(0, anchor)
        const after = current.slice(caret)
        nextValue = before + after
      } else {
        nextValue = current.replace(/@[A-Za-z0-9._/\-]*$/, "")
      }
      setValue(nextValue)
      closePicker()
      setTimeout(() => inputRef.current?.focus(), 0)
    },
    [anchor, closePicker, inputRef, setError, setValue, valueRef],
  )

  useEffect(() => {
    if (!pickerOpen || !isLargeProject || !projectId || !query) {
      setServerSearchResults([])
      return
    }
    const timer = setTimeout(() => {
      searchProjectFiles(projectId, query, 50).then(setServerSearchResults)
    }, 200)
    return () => clearTimeout(timer)
  }, [pickerOpen, isLargeProject, projectId, query])

  const results = useMemo(() => {
    if (!pickerOpen) return []
    if (isLargeProject && query && serverSearchResults.length > 0) {
      return serverSearchResults.filter((file) => file.type === "file")
    }
    return rankFiles(mentionableFiles, query, 50)
  }, [pickerOpen, mentionableFiles, query, isLargeProject, serverSearchResults])

  useEffect(() => {
    if (!pickerOpen) return
    setSelectedIndex((current) => {
      if (results.length === 0) return 0
      return Math.min(current, results.length - 1)
    })
  }, [pickerOpen, results.length])

  const handleTextChange = useCallback(
    (text: string) => {
      if (!enabled || disabled) return
      const caret = Math.min(selectionRef.current.start || text.length, text.length)
      const trigger = detectMentionTrigger(text, caret, {
        isComposing: isComposingRef.current,
      })
      if (trigger.active) {
        setPickerOpen(true)
        setQuery(trigger.query)
        setAnchor(trigger.anchor)
        setSelectedIndex(0)
      } else if (pickerOpen) {
        closePicker()
      }
    },
    [closePicker, disabled, enabled, pickerOpen],
  )

  const onSelectionChange = useCallback((event: any) => {
    const selection = event?.nativeEvent?.selection
    if (selection && typeof selection.start === "number") {
      selectionRef.current = {
        start: selection.start,
        end: typeof selection.end === "number" ? selection.end : selection.start,
      }
    }
  }, [])

  const setIsComposingFromKeyEvent = useCallback((event: any) => {
    if (Platform.OS === "web") {
      isComposingRef.current = !!event?.nativeEvent?.isComposing
    }
  }, [])

  const commitSelected = useCallback(() => {
    if (!pickerOpen) return false
    const target = results[selectedIndex] ?? results[0]
    if (!target) return true
    insertMention({ path: target.path, extension: target.extension })
    return true
  }, [insertMention, pickerOpen, results, selectedIndex])

  const handlePickerKey = useCallback(
    (key: string) => {
      if (!pickerOpen || Platform.OS !== "web") return false
      const visibleCount = results.length
      if (key === "ArrowDown") {
        setSelectedIndex((i) => (visibleCount === 0 ? 0 : (i + 1) % visibleCount))
        return true
      }
      if (key === "ArrowUp") {
        setSelectedIndex((i) => (visibleCount === 0 ? 0 : (i - 1 + visibleCount) % visibleCount))
        return true
      }
      if (key === "Escape") {
        closePicker()
        return true
      }
      if (key === "Enter" || key === "Tab") {
        commitSelected()
        return true
      }
      return false
    },
    [closePicker, commitSelected, pickerOpen, results.length],
  )

  const popLastMentionIfAtStart = useCallback(() => {
    if (
      mentions.length > 0 &&
      selectionRef.current.start === 0 &&
      selectionRef.current.end === 0
    ) {
      setMentions((prev) => prev.slice(0, -1))
      return true
    }
    return false
  }, [mentions.length])

  const validateBeforeSend = useCallback((): FileMention[] | null => {
    if (mentions.length === 0 || mentionableFiles.length === 0) return mentions
    const knownPaths = new Set(mentionableFiles.map((f) => f.path))
    const gone = mentions.filter((m) => !knownPaths.has(m.path))
    if (gone.length === 0) return mentions

    const goneNames = gone.map((m) => m.displayName).join(", ")
    if (gone.length === mentions.length) {
      setError(`${goneNames} no longer exist in the project.`)
      return null
    }

    const validMentions = mentions.filter((m) => knownPaths.has(m.path))
    setMentions(validMentions)
    setError(`${goneNames} no longer found; removed from tagged files`)
    return validMentions
  }, [mentions, mentionableFiles, setError])

  const resolveMentionContents = useCallback(
    async (toResolve: FileMention[]): Promise<FileMentionContent[]> => {
      if (toResolve.length === 0 || !projectId) return []
      try {
        const res = await fetch(
          `${API_URL}/api/projects/${encodeURIComponent(projectId)}/files/batch-read`,
          {
            method: "POST",
            credentials: "include",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ paths: toResolve.map((m) => m.path) }),
          },
        )
        if (!res.ok) {
          return toResolve.map((m) => ({ path: m.path, error: "read_failed" as const }))
        }
        const data = (await res.json()) as { files?: FileMentionContent[] }
        return Array.isArray(data.files) ? data.files : []
      } catch {
        return toResolve.map((m) => ({ path: m.path, error: "read_failed" as const }))
      }
    },
    [projectId],
  )

  const resolveForSend = useCallback(
    async (toResolve: FileMention[]): Promise<MentionResolutionResult> => {
      if (toResolve.length === 0) {
        return { attachments: [], failures: [], truncated: [] }
      }
      isResolvingRef.current = true
      setIsResolving(true)
      try {
        const contents = await resolveMentionContents(toResolve)
        const built = buildMentionAttachments(contents)
        return {
          attachments: built.attachments,
          failures: built.failures,
          truncated: built.truncated,
        }
      } finally {
        isResolvingRef.current = false
        setIsResolving(false)
      }
    },
    [resolveMentionContents],
  )

  const resetMentions = useCallback(() => {
    setMentions([])
    closePicker()
  }, [closePicker])

  return {
    mentions,
    setMentions,
    pickerOpen,
    query,
    results,
    selectedIndex,
    setSelectedIndex,
    projectFiles,
    isResolving,
    isResolvingRef,
    closePicker,
    openPicker,
    clearQuery,
    insertMention,
    removeMention,
    handleTextChange,
    onSelectionChange,
    setIsComposingFromKeyEvent,
    handlePickerKey,
    popLastMentionIfAtStart,
    validateBeforeSend,
    resolveForSend,
    resetMentions,
  }
}
