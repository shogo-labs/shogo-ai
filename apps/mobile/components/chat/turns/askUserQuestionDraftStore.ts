// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * AskUserQuestion draft persistence.
 *
 * Pure, dependency-injected functions that persist the user's in-progress
 * selections (and any in-flight submission) for the AskUserQuestion poll,
 * keyed by tool call id. Keeping this module storage-agnostic lets us unit
 * test the round-trip + lifecycle semantics with bun:test and an in-memory
 * Map — no React, no AsyncStorage native module required.
 *
 * Lifecycle:
 *   - saveDraft is called (debounced) whenever the user edits selections.
 *   - loadDraft is called once on widget mount to hydrate local state.
 *   - clearDraft is called once the server-side tool.result transitions from
 *     undefined to defined (the agent accepted our answer) — or when the user
 *     successfully re-submits after a crash.
 *
 * A non-null `submittedResponse` in the persisted draft means we already sent
 * (or tried to send) a final answer. If the app was killed mid-submit, the
 * widget uses this to render an "answered" state and expose a Retry button.
 */

export interface DraftState {
  /** Entries of the `selections` Map<number, string[]> used in the widget. */
  selections: Array<[number, string[]]>
  /** Entries of the `otherTexts` Map<number, string> used in the widget. */
  otherTexts: Array<[number, string]>
  /** Which question tab was last focused. */
  activeTab: number
  /** Set once handleSubmit has formatted a response, even if the network call that follows never completed. */
  submittedResponse: string | null
  /** Wall-clock ms when submittedResponse was written. Useful for retry/stale heuristics. */
  submittedAt: number | null
}

/**
 * Minimal storage surface — a strict subset of AsyncStorage so it can be
 * satisfied by an in-memory Map in tests. Intentionally Promise-based to
 * match AsyncStorage even though the test double is synchronous.
 */
export interface DraftStorage {
  getItem(key: string): Promise<string | null>
  setItem(key: string, value: string): Promise<void>
  removeItem(key: string): Promise<void>
}

/** Storage key namespace. Kept stable so drafts survive JS reloads. */
export const DRAFT_KEY_PREFIX = "shogo:askUserDraft:"

export function draftKey(toolCallId: string): string {
  return `${DRAFT_KEY_PREFIX}${toolCallId}`
}

export function emptyDraft(): DraftState {
  return {
    selections: [],
    otherTexts: [],
    activeTab: 0,
    submittedResponse: null,
    submittedAt: null,
  }
}

/**
 * Normalizes a decoded value into a DraftState, tolerating partial/legacy
 * shapes. Returns null if the value is not recognizable as a draft at all.
 */
export function deserializeDraft(raw: unknown): DraftState | null {
  if (!raw || typeof raw !== "object") return null
  const r = raw as Record<string, unknown>

  const selections = Array.isArray(r.selections)
    ? r.selections.filter(
        (entry): entry is [number, string[]] =>
          Array.isArray(entry) &&
          entry.length === 2 &&
          typeof entry[0] === "number" &&
          Array.isArray(entry[1]) &&
          entry[1].every((s) => typeof s === "string")
      )
    : []

  const otherTexts = Array.isArray(r.otherTexts)
    ? r.otherTexts.filter(
        (entry): entry is [number, string] =>
          Array.isArray(entry) &&
          entry.length === 2 &&
          typeof entry[0] === "number" &&
          typeof entry[1] === "string"
      )
    : []

  return {
    selections,
    otherTexts,
    activeTab: typeof r.activeTab === "number" ? r.activeTab : 0,
    submittedResponse:
      typeof r.submittedResponse === "string" ? r.submittedResponse : null,
    submittedAt: typeof r.submittedAt === "number" ? r.submittedAt : null,
  }
}

export function serializeDraft(draft: DraftState): string {
  return JSON.stringify(draft)
}

/** Convert a Map<number, string[]> to the tuple form persisted on disk. */
export function selectionsToEntries(
  selections: Map<number, string[]>
): Array<[number, string[]]> {
  return Array.from(selections.entries())
}

/** Convert a Map<number, string> to the tuple form persisted on disk. */
export function otherTextsToEntries(
  otherTexts: Map<number, string>
): Array<[number, string]> {
  return Array.from(otherTexts.entries())
}

/** Inverse of selectionsToEntries — returns a fresh Map. */
export function entriesToSelections(
  entries: Array<[number, string[]]>
): Map<number, string[]> {
  return new Map(entries)
}

/** Inverse of otherTextsToEntries — returns a fresh Map. */
export function entriesToOtherTexts(
  entries: Array<[number, string]>
): Map<number, string> {
  return new Map(entries)
}

export async function saveDraft(
  storage: DraftStorage,
  toolCallId: string,
  draft: DraftState
): Promise<void> {
  await storage.setItem(draftKey(toolCallId), serializeDraft(draft))
}

export async function loadDraft(
  storage: DraftStorage,
  toolCallId: string
): Promise<DraftState | null> {
  const raw = await storage.getItem(draftKey(toolCallId))
  if (raw == null) return null
  try {
    return deserializeDraft(JSON.parse(raw))
  } catch {
    return null
  }
}

export async function clearDraft(
  storage: DraftStorage,
  toolCallId: string
): Promise<void> {
  await storage.removeItem(draftKey(toolCallId))
}

/**
 * Derives the widget-facing view of the current draft + server result:
 *
 *   - answered:    we should render the "answered" UI (either server confirmed or we have a locally persisted submittedResponse)
 *   - needsRetry:  we have a persisted submittedResponse but the server still reports undefined — the last submit likely died with the app
 *   - displayResponse: what to show under "Your Response" (server result wins over local draft)
 */
export function deriveSubmissionStatus(
  toolResult: unknown,
  draft: DraftState | null
): {
  answered: boolean
  needsRetry: boolean
  displayResponse: string | null
} {
  const serverAnswered = toolResult !== undefined
  const locallySubmitted = draft?.submittedResponse != null

  const displayResponse = serverAnswered
    ? typeof toolResult === "string"
      ? toolResult
      : null
    : (draft?.submittedResponse ?? null)

  return {
    answered: serverAnswered || locallySubmitted,
    needsRetry: !serverAnswered && locallySubmitted,
    displayResponse,
  }
}
