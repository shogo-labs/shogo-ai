// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { Platform } from 'react-native'
import structuredClone from '@ungap/structured-clone'
import { NativeEventSource } from './lib/event-source-native'

if (Platform.OS !== 'web') {
  // Polyfill crypto.randomUUID for Hermes (used by domain-stores for temp IDs)
  if (typeof crypto === 'undefined' || !crypto.randomUUID) {
    const g = global as any
    if (!g.crypto) g.crypto = {}
    if (!g.crypto.randomUUID) {
      g.crypto.randomUUID = (): string => {
        const bytes = new Uint8Array(16)
        for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256)
        bytes[6] = (bytes[6] & 0x0f) | 0x40
        bytes[8] = (bytes[8] & 0x3f) | 0x80
        const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
      }
    }
  }

  // Always override EventSource on native: the built-in Hermes/Expo Go one
  // cannot send custom headers (we need the Better Auth cookie), and this one
  // streams through `fetch` so a long-lived connection holds only the unparsed
  // tail instead of the whole transcript (SHO-580).
  ;(global as any).EventSource = NativeEventSource

  const setupPolyfills = () => {
    // Metro converts native dynamic imports into async-require calls. In this
    // monorepo that turns the React Native internal into a store-relative
    // path which cannot be resolved after a clean bundle. A guarded require
    // preserves the native-only loading behavior without the broken rewrite.
    const { polyfillGlobal } = require(
      'react-native/Libraries/Utilities/PolyfillFunctions'
    )

    const { TextEncoderStream, TextDecoderStream } = require(
      '@stardazed/streams-text-encoding'
    )

    if (!('structuredClone' in global)) {
      polyfillGlobal('structuredClone', () => structuredClone)
    }

    polyfillGlobal('TextEncoderStream', () => TextEncoderStream)
    polyfillGlobal('TextDecoderStream', () => TextDecoderStream)
  }

  setupPolyfills()
}

export {}
