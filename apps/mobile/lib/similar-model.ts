// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { AUTO_MODEL_ID } from '@shogo/model-catalog'
import type { PickerModel } from './visible-models'

/**
 * A model to suggest when `currentId` is overloaded: same tier (so the user
 * already has access and gets comparable quality), preferring a different
 * provider since overload is usually provider-wide. Null when nothing fits or
 * the user is on Auto (which already routes around overload).
 */
export function pickSimilarModel(currentId: string, models: PickerModel[]): PickerModel | null {
  if (!currentId || currentId === AUTO_MODEL_ID) return null
  const current = models.find((m) => m.id === currentId)
  if (!current) return null
  const candidates = models.filter((m) => m.id !== currentId && m.id !== AUTO_MODEL_ID && m.tier === current.tier)
  const otherProvider = candidates.find((m) => m.provider && current.provider && m.provider !== current.provider)
  return otherProvider ?? candidates.find((m) => m.family !== current.family) ?? null
}
