// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Native file/photo/video attachment picker for Android & iOS.
 *
 * Uses expo-image-picker for photos and videos (gallery + camera) and
 * expo-document-picker for files. Document bytes are read with
 * expo-file-system and encoded via @shogo-ai/sdk (no fetch on file URIs).
 * A video is never read into base64 — it is uploaded from disk (SHO-386); see
 * `native-media-attachment.ts` for what each pick becomes.
 *
 * UI: AttachSourceSheet (components/chat) — Modal with backdrop dismiss.
 */

import { buildDataUrlFromBase64 } from "@shogo-ai/sdk"
import { EncodingType, readAsStringAsync } from "expo-file-system/legacy"
import * as ImagePicker from "expo-image-picker";
import { Platform } from "react-native"
import { isComposerArchive } from "./composer-attachments"
import {
  attachmentFromAsset,
  cameraPickerOptions,
  libraryPickerOptions,
  mimeFromName,
  newAttachmentId,
} from "./native-media-attachment"

export interface NativePickedAttachment {
  id: string
  /**
   * Inline bytes, or `""` for a large file picked without a base64 read (see
   * `uri`): a 200 MB archive is uploaded straight from disk instead of being
   * inflated into a JS string first (SHO-213).
   */
  dataUrl: string
  name: string
  type: string
  size: number
  /** Local file URI, when the picker kept the file on disk. */
  uri?: string
  /**
   * Local URL the composer can paint or play before the upload replaces it
   * with a workspace URL. A picked video keeps its on-device URI here, since
   * its bytes are never read into a data URL (SHO-386).
   */
  previewUrl?: string
}

/**
 * Above this size a document is not read into base64 at pick time. The
 * composer only needs its name and size to render the chip, and the upload
 * streams the file from `uri`.
 */
const MAX_PICK_BASE64_BYTES = 8 * 1024 * 1024

export type NativeAttachAction = "library" | "camera" | "documents"

export interface NativeAttachPickerOptions {
  currentCount: number
  maxFiles: number
  maxFileSizeBytes: number
  onFiles: (files: NativePickedAttachment[]) => void
  onError: (message: string) => void
}

async function uriToDataUrl(uri: string, mime: string): Promise<string> {
  const base64 = await readAsStringAsync(uri, {
    encoding: EncodingType.Base64,
  })
  return buildDataUrlFromBase64(mime, base64)
}

/**
 * Runs one attach flow (library, camera, or document picker).
 *
 * **Native only.** On web both pickers go through a shim that clicks a
 * detached `<input>` from inside an async chain, which iOS Safari ignores —
 * the chooser only opens from a click inside the tap's own task (SHO-283).
 * Web callers must click the composer's own hidden `<input type="file">`
 * synchronously instead (see `openWebAttachPicker` in `ChatInput`).
 */
export function executeNativeAttachAction(
  action: NativeAttachAction,
  opts: NativeAttachPickerOptions
): void {
  if (Platform.OS === "web") {
    console.warn(
      "[NativeAttachPicker] executeNativeAttachAction is native-only; web opens the composer file input instead.",
    )
    return
  }
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
    const result = await ImagePicker.launchImageLibraryAsync(
      libraryPickerOptions(remaining)
    )
    if (result.canceled || !result.assets?.length) return

    const out: NativePickedAttachment[] = []
    for (const asset of result.assets) {
      const built = await attachmentFromAsset(asset, maxFileSizeBytes, "library")
      if (!built.ok) {
        onError(built.error)
        return
      }
      out.push(built.attachment)
    }
    if (out.length > 0) onFiles(out)
  }

  const pickCamera = async () => {
    const perm = await ImagePicker.requestCameraPermissionsAsync()
    if (!perm.granted) {
      onError("Allow camera access in Settings to take a photo or video.")
      return
    }
    const result = await ImagePicker.launchCameraAsync(cameraPickerOptions())
    if (result.canceled || !result.assets?.[0]) return
    const built = await attachmentFromAsset(
      result.assets[0],
      maxFileSizeBytes,
      "camera"
    )
    if (!built.ok) {
      onError(built.error)
      return
    }
    onFiles([built.attachment])
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
      const size = doc.size ?? 0
      if (size > maxFileSizeBytes) {
        onError(`"${doc.name}" exceeds ${maxFileSizeBytes / (1024 * 1024)} MB.`)
        return
      }
      // Archives are usually large; anything past the base64 threshold is
      // uploaded from disk instead of being read here.
      const streamFromDisk = isComposerArchive(doc.name, mime) || size > MAX_PICK_BASE64_BYTES
      if (streamFromDisk) {
        out.push({ id: newAttachmentId(), dataUrl: "", name: doc.name, type: mime, size, uri: doc.uri })
        continue
      }
      let dataUrl: string
      try {
        dataUrl = await uriToDataUrl(doc.uri, mime)
      } catch {
        onError(`Could not read "${doc.name}".`)
        return
      }
      out.push({ id: newAttachmentId(), dataUrl, name: doc.name, type: mime, size: size || dataUrl.length })
    }
    if (out.length > 0) onFiles(out)
  }

  if (action === "library") run(pickLibrary)
  else if (action === "camera") run(pickCamera)
  else run(pickDocuments)
}
