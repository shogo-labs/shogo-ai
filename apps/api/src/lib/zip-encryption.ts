// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * zip-encryption
 *
 * Standard password-protected ZIP support for `.shogo` bundles, using the
 * legacy ZipCrypto (Zip 2.0) scheme so the resulting archive opens in any
 * standard tool (macOS Finder, `unzip`, Windows Explorer, 7-Zip, etc.).
 *
 * ZipCrypto is intentionally chosen for maximum compatibility. It is
 * cryptographically weak; it is the user-selected trade-off for "any tool can
 * open it with the password". The unencrypted export path keeps using `fflate`.
 *
 * `@zip.js/zip.js` is the single dependency that can both write and read
 * encrypted zips in Node/Bun. Web Workers are disabled because the API pod
 * runs server-side where the inline (worker-less) path is simpler and avoids
 * bundling the worker script.
 */
import {
  ZipWriter,
  ZipReader,
  Uint8ArrayReader,
  Uint8ArrayWriter,
  configure,
  ERR_INVALID_PASSWORD,
  ERR_ENCRYPTED,
} from '@zip.js/zip.js'

configure({ useWebWorkers: false })

/** Thrown when a password-protected archive cannot be unlocked. */
export class ZipPasswordError extends Error {
  constructor(message = 'Incorrect password') {
    super(message)
    this.name = 'ZipPasswordError'
  }
}

/**
 * Detects whether a ZIP buffer is encrypted by inspecting the first local file
 * header's general-purpose bit flag (bit 0 = encrypted). We encrypt every
 * entry on export, so the first entry's flag is representative of the archive.
 */
export function isEncryptedZip(bytes: Uint8Array): boolean {
  if (bytes.length < 8) return false
  // Local file header signature: PK\x03\x04 (0x04034b50, little-endian on disk).
  const isLocalHeader =
    bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04
  if (!isLocalHeader) return false
  const generalPurposeFlag = bytes[6] | (bytes[7] << 8)
  return (generalPurposeFlag & 0x0001) === 1
}

/**
 * Builds a ZipCrypto-encrypted archive from a name → bytes map. Mirrors the
 * shape produced by `fflate`'s `zipSync` so the rest of the pipeline is
 * unchanged.
 */
export async function encryptZipCrypto(
  files: Record<string, Uint8Array>,
  password: string,
): Promise<Uint8Array> {
  const writer = new ZipWriter(new Uint8ArrayWriter(), {
    password,
    zipCrypto: true,
  })
  for (const [name, data] of Object.entries(files)) {
    await writer.add(name, new Uint8ArrayReader(data))
  }
  return writer.close()
}

/**
 * Extracts a password-protected archive into a name → bytes map matching the
 * shape returned by `fflate`'s `unzipSync`.
 *
 * Throws {@link ZipPasswordError} when the password is missing or wrong, so the
 * caller can surface a clean user-facing message instead of a library error.
 */
export async function decryptZip(
  bytes: Uint8Array,
  password: string,
): Promise<Record<string, Uint8Array>> {
  const reader = new ZipReader(new Uint8ArrayReader(bytes), { password })
  try {
    const entries = await reader.getEntries()
    const out: Record<string, Uint8Array> = {}
    for (const entry of entries) {
      if (entry.directory) continue
      // `getData` is where ZipCrypto decryption (and password validation)
      // actually happens, so password errors surface here.
      out[entry.filename] = await entry.getData!(new Uint8ArrayWriter())
    }
    return out
  } catch (err: any) {
    const msg = String(err?.message ?? err ?? '')
    if (msg === ERR_INVALID_PASSWORD || msg === ERR_ENCRYPTED || /password/i.test(msg)) {
      throw new ZipPasswordError()
    }
    throw err
  } finally {
    await reader.close()
  }
}
