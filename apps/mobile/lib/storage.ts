// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The one place the app writes to AsyncStorage.
 *
 * A non-string value is not a JS-only mistake: `RNCAsyncStorage` hands it to
 * `_writeEntry`, which calls `-length` on whatever arrived. A `null`/`undefined`
 * crosses the bridge as `NSNull`, and `-[NSNull length]` is an
 * `NSInvalidArgumentException` — the app dies on a background dispatch queue,
 * where no JS `try`/`catch` can reach it (SHOGO-IOS-16, SHO-566). Every
 * implementation of the library that ships in the app is also inconsistent
 * about warning first: 2.x throws on `null`, 3.x's legacy path passes it
 * straight through.
 *
 * So the guard lives here, once: a value that is not a string removes the key
 * instead of being written, and nothing in the app calls `AsyncStorage.setItem`
 * or `multiSet` directly. Typed `string` in, string out — a caller that has
 * `undefined` to offer writes nothing, which is what "clear this preference"
 * means everywhere it happens.
 */
import AsyncStorage from '@react-native-async-storage/async-storage'

export function getStorageItem(key: string): Promise<string | null> {
  return AsyncStorage.getItem(key)
}

export async function removeStorageItem(key: string): Promise<void> {
  await AsyncStorage.removeItem(key)
}

/**
 * Store `value` for `key`. A value that is not a string (the `undefined` a
 * `JSON.stringify` of nothing, or of a value typed `string` that the API left
 * out) removes the key: the native side never sees it.
 */
export async function setStorageItem(key: string, value: string): Promise<void> {
  if (typeof value !== 'string') {
    // Not a warning about style: `RNCAsyncStorage` would call `-length` on
    // whatever crossed the bridge and abort the app. Name the key so the next
    // one of these is one line in the log instead of a crash report.
    console.warn(`[storage] refusing to write a non-string for "${key}"; removing it instead`)
    await removeStorageItem(key)
    return
  }
  await AsyncStorage.setItem(key, value)
}

/**
 * Store `value` as JSON. `JSON.stringify` returns `undefined` for `undefined`
 * and throws on a cycle or a `BigInt`; both mean "nothing to store", not "write
 * whatever came out".
 */
export async function setStorageJson(key: string, value: unknown): Promise<void> {
  let json: string | undefined
  try {
    json = JSON.stringify(value)
  } catch {
    json = undefined
  }
  if (typeof json !== 'string') {
    await removeStorageItem(key)
    return
  }
  await AsyncStorage.setItem(key, json)
}
