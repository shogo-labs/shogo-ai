// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Pick one file and read it as base64 — the Android upload keystore.
 *
 * The keystore is a binary file, so `AppStoresSection` cannot offer it as a
 * text field. Everything else in this app that reads a picked document goes
 * through `native-attachment-picker`, which is built around chat attachments
 * (counts, size limits, media types, an on-disk path for large archives); a
 * 2 KB signing key needs none of that and needs the bytes inline.
 *
 * Web must not be routed through the native picker's async shim: iOS Safari
 * only opens a file chooser from a click inside the tap's own task (SHO-283),
 * so the web branch creates its `<input>` and clicks it before any `await`.
 */

import { EncodingType, readAsStringAsync } from 'expo-file-system/legacy'
import { Platform } from 'react-native'

export interface PickedFile {
  name: string
  base64: string
}

/**
 * Picker `type` filter. A narrow MIME list hides `.jks` on iOS's document
 * chooser, so the wildcard MIME stays in the list.
 */
const KEYSTORE_MIMES = ['application/octet-stream', 'application/x-java-keystore', '*/*']

export async function pickKeystoreFile(): Promise<PickedFile | null> {
  return Platform.OS === 'web' ? pickOnWeb() : pickOnNative()
}

async function pickOnNative(): Promise<PickedFile | null> {
  const { getDocumentAsync } = await import('expo-document-picker')
  const result = await getDocumentAsync({
    type: KEYSTORE_MIMES,
    multiple: false,
    copyToCacheDirectory: true,
  })
  const doc = result.canceled ? null : result.assets?.[0]
  if (!doc) return null
  const base64 = await readAsStringAsync(doc.uri, { encoding: EncodingType.Base64 })
  return { name: doc.name, base64 }
}

/** `document` only exists on web; typed narrowly so native builds never touch it. */
function pickOnWeb(): Promise<PickedFile | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.jks,.keystore,application/octet-stream'
    input.onchange = () => {
      const file = input.files?.[0]
      if (!file) {
        resolve(null)
        return
      }
      // `FileReader` rather than the data URL on `input.value`: the data URL is
      // the whole file in a string we would then have to split anyway.
      const reader = new FileReader()
      reader.onerror = () => reject(new Error(`Could not read ${file.name}.`))
      reader.onload = () => {
        const result = String(reader.result ?? '')
        const comma = result.indexOf(',')
        if (comma < 0) {
          reject(new Error(`Could not read ${file.name}.`))
          return
        }
        resolve({ name: file.name, base64: result.slice(comma + 1) })
      }
      reader.readAsDataURL(file)
    }
    // Clicked synchronously, in the tap's own task (SHO-283).
    input.click()
  })
}

/** The keystore back out as a download, for the user's own copy. */
export async function downloadKeystoreFile(opts: {
  filename: string
  base64: string
}): Promise<void> {
  if (Platform.OS === 'web') {
    const bytes = Uint8Array.from(atob(opts.base64), (c) => c.charCodeAt(0))
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }))
    const link = document.createElement('a')
    link.href = url
    link.download = opts.filename
    link.click()
    URL.revokeObjectURL(url)
    return
  }
  const { cacheDirectory, writeAsStringAsync, EncodingType } = await import('expo-file-system/legacy')
  const { shareAsync } = await import('expo-sharing')
  const target = `${cacheDirectory ?? ''}${opts.filename}`
  await writeAsStringAsync(target, opts.base64, { encoding: EncodingType.Base64 })
  await shareAsync(target, { mimeType: 'application/octet-stream', dialogTitle: opts.filename })
}
