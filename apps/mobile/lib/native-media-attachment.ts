// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * What the native media pickers ask for, and what one picked asset becomes
 * (SHO-386).
 *
 * Kept apart from `native-attachment-picker.ts` so the decisions — which media
 * types the photo library and camera offer, and how a video becomes a
 * disk-streamed attachment instead of a base64 string — are unit-testable
 * without a device.
 */

import { getInfoAsync } from "expo-file-system/legacy"
import type {
  ImagePickerAsset,
  MediaType,
  ImagePickerOptions,
} from "expo-image-picker"
import type { NativePickedAttachment } from "./native-attachment-picker"

/** Photos and videos, on both the library and the camera (SHO-386). */
export const NATIVE_MEDIA_TYPES: MediaType[] = ["images", "videos"]

export function newAttachmentId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function mimeFromName(name: string): string {
  const l = name.toLowerCase()
  if (l.endsWith(".pdf")) return "application/pdf"
  if (l.endsWith(".txt") || l.endsWith(".log")) return "text/plain"
  if (l.endsWith(".md") || l.endsWith(".markdown")) return "text/markdown"
  if (l.endsWith(".csv")) return "text/csv"
  if (l.endsWith(".json")) return "application/json"
  if (l.endsWith(".xml")) return "application/xml"
  if (l.endsWith(".yaml") || l.endsWith(".yml")) return "application/x-yaml"
  if (l.endsWith(".doc")) return "application/msword"
  if (l.endsWith(".docx"))
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  if (l.endsWith(".png")) return "image/png"
  if (l.endsWith(".jpg") || l.endsWith(".jpeg")) return "image/jpeg"
  if (l.endsWith(".gif")) return "image/gif"
  if (l.endsWith(".webp")) return "image/webp"
  if (l.endsWith(".heic")) return "image/heic"
  if (l.endsWith(".bmp")) return "image/bmp"
  if (l.endsWith(".svg")) return "image/svg+xml"
  if (l.endsWith(".mov")) return "video/quicktime"
  if (l.endsWith(".mp4")) return "video/mp4"
  if (l.endsWith(".m4v")) return "video/x-m4v"
  if (l.endsWith(".zip")) return "application/zip"
  return "application/octet-stream"
}

export function tooLargeMessage(maxFileSizeBytes: number): string {
  return `Each file must be under ${maxFileSizeBytes / (1024 * 1024)} MB.`
}

/** The photo-library options: both media types, videos included. */
export function libraryPickerOptions(remaining: number): ImagePickerOptions {
  return {
    mediaTypes: NATIVE_MEDIA_TYPES,
    allowsMultipleSelection: remaining > 1,
    selectionLimit: remaining,
    quality: 0.92,
    base64: true,
  }
}

/** The camera options: the same media types, so iOS shows its Photo/Video switch. */
export function cameraPickerOptions(): ImagePickerOptions {
  return {
    mediaTypes: NATIVE_MEDIA_TYPES,
    quality: 0.92,
    base64: true,
  }
}

function isVideoAsset(asset: ImagePickerAsset): boolean {
  if (asset.type === "video" || asset.type === "pairedVideo") return true
  if (asset.type === "image" || asset.type === "livePhoto") return false
  return (asset.mimeType ?? "").toLowerCase().startsWith("video/")
}

/**
 * A video picked from the library often arrives without `fileSize`. Its size
 * decides whether the plan's cap rejects it, so it is measured on disk rather
 * than assumed — `0` means "unknown" and the caller must refuse the file.
 */
async function videoSize(asset: ImagePickerAsset): Promise<number> {
  if (typeof asset.fileSize === "number" && asset.fileSize > 0) {
    return asset.fileSize
  }
  try {
    const info = await getInfoAsync(asset.uri)
    return info.exists && typeof info.size === "number" ? info.size : 0
  } catch (err) {
    console.warn("[NativeAttachPicker] Could not read video size:", err)
    return 0
  }
}

/**
 * Turns one picked or captured asset into a composer attachment.
 *
 * Images keep their bytes inline (base64) as before. A video is never read
 * into a JS string: it is uploaded straight from disk, so it carries only its
 * `uri` plus that same URI as `previewUrl` for the chip and the preview modal
 * (SHO-386).
 */
export async function attachmentFromAsset(
  asset: ImagePickerAsset,
  maxFileSizeBytes: number,
  source: "library" | "camera"
): Promise<
  { ok: true; attachment: NativePickedAttachment } | { ok: false; error: string }
> {
  const name = asset.fileName?.trim()

  if (isVideoAsset(asset)) {
    const size = await videoSize(asset)
    if (size <= 0) {
      return {
        ok: false,
        error: "Could not read the size of the selected video. Try again.",
      }
    }
    if (size > maxFileSizeBytes) {
      return { ok: false, error: tooLargeMessage(maxFileSizeBytes) }
    }
    const fallbackMime = mimeFromName(name || `video_${newAttachmentId()}.mov`)
    return {
      ok: true,
      attachment: {
        id: newAttachmentId(),
        dataUrl: "",
        name: name || `video_${newAttachmentId()}.mov`,
        type:
          asset.mimeType?.trim() ||
          (fallbackMime.startsWith("video/")
            ? fallbackMime
            : "video/quicktime"),
        size,
        uri: asset.uri,
        previewUrl: asset.uri,
      },
    }
  }

  const b64 = asset.base64
  if (!b64) {
    return {
      ok: false,
      error:
        source === "camera"
          ? "Could not read the captured photo."
          : "Could not read the selected image. Try again.",
    }
  }
  const mime = asset.mimeType ?? "image/jpeg"
  const size = asset.fileSize ?? Math.floor((b64.length * 3) / 4)
  if (size > maxFileSizeBytes) {
    return { ok: false, error: tooLargeMessage(maxFileSizeBytes) }
  }
  return {
    ok: true,
    attachment: {
      id: newAttachmentId(),
      dataUrl: `data:${mime};base64,${b64}`,
      name:
        name ||
        `${source === "camera" ? "photo" : "image"}_${newAttachmentId()}.jpg`,
      type: mime,
      size,
    },
  }
}
