// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * The pixel size and a small preview of an outgoing chat image.
 *
 * A chat thumbnail is at most 640 px wide, but without a stored size it has to
 * decode the full photo to find out how big it is, and without a preview it
 * decodes a 12 MP original to paint a 300 px box. Both happen for every photo
 * in the turn window at once on resume, which is what made a 10-photo chat
 * slow to open and jumpy to scroll (SHO-407).
 *
 * So the size and a ≤640 px JPEG are produced once, at send time, and stored
 * on the message part. Nothing here is allowed to block a send: every failure
 * returns null and the message goes out as it did before.
 *
 * `react-native` is imported statically. A dynamic `import('react-native')`
 * reads every lazy getter on `react-native/index.js` through the wildcard
 * interop, including the deprecated `PushNotificationIOS` one, which builds a
 * `NativeEventEmitter` around a module this app does not link and throws
 * (SHOGO-IOS-15). Name what you use, and the getters you never touch stay
 * untouched.
 */
import { Image as NativeImage } from "react-native"

/** Long edge of a stored preview. A chat thumbnail never needs more. */
export const PREVIEW_MAX_EDGE = 640

/** Visually indistinguishable at thumbnail size, and a few tens of KB. */
export const PREVIEW_JPEG_QUALITY = 0.7

/**
 * How long a decode may take before the preview is abandoned.
 *
 * A preview is an optimisation, and the send waits for it, so it must never be
 * able to hang one. A real browser decodes a 12 MP JPEG in a few hundred
 * milliseconds; anything past this is a decoder that is not going to answer.
 */
export const IMAGE_DECODE_TIMEOUT_MS = 2000

export interface ImageSize {
  width: number
  height: number
}

export interface ImagePreview extends ImageSize {
  /**
   * Pixel size of the original. Carried so the caller does not have to decode
   * the image a second time just to learn how big it is.
   */
  sourceWidth: number
  sourceHeight: number
  /** Web: the encoded JPEG as a data URL, uploaded like any other file. */
  dataUrl?: string
  /** Native: the re-encoded JPEG on disk. */
  uri?: string
  name: string
  type: string
}

/** The bytes of an image the composer is holding, from any of its sources. */
export interface PreviewSource {
  name: string
  type: string
  dataUrl?: string
  uri?: string
  file?: unknown
  width?: number
  height?: number
}

/**
 * Whether a canvas is available to decode and re-encode with.
 *
 * Deliberately not `Platform.OS`: this module is imported by the attachment
 * uploader, which is unit-tested in a plain Bun process where importing
 * `react-native` fails on its Flow source. A DOM is the real requirement.
 */
function hasCanvas(): boolean {
  return (
    typeof document !== "undefined" &&
    typeof document.createElement === "function"
  )
}

function positive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined
}

/**
 * The preview's pixel size: the original scaled down so its long edge is at
 * most `maxEdge`, never upscaled. Null when the source has no usable size.
 */
export function previewSize(
  width: number | undefined,
  height: number | undefined,
  maxEdge = PREVIEW_MAX_EDGE,
): ImageSize | null {
  const w = positive(width)
  const h = positive(height)
  if (!w || !h) return null
  const longest = Math.max(w, h)
  if (longest <= maxEdge) {
    return { width: Math.round(w), height: Math.round(h) }
  }
  const scale = maxEdge / longest
  return {
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale)),
  }
}

function previewName(name: string): string {
  const stem = name.replace(/\.[^./\\]+$/, "") || "image"
  return `${stem}-preview.jpg`
}

/** The URL or object a decoder can read the source bytes from. */
function sourceRef(source: PreviewSource): string | null {
  if (source.dataUrl) return source.dataUrl
  if (source.uri) return source.uri
  return null
}

// ---------------------------------------------------------------------------
// Web
// ---------------------------------------------------------------------------

interface DecodedImage {
  width: number
  height: number
  /** Draws the image into a canvas at the given size and returns a JPEG. */
  toJpeg: (size: ImageSize) => string | null
  release: () => void
}

async function decodeOnWeb(source: PreviewSource): Promise<DecodedImage | null> {
  const file = source.file as Blob | undefined
  const ref = sourceRef(source)
  if (!file && !ref) return null

  const createBitmap = (globalThis as { createImageBitmap?: unknown })
    .createImageBitmap
  if (typeof createBitmap === "function" && file) {
    const bitmap = await (createBitmap as (b: Blob) => Promise<any>)(file)
    return {
      width: bitmap.width,
      height: bitmap.height,
      toJpeg: (size) => drawToJpeg(bitmap, size),
      release: () => bitmap.close?.(),
    }
  }

  // No `createImageBitmap` (or no `File`): an `<img>` over an object URL.
  const objectUrl = file ? URL.createObjectURL(file) : (ref as string)
  const image = await new Promise<HTMLImageElement | null>((resolve) => {
    const element = new Image()
    const timer = setTimeout(() => resolve(null), IMAGE_DECODE_TIMEOUT_MS)
    element.onload = () => {
      clearTimeout(timer)
      resolve(element)
    }
    element.onerror = () => {
      clearTimeout(timer)
      resolve(null)
    }
    element.src = objectUrl
  })
  if (!image) {
    if (file) URL.revokeObjectURL(objectUrl)
    return null
  }
  return {
    width: image.naturalWidth,
    height: image.naturalHeight,
    toJpeg: (size) => drawToJpeg(image, size),
    release: () => {
      if (file) URL.revokeObjectURL(objectUrl)
    },
  }
}

function drawToJpeg(
  image: CanvasImageSource,
  size: ImageSize,
): string | null {
  if (typeof document === "undefined") return null
  const canvas = document.createElement("canvas")
  canvas.width = size.width
  canvas.height = size.height
  const context = canvas.getContext("2d")
  if (!context) return null
  context.drawImage(image, 0, 0, size.width, size.height)
  return canvas.toDataURL("image/jpeg", PREVIEW_JPEG_QUALITY)
}

// ---------------------------------------------------------------------------
// Native
// ---------------------------------------------------------------------------

async function nativeImageSize(source: PreviewSource): Promise<ImageSize | null> {
  const known = previewSize(source.width, source.height, Number.MAX_SAFE_INTEGER)
  if (known) return known
  const ref = sourceRef(source)
  if (!ref) return null
  const getSize = (NativeImage as { getSize?: unknown }).getSize
  if (typeof getSize !== "function") return null
  return new Promise<ImageSize | null>((resolve) => {
    ;(
      getSize as (
        uri: string,
        ok: (w: number, h: number) => void,
        fail?: () => void,
      ) => void
    ).call(
      NativeImage,
      ref,
      (width: number, height: number) => resolve({ width, height }),
      () => resolve(null),
    )
  })
}

async function createNativePreview(
  source: PreviewSource,
): Promise<ImagePreview | null> {
  const ref = sourceRef(source)
  if (!ref) return null
  const size = await nativeImageSize(source)
  const target = previewSize(size?.width, size?.height)
  if (!target) return null
  const { ImageManipulator, SaveFormat } = await import("expo-image-manipulator")
  const rendered = await ImageManipulator.manipulate(ref)
    .resize({ width: target.width, height: target.height })
    .renderAsync()
  const saved = await rendered.saveAsync({
    format: SaveFormat.JPEG,
    compress: PREVIEW_JPEG_QUALITY,
  })
  return {
    uri: saved.uri,
    width: saved.width,
    height: saved.height,
    sourceWidth: size?.width ?? target.width,
    sourceHeight: size?.height ?? target.height,
    name: previewName(source.name),
    type: "image/jpeg",
  }
}

// ---------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------

/**
 * The original's pixel size, from the picker when it knew it and from a decode
 * otherwise. Null when it cannot be read — the caller then stores no size and
 * the thumbnail falls back to its fixed box.
 */
export async function readImageSize(
  source: PreviewSource,
): Promise<ImageSize | null> {
  const known = previewSize(source.width, source.height, Number.MAX_SAFE_INTEGER)
  if (known) return known
  try {
    if (hasCanvas()) {
      const decoded = await decodeOnWeb(source)
      if (!decoded) return null
      const size = { width: decoded.width, height: decoded.height }
      decoded.release()
      return positive(size.width) && positive(size.height) ? size : null
    }
    return await nativeImageSize(source)
  } catch {
    return null
  }
}

/**
 * A ≤640 px JPEG of the image, ready to upload. Null when the platform cannot
 * make one (no canvas, no manipulator, an unreadable source) — a send must
 * never depend on this.
 */
export async function createImagePreview(
  source: PreviewSource,
): Promise<ImagePreview | null> {
  try {
    if (hasCanvas()) {
      const decoded = await decodeOnWeb(source)
      if (!decoded) return null
      try {
        const target = previewSize(decoded.width, decoded.height)
        if (!target) return null
        const dataUrl = decoded.toJpeg(target)
        if (!dataUrl) return null
        return {
          dataUrl,
          width: target.width,
          height: target.height,
          sourceWidth: decoded.width,
          sourceHeight: decoded.height,
          name: previewName(source.name),
          type: "image/jpeg",
        }
      } finally {
        decoded.release()
      }
    }
    return await createNativePreview(source)
  } catch {
    return null
  }
}
