// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * usePickShogoArchive — the "choose a .shogo file" half of the import flow.
 *
 * Import has no options step (SHO-211): the source menu opens the OS picker
 * straight from its press handler and hands the chosen archive to
 * `ProjectImportModal`, which starts importing it immediately. The modal keeps
 * a dropzone for drag-and-drop, so both surfaces need the same pick + header
 * sniff logic — it lives here rather than in either one.
 *
 * Web/desktop note: `input.click()` needs transient user activation, so the
 * click has to happen in the same tick as the press. `pickArchive` does no
 * awaiting before the click, which is why callers may `void pickArchive()`
 * directly from `onPress` (no `setTimeout`, no waiting for a modal to mount).
 */
import { useCallback, useState } from 'react'
import { Platform } from 'react-native'

export interface PickedShogoArchive {
  blob: Blob
  name: string
  size: number
  /** True when the archive is ZipCrypto-encrypted (password required). */
  encrypted: boolean
}

/**
 * Detects ZipCrypto encryption from the first local file header's general
 * purpose bit flag (bit 0). Mirrors the server-side check.
 */
export function isEncryptedHeader(head: Uint8Array): boolean {
  if (head.length < 8) return false
  const isLocalHeader =
    head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04
  if (!isLocalHeader) return false
  const flag = head[6] | (head[7] << 8)
  return (flag & 0x0001) === 1
}

/**
 * Wraps a picked file, sniffing its header for encryption. `headBytes` lets
 * native callers pass the header they already read (RN Blobs don't reliably
 * support `.slice`).
 */
export async function describeArchive(
  blob: Blob,
  name: string,
  size: number,
  headBytes?: Uint8Array,
): Promise<PickedShogoArchive> {
  let encrypted = false
  try {
    const head =
      headBytes ?? new Uint8Array(await blob.slice(0, 8).arrayBuffer())
    encrypted = isEncryptedHeader(head)
  } catch {
    encrypted = false
  }
  return { blob, name, size, encrypted }
}

/**
 * Opens the browser's file input and resolves with the chosen file (or null
 * when the picker is cancelled). The `click()` happens synchronously inside
 * the promise executor — see the user-activation note above.
 */
function pickWebFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.shogo,.shogo-project,.zip'
    input.style.cssText =
      'position:fixed;left:-9999px;opacity:0;width:1px;height:1px;pointer-events:none'
    document.body.appendChild(input)

    let settled = false
    const settle = (file: File | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (input.parentNode) input.parentNode.removeChild(input)
      resolve(file)
    }

    const timer = setTimeout(() => settle(null), 120_000)
    input.onchange = (e: any) => {
      settle((e.target?.files?.[0] as File | undefined) ?? null)
    }
    input.click()
  })
}

async function pickNativeFile(): Promise<PickedShogoArchive | null> {
  const { getDocumentAsync } = await import('expo-document-picker')
  const result = await getDocumentAsync({
    type: ['application/zip', 'application/octet-stream'],
    copyToCacheDirectory: true,
    multiple: false,
  })
  if (result.canceled || !result.assets?.[0]) return null

  const asset = result.assets[0]
  const { readAsStringAsync, EncodingType } = await import(
    'expo-file-system/legacy'
  )
  const base64 = await readAsStringAsync(asset.uri, {
    encoding: EncodingType.Base64,
  })
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  const blob = new Blob([bytes], { type: 'application/zip' })
  return await describeArchive(
    blob,
    asset.name || 'project.shogo',
    asset.size || bytes.byteLength,
    bytes.slice(0, 8),
  )
}

export function usePickShogoArchive() {
  const [isPicking, setIsPicking] = useState(false)

  const pickArchive = useCallback(async (): Promise<PickedShogoArchive | null> => {
    setIsPicking(true)
    try {
      if (Platform.OS === 'web' && typeof document !== 'undefined') {
        const file = await pickWebFile()
        if (!file) return null
        return await describeArchive(file, file.name, file.size)
      }
      return await pickNativeFile()
    } catch (err: any) {
      // A cancelled native picker is a normal outcome, not an error.
      if (err?.code === 'ERR_CANCELED') return null
      throw err
    } finally {
      setIsPicking(false)
    }
  }, [])

  return { pickArchive, isPicking }
}
