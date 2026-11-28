// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Whether this device has ever been signed in.
 *
 * Instagram/Facebook ad traffic lands on `/sign-up`, and forwarding that to the
 * one auth screen used to drop the visitor on "Welcome back / Log in" — a
 * returning-user greeting to someone who has never had an account here
 * (SHO-613). The screen now picks its tab from this flag: a device with no
 * session history opens **Sign Up**, a device that has been signed in before
 * opens **Sign In**.
 *
 * It is a device fact, not an account fact: it survives sign-out on purpose,
 * because the person who just signed out is exactly the person who needs the
 * Sign In tab next. Deliberately not keyed per environment — "this device has
 * signed in at some point" stays true whichever API it signed in to.
 */
import { readSyncValue, writeSyncValue } from './sync-kv'

const STORAGE_KEY = 'auth-had-session-v1'

/** Record that this device now has (or has had) a session. */
export function markHadSession(): void {
  if (readSyncValue('local', STORAGE_KEY) === '1') return
  writeSyncValue('local', STORAGE_KEY, '1')
}

/** True once the device has ever carried a session. */
export function hasHadSession(): boolean {
  return readSyncValue('local', STORAGE_KEY) === '1'
}
