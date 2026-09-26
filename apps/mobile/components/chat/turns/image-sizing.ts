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

/**
 * Parse image-generation sizes such as `1024x1024` into an aspect ratio.
 * Invalid or missing sizes use the same safe fallback as the sizing helpers.
 */
export function parseImageSize(size?: string): number {
  if (!size) return DEFAULT_IMAGE_ASPECT

  const match = size.trim().match(
    /^(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)$/i,
  )
  if (!match) return DEFAULT_IMAGE_ASPECT

  return clampAspectRatio(Number(match[1]), Number(match[2]))
}

export function getChatImageWidth(
  viewportWidth: number,
  min = 220,
  max = 320,
): number {
  return Math.min(max, Math.max(min, viewportWidth - 80))
}
