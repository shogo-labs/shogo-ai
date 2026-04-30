// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Native file/image attachment picker for Android & iOS.
 *
 * Uses expo-image-picker for photos (gallery + camera) and
 * expo-document-picker for files. Document bytes are read with
 * expo-file-system and encoded via @shogo-ai/sdk (no fetch on file URIs).
 *
 * UI: AttachSourceSheet (components/chat) — Modal with backdrop dismiss.
 */

import { buildDataUrlFromBase64 } from "@shogo-ai/sdk"
import { EncodingType, readAsStringAsync } from "expo-file-system/legacy"
import * as ImagePicker from "expo-image-picker"

export interface NativePickedAttachment {
  id: string
  dataUrl: string
  name: string
  type: string
  size: number
}

export type NativeAttachAction = "library" | "camera" | "documents"

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

  const pickLibrary = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync()
    if (!perm.granted) {
      onError("Allow photo access in Settings to attach images.")
      return
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsMultipleSelection: remaining > 1,
      selectionLimit: remaining,
      quality: 0.92,
      base64: true,
    })
    if (result.canceled || !result.assets?.length) return

    const out: NativePickedAttachment[] = []
    for (const asset of result.assets) {
      if (asset.type === "video") continue
      const b64 = asset.base64
      if (!b64) {
        onError("Could not read the selected image. Try again.")
        return
      }
      const mime = asset.mimeType ?? "image/jpeg"
      const size = asset.fileSize ?? Math.floor((b64.length * 3) / 4)
      if (size > maxFileSizeBytes) {
        onError(`Each file must be under ${maxFileSizeBytes / (1024 * 1024)} MB.`)
        return
      }
      out.push({
        id: uid(),
        dataUrl: `data:${mime};base64,${b64}`,
        name: asset.fileName?.trim() || `image_${uid()}.jpg`,
        type: mime,
        size,
      })
    }
    if (out.length > 0) onFiles(out)
  }

  const pickCamera = async () => {
    const perm = await ImagePicker.requestCameraPermissionsAsync()
    if (!perm.granted) {
      onError("Allow camera access in Settings to take a photo.")
      return
    }
    const result = await ImagePicker.launchCameraAsync({ quality: 0.92, base64: true })
    if (result.canceled || !result.assets?.[0]) return
    const asset = result.assets[0]
    const b64 = asset.base64
    if (!b64) {
      onError("Could not read the captured photo.")
      return
    }
    const mime = asset.mimeType ?? "image/jpeg"
    const size = asset.fileSize ?? Math.floor((b64.length * 3) / 4)
    if (size > maxFileSizeBytes) {
      onError(`Each file must be under ${maxFileSizeBytes / (1024 * 1024)} MB.`)
      return
    }
    onFiles([
      {
        id: uid(),
        dataUrl: `data:${mime};base64,${b64}`,
        name: asset.fileName?.trim() || `photo_${Date.now()}.jpg`,
        type: mime,
        size,
      },
    ])
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
      let dataUrl: string
      try {
        dataUrl = await uriToDataUrl(doc.uri, mime)
      } catch {
        onError(`Could not read "${doc.name}".`)
        return
      }
      const size = doc.size ?? dataUrl.length
      if (size > maxFileSizeBytes) {
        onError(`"${doc.name}" exceeds ${maxFileSizeBytes / (1024 * 1024)} MB.`)
        return
      }
      out.push({ id: uid(), dataUrl, name: doc.name, type: mime, size })
    }
    if (out.length > 0) onFiles(out)
  }

  if (action === "library") run(pickLibrary)
  else if (action === "camera") run(pickCamera)
  else run(pickDocuments)
}
