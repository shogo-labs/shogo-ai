// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Native file/image attachment picker for Android & iOS.
 *
 * Uses expo-image-picker for photos/videos (gallery + camera) and
 * expo-document-picker for files. Document bytes are read with
 * expo-file-system and encoded via @shogo-ai/sdk (no fetch on file URIs).
 *
 * UI: AttachSourceSheet (components/chat) — Modal with backdrop dismiss.
 */

import { buildDataUrlFromBase64 } from "@shogo-ai/sdk"
import {
  isVideoAttachmentType,
  videoMimeTypeFromName,
} from "@shogo-ai/core/video-attachment-contract"
import { EncodingType, readAsStringAsync } from "expo-file-system/legacy"
import * as ImagePicker from "expo-image-picker"

export interface NativePickedAttachment {
  id: string
  dataUrl: string
  name: string
  type: string
  size: number
}

export type NativeAttachAction = "library" | "camera" | "camera-video" | "documents"

export interface NativeAttachPickerOptions {
  currentCount: number
  maxFiles: number
  maxFileSizeBytes: number
  onFiles: (files: NativePickedAttachment[]) => void
  onError: (message: string) => void
}

function uid(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function mimeFromName(name: string): string {
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
  const videoMime = videoMimeTypeFromName(name)
  if (videoMime) return videoMime
  if (l.endsWith(".zip")) return "application/zip"
  return "application/octet-stream"
}

async function uriToDataUrl(uri: string, mime: string): Promise<string> {
  const base64 = await readAsStringAsync(uri, {
    encoding: EncodingType.Base64,
  })
  return buildDataUrlFromBase64(mime, base64)
}

/** Runs one attach flow (library, camera, or document picker). */
export function executeNativeAttachAction(
  action: NativeAttachAction,
  opts: NativeAttachPickerOptions
): void {
  const { currentCount, maxFiles, maxFileSizeBytes, onFiles, onError } = opts
  const remaining = maxFiles - currentCount
  if (remaining <= 0) return

  const run = (fn: () => Promise<void>) => {
    fn().catch((err: unknown) => {
      console.warn("[NativeAttachPicker] Error:", err)
      onError(err instanceof Error ? err.message : "Something went wrong")
    })
  }

  const buildAttachmentFromAsset = async (
    asset: ImagePicker.ImagePickerAsset,
    fallbackName: string,
    fallbackMime: string,
  ): Promise<NativePickedAttachment | null> => {
    const mime = asset.mimeType ?? (asset.fileName ? mimeFromName(asset.fileName) : fallbackMime)
    const name = asset.fileName?.trim() || fallbackName
    const video = asset.type === "video" || isVideoAttachmentType(mime, name)
    const b64 = asset.base64
    const size = asset.fileSize ?? (b64 ? Math.floor((b64.length * 3) / 4) : undefined)
    const sizeLimit = `${maxFileSizeBytes / (1024 * 1024)} MB`
    const tooLargeMessage = video
      ? `This video is too large for chat upload. Try a shorter clip or compress it. "${name}" exceeds ${sizeLimit}.`
      : `"${name}" exceeds ${sizeLimit}.`
    if (typeof size === "number" && size > maxFileSizeBytes) {
      onError(tooLargeMessage)
      return null
    }
    const dataUrl = b64 ? `data:${mime};base64,${b64}` : await uriToDataUrl(asset.uri, mime)
    const finalSize = size ?? Math.floor(Math.max(0, dataUrl.length - `data:${mime};base64,`.length) * 3 / 4)
    if (finalSize > maxFileSizeBytes) {
      onError(tooLargeMessage)
      return null
    }
    return {
      id: uid(),
      dataUrl,
      name,
      type: mime,
      size: finalSize,
    }
  }

  const pickLibrary = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync()
    if (!perm.granted) {
      onError("Allow photo access in Settings to attach photos or videos.")
      return
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images", "videos"],
      allowsMultipleSelection: remaining > 1,
      selectionLimit: remaining,
      quality: 0.92,
      base64: false,
    })
    if (result.canceled || !result.assets?.length) return

    const out: NativePickedAttachment[] = []
    for (const asset of result.assets) {
      const fallbackMime = asset.type === "video" ? "video/mp4" : "image/jpeg"
      const fallbackExt = asset.type === "video" ? "mp4" : "jpg"
      let attachment: NativePickedAttachment | null
      try {
        attachment = await buildAttachmentFromAsset(asset, `${asset.type || "media"}_${uid()}.${fallbackExt}`, fallbackMime)
      } catch {
        onError(asset.type === "video" ? "Could not read the video from your device. Try choosing it from Files instead." : "Could not read the selected image. Try again.")
        return
      }
      if (attachment) out.push(attachment)
    }
    if (out.length > 0) onFiles(out)
  }

  const pickCamera = async () => {
    const perm = await ImagePicker.requestCameraPermissionsAsync()
    if (!perm.granted) {
      onError("Allow camera access in Settings to take a photo.")
      return
    }
    const result = await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 0.92, base64: true })
    if (result.canceled || !result.assets?.[0]) return
    try {
      const attachment = await buildAttachmentFromAsset(result.assets[0], `photo_${Date.now()}.jpg`, "image/jpeg")
      if (attachment) onFiles([attachment])
    } catch {
      onError("Could not read the captured photo.")
    }
  }

  const recordVideo = async () => {
    const perm = await ImagePicker.requestCameraPermissionsAsync()
    if (!perm.granted) {
      onError("Allow camera access in Settings to record a video.")
      return
    }
    const result = await ImagePicker.launchCameraAsync({ mediaTypes: ["videos"], quality: 0.92 })
    if (result.canceled || !result.assets?.[0]) return
    try {
      const attachment = await buildAttachmentFromAsset(result.assets[0], `video_${Date.now()}.mp4`, "video/mp4")
      if (attachment) onFiles([attachment])
    } catch {
      onError("Could not read the recorded video.")
    }
  }

  const pickDocuments = async () => {
    let getDocumentAsync: typeof import("expo-document-picker").getDocumentAsync
    try {
      ;({ getDocumentAsync } = await import("expo-document-picker"))
    } catch {
      onError(
        "File picker is not in this app build. Rebuild the native app (e.g. run `npx expo run:android` in apps/mobile, or a new EAS development build).",
      )
      return
    }
    const result = await getDocumentAsync({
      type: "*/*",
      multiple: remaining > 1,
      copyToCacheDirectory: true,
    })
    if (result.canceled || !result.assets?.length) return

    const out: NativePickedAttachment[] = []
    for (const doc of result.assets) {
      const mime = doc.mimeType?.trim() || mimeFromName(doc.name)
      const video = isVideoAttachmentType(mime, doc.name)
      const lowerName = doc.name.toLowerCase()
      const isExempt =
        lowerName.endsWith(".zip") ||
        lowerName.endsWith(".shogo") ||
        lowerName.endsWith(".shogo-project") ||
        mime === "application/zip" ||
        mime === "application/x-zip-compressed"
      if (!isExempt && typeof doc.size === "number" && doc.size > maxFileSizeBytes) {
        onError(video ? `This video is too large for chat upload. Try a shorter clip or compress it. "${doc.name}" exceeds ${maxFileSizeBytes / (1024 * 1024)} MB.` : `"${doc.name}" exceeds ${maxFileSizeBytes / (1024 * 1024)} MB.`)
        return
      }
      let dataUrl: string
      try {
        dataUrl = await uriToDataUrl(doc.uri, mime)
      } catch {
        onError(video ? "Could not read the video from your device. Try choosing it from Files instead." : `Could not read "${doc.name}".`)
        return
      }
      const size = doc.size ?? Math.floor(Math.max(0, dataUrl.length - `data:${mime};base64,`.length) * 3 / 4)
      if (!isExempt && size > maxFileSizeBytes) {
        onError(video ? `This video is too large for chat upload. Try a shorter clip or compress it. "${doc.name}" exceeds ${maxFileSizeBytes / (1024 * 1024)} MB.` : `"${doc.name}" exceeds ${maxFileSizeBytes / (1024 * 1024)} MB.`)
        return
      }
      out.push({ id: uid(), dataUrl, name: doc.name, type: mime, size })
    }
    if (out.length > 0) onFiles(out)
  }

  if (action === "library") run(pickLibrary)
  else if (action === "camera") run(pickCamera)
  else if (action === "camera-video") run(recordVideo)
  else run(pickDocuments)
}
