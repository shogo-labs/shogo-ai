// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { bytesPart, localFilePart, type UploadPart } from "./upload-part"

/** The slice of a composer attachment an upload needs. */
export interface ComposerUploadSource {
  name: string
  type: string
  /** Inline bytes. Empty for a zip or a large pick (SHO-213). */
  dataUrl: string
  /** Native: the picked file on disk. */
  uri?: string
  /** Web: the picked `File`. */
  file?: File
}

/**
 * The file a multipart upload sends for a composer attachment.
 *
 * A large file or an archive is picked without a base64 read: it has no
 * `dataUrl`, only its `File` (web) or `uri` (native). Decoding the empty
 * `dataUrl` would upload a 0-byte file, so the bytes are taken from wherever
 * the picker kept them, and an attachment with no bytes at all fails loudly.
 */
export async function composerUploadSource(
  file: ComposerUploadSource,
  isWeb: boolean,
): Promise<File | UploadPart> {
  const type = file.type || "application/octet-stream"

  if (isWeb && file.file) {
    // Re-wrapping a `File` references the same bytes; nothing is copied.
    return new File([file.file], file.name, { type })
  }
  // A phone recording or a large pick is already a file on disk; streaming it
  // avoids base64ing it through the JS thread.
  if (!isWeb && file.uri) return localFilePart(file.uri, file.name, type)

  const comma = file.dataUrl.indexOf(",")
  if (!file.dataUrl || comma === -1) {
    throw new Error(`Could not read "${file.name}".`)
  }
  const bytes = Uint8Array.from(atob(file.dataUrl.slice(comma + 1)), (c) => c.charCodeAt(0))
  if (isWeb) return new File([bytes], file.name, { type })
  // Native fetch (expo/fetch) can't encode RN's `{ uri }` parts; hand it the bytes.
  return bytesPart(bytes, file.name, type)
}
