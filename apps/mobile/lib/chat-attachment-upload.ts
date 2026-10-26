// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Upload-first chat attachments.
 *
 * A file used to reach the agent as a base64 data URL inside the chat POST
 * body: the client inflated it by 33%, the API re-serialised it several times,
 * and the runtime decoded it — all before the agent started. A big archive
 * timed out long before the turn began (SHO-213).
 *
 * So the bytes now go up front to the runtime's streaming route
 * (`PUT /agent/chat/attachments`), and the turn carries a *reference* part
 * (`savedPath` + a workspace URL) instead of the file. Images stay inline:
 * they are small, the composer paints its thumbnail from those bytes, and
 * vision needs them on the first request.
 */

import {
  EncodingType,
  FileSystemUploadType,
  readAsStringAsync,
  uploadAsync,
} from "expo-file-system/legacy"
import { buildAgentWorkspaceUrl } from "./agent-workspace-url"

/** Runtime route that accepts streamed attachment bytes. */
export const CHAT_ATTACHMENT_UPLOAD_PATH = "/agent/chat/attachments"

/**
 * Images at or below this size still ride inline. Above it, uploading first
 * keeps a 10 MB photo out of the JSON body — the runtime reads it back from
 * the workspace and still hands the model the bytes.
 */
export const MAX_INLINE_IMAGE_BYTES = 4 * 1024 * 1024

export interface UploadableAttachment {
  name: string
  type: string
  /** Inline bytes; empty for an attachment picked without a base64 read. */
  dataUrl?: string
  /** Declared size in bytes, when the picker knew it. */
  size?: number
  /** Native: the picked file on disk, so the upload streams from it. */
  uri?: string
  /** Web: the picked `File`, so the upload streams from it. */
  file?: unknown
  /**
   * Set when this attachment is already a workspace reference (rebuilt from a
   * persisted message part on a resend). The bytes are on the runtime already,
   * so it is passed through untouched instead of being uploaded twice.
   */
  savedPath?: string
}

export interface UploadedAttachmentRef {
  savedPath: string
  /** Workspace download URL, usable as the part's display `url`. */
  url: string
  name: string
  mediaType: string
  bytes: number
}

/** An AI-SDK-shaped file part for an outgoing message. */
export interface OutgoingFilePart {
  type: "file"
  mediaType: string
  url: string
  name?: string
  /** Present only on an uploaded (reference) part. */
  savedPath?: string
}

function estimateDataUrlBytes(dataUrl: string | undefined): number {
  if (!dataUrl || !dataUrl.startsWith("data:")) return 0
  const base64 = dataUrl.includes(",") ? dataUrl.slice(dataUrl.indexOf(",") + 1) : ""
  return Math.max(0, Math.floor((base64.length * 3) / 4))
}

export function attachmentSize(file: UploadableAttachment): number {
  return file.size && file.size > 0 ? file.size : estimateDataUrlBytes(file.dataUrl)
}

/**
 * Whether this attachment should be uploaded before the turn.
 *
 * Everything but a small image does: the runtime reads a reference from disk
 * exactly as it read the base64 copy, so nothing is lost, and the chat body
 * stays the size of a sentence.
 */
export function shouldUploadAttachmentFirst(file: UploadableAttachment): boolean {
  const mediaType = (file.type || "").toLowerCase()
  if (!mediaType.startsWith("image/")) return true
  return attachmentSize(file) > MAX_INLINE_IMAGE_BYTES
}

function uploadUrl(agentUrl: string, name: string): string {
  const base = agentUrl.replace(/\/+$/, "")
  return `${base}${CHAT_ATTACHMENT_UPLOAD_PATH}?name=${encodeURIComponent(name)}`
}

function mediaTypeFor(file: UploadableAttachment): string {
  return file.type || "application/octet-stream"
}

function parseUploadBody(raw: string): { savedPath?: string; error?: { message?: string } } {
  try {
    return JSON.parse(raw) as { savedPath?: string; error?: { message?: string } }
  } catch {
    return {}
  }
}

async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  const response = await fetch(dataUrl)
  return response.blob()
}

/**
 * Ceiling for the inline fallback. An upload can be refused for a transport
 * reason the file cannot fix (a paired-machine tunnel relays text frames, so
 * binary uploads are unsupported there). Reading the file back as base64 keeps
 * a normal attachment working on those transports; past this size that copy
 * would be the very timeout this feature removes, so the failure stands.
 */
export const MAX_INLINE_FALLBACK_BYTES = 24 * 1024 * 1024

async function inlineFallback(file: UploadableAttachment): Promise<string | null> {
  if (file.dataUrl) return file.dataUrl
  if (!file.uri) return null
  if (attachmentSize(file) > MAX_INLINE_FALLBACK_BYTES) return null
  try {
    const base64 = await readAsStringAsync(file.uri, { encoding: EncodingType.Base64 })
    return `data:${mediaTypeFor(file)};base64,${base64}`
  } catch {
    return null
  }
}

/**
 * PUT one attachment's bytes to the runtime and return its workspace
 * reference. Throws with a readable message when the upload is refused or the
 * runtime is unreachable — the caller decides whether to fall back to inline.
 */
export async function uploadChatAttachment(params: {
  agentUrl: string
  file: UploadableAttachment
  /** Extra headers (auth / cookies) for the direct-to-runtime transports. */
  headers?: Record<string, string>
  fetchImpl?: typeof fetch
}): Promise<UploadedAttachmentRef> {
  const { agentUrl, file, headers = {}, fetchImpl } = params
  const mediaType = mediaTypeFor(file)
  const url = uploadUrl(agentUrl, file.name)
  const authHeaders = { ...headers, "content-type": mediaType }

  let raw: string
  let status: number

  if (file.uri) {
    // Native: streams the file off disk — no base64 read, no whole-file buffer.
    const result = await uploadAsync(url, file.uri, {
      httpMethod: "PUT",
      uploadType: FileSystemUploadType.BINARY_CONTENT,
      headers: authHeaders,
    })
    raw = result.body ?? ""
    status = result.status
  } else {
    const fetchFn = fetchImpl ?? globalThis.fetch
    const body: BodyInit = (file.file as BodyInit | undefined) ?? (await dataUrlToBlob(file.dataUrl ?? ""))
    const response = await fetchFn(url, {
      method: "PUT",
      headers: authHeaders,
      body,
      credentials: "include",
    })
    raw = await response.text().catch(() => "")
    status = response.status
  }

  const parsed = parseUploadBody(raw)
  if (status < 200 || status >= 300 || !parsed.savedPath) {
    throw new Error(
      parsed.error?.message ||
        `Could not upload "${file.name}" (HTTP ${status || "?"}).`,
    )
  }

  return {
    savedPath: parsed.savedPath,
    url: buildAgentWorkspaceUrl(agentUrl, parsed.savedPath),
    name: file.name,
    mediaType,
    bytes: attachmentSize(file),
  }
}

/**
 * Turn composer attachments into the file parts a chat turn carries.
 *
 * Large/non-image files become uploaded references; everything else keeps its
 * inline data URL. An upload that fails falls back to the inline part when the
 * bytes are still in hand (a tunnel transport, a flaky network on a small
 * file), and rethrows when they are not — sending a reference to a file that
 * never arrived would silently lose the attachment.
 */
export async function prepareOutgoingFiles(
  files: UploadableAttachment[],
  options: {
    agentUrl?: string | null
    headers?: Record<string, string>
    fetchImpl?: typeof fetch
    onUploadError?: (message: string) => void
  } = {},
): Promise<OutgoingFilePart[]> {
  const { agentUrl, headers, fetchImpl, onUploadError } = options
  const parts: OutgoingFilePart[] = []

  for (const file of files) {
    const mediaType = mediaTypeFor(file)
    const inline = (): OutgoingFilePart => ({
      type: "file",
      mediaType,
      url: file.dataUrl ?? "",
      ...(file.name ? { name: file.name } : {}),
    })

    if (file.savedPath && file.dataUrl) {
      parts.push({
        type: "file",
        mediaType,
        url: file.dataUrl,
        ...(file.name ? { name: file.name } : {}),
        savedPath: file.savedPath,
      })
      continue
    }

    if (!agentUrl || !shouldUploadAttachmentFirst(file)) {
      parts.push(inline())
      continue
    }

    try {
      const uploaded = await uploadChatAttachment({ agentUrl, file, headers, fetchImpl })
      parts.push({
        type: "file",
        mediaType: uploaded.mediaType,
        url: uploaded.url,
        name: uploaded.name,
        savedPath: uploaded.savedPath,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const fallback = await inlineFallback(file)
      if (!fallback) throw err
      console.warn(`[ChatAttachments] Upload failed, sending inline instead: ${message}`)
      onUploadError?.(message)
      parts.push({ ...inline(), url: fallback })
    }
  }

  return parts
}
