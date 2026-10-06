// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Multipart file parts for native uploads.
 *
 * On iOS/Android the global `fetch` is `expo/fetch`, whose FormData encoder
 * only accepts strings, Blobs, and objects with a `bytes()` method. React
 * Native's `{ uri, name, type }` file shape is rejected with "Unsupported
 * FormDataPart implementation", so native callers send an `UploadPart`.
 */

export type UploadPart = { name: string; type: string; bytes: () => Promise<Uint8Array> }

/** A local file as a multipart part the native global fetch (expo/fetch) can encode. */
export function localFilePart(uri: string, name: string, type: string): UploadPart {
  return {
    name,
    type,
    bytes: async () => {
      const { File } = await import('expo-file-system')
      return new File(uri).bytes()
    },
  }
}

/** In-memory bytes as a multipart part. */
export function bytesPart(bytes: Uint8Array, name: string, type: string): UploadPart {
  return { name, type, bytes: async () => bytes }
}
