// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * React hook wrapping askUserQuestionDraftStore with the lifecycle the
 * AskUserQuestionWidget needs:
 *
 *   - Hydrate once on mount from AsyncStorage, keyed by toolCallId.
 *   - Debounce writes so every keystroke in the "Other" text field doesn't
 *     hit AsyncStorage.
 *   - Clear the persisted draft when the server reports a result, i.e. the
 *     agent accepted our answer. This is also the single point where we
 *     reconcile the "mid-submit kill" retry state.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import AsyncStorage from "@react-native-async-storage/async-storage"
import {
  type DraftState,
  type DraftStorage,
  clearDraft,
  deriveSubmissionStatus,
  emptyDraft,
  entriesToOtherTexts,
  entriesToSelections,
  loadDraft,
  otherTextsToEntries,
  saveDraft,
  selectionsToEntries,
} from "./askUserQuestionDraftStore"

const DEBOUNCE_MS = 250

export interface UseAskUserQuestionDraftOptions {
  /** Override the backing storage. Defaults to AsyncStorage. Useful for tests. */
  storage?: DraftStorage
}

export interface UseAskUserQuestionDraftResult {
  /** True once the first load attempt has completed. Until then the widget should render from empty defaults. */
  hydrated: boolean
  selections: Map<number, string[]>
  setSelections: React.Dispatch<React.SetStateAction<Map<number, string[]>>>
  otherTexts: Map<number, string>
  setOtherTexts: React.Dispatch<React.SetStateAction<Map<number, string>>>
  activeTab: number
  setActiveTab: React.Dispatch<React.SetStateAction<number>>
  /** Locally persisted response, if the user submitted in a previous (or the current) session. */
  submittedResponse: string | null
  /** Marks the draft as submitted and flushes to storage synchronously. Call BEFORE firing network submit. */
  markSubmitted: (response: string) => Promise<void>
  /** We have a local submission but the server has not yet confirmed it — the widget should offer Retry. */
  needsRetry: boolean
  /** Either the server confirmed, or we locally submitted — the widget should render "answered". */
  answered: boolean
  /** String to show under "Your Response" (server result preferred over local draft). */
  displayResponse: string | null
}

export function useAskUserQuestionDraft(
  toolCallId: string,
  toolResult: unknown,
  options: UseAskUserQuestionDraftOptions = {}
): UseAskUserQuestionDraftResult {
  const storage: DraftStorage = options.storage ?? AsyncStorage
  const storageRef = useRef(storage)
  storageRef.current = storage

  const [hydrated, setHydrated] = useState(false)
  const [selections, setSelections] = useState<Map<number, string[]>>(
    () => new Map()
  )
  const [otherTexts, setOtherTexts] = useState<Map<number, string>>(
    () => new Map()
  )
  const [activeTab, setActiveTab] = useState(0)
  const [submittedResponse, setSubmittedResponse] = useState<string | null>(
    null
  )
  const submittedAtRef = useRef<number | null>(null)

  // Hydrate on mount (or when toolCallId changes — rare, but harmless).
  useEffect(() => {
    let cancelled = false
    setHydrated(false)

    loadDraft(storageRef.current, toolCallId)
      .then((loaded) => {
        if (cancelled) return
        if (loaded) {
          setSelections(entriesToSelections(loaded.selections))
          setOtherTexts(entriesToOtherTexts(loaded.otherTexts))
          setActiveTab(loaded.activeTab)
          setSubmittedResponse(loaded.submittedResponse)
          submittedAtRef.current = loaded.submittedAt
        } else {
          setSelections(new Map())
          setOtherTexts(new Map())
          setActiveTab(0)
          setSubmittedResponse(null)
          submittedAtRef.current = null
        }
      })
      .catch(() => {
        // Non-fatal: widget keeps working in-memory if AsyncStorage is unavailable.
      })
      .finally(() => {
        if (!cancelled) setHydrated(true)
      })

    return () => {
      cancelled = true
    }
  }, [toolCallId])

  // Once the server confirms a result, drop the local draft — no point
  // keeping it around, and it would shadow a future ask_user with the same
  // (highly unlikely) reused id. Also rearms the hook for any fresh state.
  const serverAnswered = toolResult !== undefined
  useEffect(() => {
    if (!hydrated) return
    if (!serverAnswered) return
    clearDraft(storageRef.current, toolCallId).catch(() => {
      // Best-effort cleanup.
    })
  }, [hydrated, serverAnswered, toolCallId])

  // Debounced auto-save on any editable-state change.
  useEffect(() => {
    if (!hydrated) return
    if (serverAnswered) return // Nothing left to persist; cleanup above will run.

    const handle = setTimeout(() => {
      const draft: DraftState = {
        selections: selectionsToEntries(selections),
        otherTexts: otherTextsToEntries(otherTexts),
        activeTab,
        submittedResponse,
        submittedAt: submittedAtRef.current,
      }
      saveDraft(storageRef.current, toolCallId, draft).catch(() => {
        // Best-effort; next state change will try again.
      })
    }, DEBOUNCE_MS)

    return () => clearTimeout(handle)
  }, [
    hydrated,
    serverAnswered,
    toolCallId,
    selections,
    otherTexts,
    activeTab,
    submittedResponse,
  ])

  // Flush the submitted response synchronously so a mid-submit app kill
  // still leaves a recoverable record on disk. The debounced effect above
  // would race the network call otherwise.
  const markSubmitted = useCallback(
    async (response: string) => {
      const now = Date.now()
      submittedAtRef.current = now
      setSubmittedResponse(response)
      const draft: DraftState = {
        selections: selectionsToEntries(selections),
        otherTexts: otherTextsToEntries(otherTexts),
        activeTab,
        submittedResponse: response,
        submittedAt: now,
      }
      try {
        await saveDraft(storageRef.current, toolCallId, draft)
      } catch {
        // If persistence fails, the widget still functions in-memory.
      }
    },
    [toolCallId, selections, otherTexts, activeTab]
  )

  const status = deriveSubmissionStatus(
    toolResult,
    submittedResponse != null
      ? {
          ...emptyDraft(),
          submittedResponse,
          submittedAt: submittedAtRef.current,
        }
      : null
  )

  return {
    hydrated,
    selections,
    setSelections,
    otherTexts,
    setOtherTexts,
    activeTab,
    setActiveTab,
    submittedResponse,
    markSubmitted,
    needsRetry: status.needsRetry,
    answered: status.answered,
    displayResponse: status.displayResponse,
  }
}
