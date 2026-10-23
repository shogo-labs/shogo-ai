// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/** HKDF purpose label for the guest home-state key. Bump with the version. */
export const HOME_STATE_KEY_PURPOSE = 'home-state:v1'
/** Must match the key version the guest stamps into each archive header. */
export const HOME_STATE_KEY_VERSION = '1'
