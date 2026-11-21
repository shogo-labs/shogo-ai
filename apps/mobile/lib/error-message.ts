// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A readable message for anything a promise rejected or a `catch` caught.
 *
 * Native modules reject with no value at all (react-native-callkeep's
 * `setup()` on Android when the person declines the phone-account prompt), and
 * `(err as Error).message` on `undefined` throws inside the `.catch` that was
 * meant to swallow it — an unhandled rejection reported as "Cannot read
 * property 'message' of undefined" at launch (Sentry SHOGO-ANDROID-11).
 */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name || 'Error'
  if (typeof err === 'string') return err
  if (err && typeof err === 'object' && typeof (err as { message?: unknown }).message === 'string') {
    return (err as { message: string }).message
  }
  if (err === undefined || err === null) return 'no error details'
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}
