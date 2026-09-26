// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

export const DEFAULT_IMAGE_ASPECT = 4 / 3
const MIN_IMAGE_ASPECT = 0.5
const MAX_IMAGE_ASPECT = 2

export function clampAspectRatio(
  width?: number,
  height?: number,
  fallback = DEFAULT_IMAGE_ASPECT,
): number {
  if (!width || !height || width <= 0 || height <= 0) return fallback
  return Math.min(MAX_IMAGE_ASPECT, Math.max(MIN_IMAGE_ASPECT, width / height))
}

export function getChatImageWidth(
  viewportWidth: number,
  min = 220,
  max = 320,
): number {
  return Math.min(max, Math.max(min, viewportWidth - 80))
}
