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

/** Widest a chat image preview grows, even in a very wide pane. */
export const CHAT_IMAGE_MAX_WIDTH = 640
/** Tallest a chat image preview grows; the width flexes around it. */
export const CHAT_IMAGE_MAX_HEIGHT = 260
/** Narrowest a chat image preview gets, so a tall image is not a sliver. */
export const CHAT_IMAGE_MIN_WIDTH = 120
/** Width used until the pane has been measured, so the first paint is not zero. */
export const UNMEASURED_IMAGE_WIDTH = 220

export interface FitChatImageOptions {
  naturalWidth?: number | null
  naturalHeight?: number | null
  /**
   * Width the image may occupy — the message row, not the window. The thread
   * sidebar and side panes are narrower than the window.
   */
  containerWidth?: number | null
  maxWidth?: number
  maxHeight?: number
  minWidth?: number
  fallbackAspect?: number
}

export interface ChatImageBox {
  width: number
  height: number
  /** The min width widened the box past its own aspect, so the image must cover. */
  cropped: boolean
}

function positive(value?: number | null): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined
}

/**
 * Size a chat image preview to both the image and the space it sits in: wide
 * images grow until the pane (or `maxWidth`) stops them, tall images stop at
 * `maxHeight` and keep their aspect ratio instead of being cropped, and nothing
 * is ever upscaled past its natural pixels.
 */
export function fitChatImage({
  naturalWidth,
  naturalHeight,
  containerWidth,
  maxWidth = CHAT_IMAGE_MAX_WIDTH,
  maxHeight = CHAT_IMAGE_MAX_HEIGHT,
  minWidth = CHAT_IMAGE_MIN_WIDTH,
  fallbackAspect = DEFAULT_IMAGE_ASPECT,
}: FitChatImageOptions = {}): ChatImageBox {
  const naturalW = positive(naturalWidth)
  const naturalH = positive(naturalHeight)
  // Deliberately not `clampAspectRatio`: a 3:1 panorama should be shown whole,
  // not squeezed into the 1:2…2:1 band that generated images are held to.
  const aspect = naturalW && naturalH ? naturalW / naturalH : fallbackAspect
  const bound = Math.min(
    positive(containerWidth) ?? UNMEASURED_IMAGE_WIDTH,
    positive(maxWidth) ?? CHAT_IMAGE_MAX_WIDTH,
  )

  let width = Math.min(bound, naturalW ?? Number.POSITIVE_INFINITY)
  let height = width / aspect
  let cropped = false

  if (height > maxHeight) {
    height = maxHeight
    width = maxHeight * aspect
    const floor = Math.min(
      positive(minWidth) ?? CHAT_IMAGE_MIN_WIDTH,
      bound,
    )
    if (width < floor) {
      width = floor
      cropped = true
    }
  }

  return { width: Math.round(width), height: Math.round(height), cropped }
}
