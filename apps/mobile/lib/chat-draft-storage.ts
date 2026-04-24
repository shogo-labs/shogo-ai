// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import AsyncStorage from "@react-native-async-storage/async-storage"

export interface PersistedDraftFile {
  id: string
  dataUrl?: string
  name: string
  type: string
  size: number
  requiresReattach?: boolean
}

export interface PersistedPastedText {
  id: string
  content: string
}

export interface PersistedChatDraft {
  text: string
  files: PersistedDraftFile[]
  pastedTexts: PersistedPastedText[]
}

export type SaveChatDraftResult = "full" | "metadata-only" | "cleared" | "failed"

const STORAGE_KEY_PREFIX = "chat-draft-v1:"

function buildStorageKey(draftKey: string): string {
  return `${STORAGE_KEY_PREFIX}${draftKey}`
}

export async function loadChatDraft(
  draftKey: string | null | undefined
): Promise<PersistedChatDraft | null> {
  if (!draftKey) return null

  try {
    const raw = await AsyncStorage.getItem(buildStorageKey(draftKey))
    if (!raw) return null

    const parsed = JSON.parse(raw) as Partial<PersistedChatDraft> | null
    if (!parsed || typeof parsed !== "object") return null

    const text = typeof parsed.text === "string" ? parsed.text : ""
    const files = Array.isArray(parsed.files)
      ? parsed.files.filter(
          (file): file is PersistedDraftFile =>
            !!file &&
            typeof file.id === "string" &&
            typeof file.name === "string" &&
            typeof file.type === "string" &&
            typeof file.size === "number" &&
            (file.dataUrl === undefined || typeof file.dataUrl === "string") &&
            (file.requiresReattach === undefined || typeof file.requiresReattach === "boolean")
        )
      : []
    const pastedTexts = Array.isArray(parsed.pastedTexts)
      ? parsed.pastedTexts.filter(
          (entry): entry is PersistedPastedText =>
            !!entry &&
            typeof entry.id === "string" &&
            typeof entry.content === "string"
        )
      : []

    if (!text && files.length === 0 && pastedTexts.length === 0) {
      return null
    }

    return { text, files, pastedTexts }
  } catch {
    return null
  }
}

export async function saveChatDraft(
  draftKey: string | null | undefined,
  draft: PersistedChatDraft
): Promise<SaveChatDraftResult> {
  if (!draftKey) return "failed"

  const hasContent =
    draft.text.trim().length > 0 ||
    draft.files.length > 0 ||
    draft.pastedTexts.length > 0

  try {
    if (!hasContent) {
      await AsyncStorage.removeItem(buildStorageKey(draftKey))
      return "cleared"
    }

    await AsyncStorage.setItem(buildStorageKey(draftKey), JSON.stringify(draft))
    return "full"
  } catch {
    const metadataOnlyDraft: PersistedChatDraft = {
      text: draft.text,
      pastedTexts: draft.pastedTexts,
      files: draft.files.map((file) => ({
        id: file.id,
        name: file.name,
        type: file.type,
        size: file.size,
        requiresReattach: true,
      })),
    }

    try {
      await AsyncStorage.setItem(buildStorageKey(draftKey), JSON.stringify(metadataOnlyDraft))
      return "metadata-only"
    } catch {
      return "failed"
    }
  }
}

export async function clearChatDraft(
  draftKey: string | null | undefined
): Promise<void> {
  if (!draftKey) return

  try {
    await AsyncStorage.removeItem(buildStorageKey(draftKey))
  } catch {
    // Silently ignore storage failures to avoid blocking input usage.
  }
}
