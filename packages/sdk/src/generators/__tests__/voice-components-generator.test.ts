// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for the voice-components generator.
 *
 * Run: bun test packages/sdk/src/generators/__tests__/voice-components-generator.test.ts
 */

import { describe, expect, test } from 'bun:test'

import { generateVoiceComponents } from '../voice-components-generator'

describe('generateVoiceComponents', () => {
  test('emits VoiceButton, VoiceSphere, PhoneButton + index.ts', () => {
    const files = generateVoiceComponents()
    const names = files.map((f) => f.fileName)
    expect(names).toEqual([
      'VoiceButton.tsx',
      'VoiceSphere.tsx',
      'PhoneButton.tsx',
      'index.ts',
    ])
  })

  test('all component files are skipIfExists to preserve user edits', () => {
    const files = generateVoiceComponents()
    for (const f of files) {
      expect(f.skipIfExists).toBe(true)
    }
  })

  test('VoiceButton uses useShogoVoice and default SDK import', () => {
    const [vb] = generateVoiceComponents()
    expect(vb!.code).toContain("import { useShogoVoice } from '@shogo-ai/sdk/voice/react'")
    expect(vb!.code).toContain('useShogoVoice()')
    expect(vb!.code).toContain('export function VoiceButton')
  })

  test('VoiceSphere drives animation off isSpeaking from useShogoVoice', () => {
    const [, vs] = generateVoiceComponents()
    expect(vs!.code).toContain('useShogoVoice()')
    expect(vs!.code).toContain('isSpeaking')
  })

  test('PhoneButton imports generated shogo client, NOT createClient', () => {
    const [, , pb] = generateVoiceComponents()
    expect(pb!.code).toContain("import { shogo, PROJECT_ID } from '../../lib/shogo'")
    expect(pb!.code).not.toContain('createClient')
    expect(pb!.code).toContain('shogo.voice.telephony')
  })

  test('custom sdkReactImport is honored', () => {
    const files = generateVoiceComponents({ sdkReactImport: '~/local/voice-react' })
    expect(files[0]!.code).toContain("import { useShogoVoice } from '~/local/voice-react'")
  })

  test('no hardcoded API keys and no runtime env reads', () => {
    // Docblocks + user-facing error messages may MENTION the env var
    // names (e.g. "ensure RUNTIME_AUTH_SECRET is set"); the real
    // assertion is that the components never READ them at runtime.
    const files = generateVoiceComponents()
    for (const f of files) {
      expect(f.code).not.toMatch(/shogo_sk_/)
      expect(f.code).not.toMatch(/process\.env\.ELEVENLABS_API_KEY/)
      expect(f.code).not.toMatch(/process\.env\.RUNTIME_AUTH_SECRET/)
      expect(f.code).not.toMatch(/process\.env\.SHOGO_API_KEY/)
    }
  })

  test('index.ts re-exports all three components', () => {
    const idx = generateVoiceComponents().find((f) => f.fileName === 'index.ts')
    expect(idx).toBeDefined()
    expect(idx!.code).toContain("export { VoiceButton")
    expect(idx!.code).toContain("export { VoiceSphere")
    expect(idx!.code).toContain("export { PhoneButton")
  })

  test('index.ts re-exports ShogoVoiceProvider from the SDK', () => {
    // Generated pods need a `<ConversationProvider>` ancestor for
    // `useShogoVoice` to work — we surface it as `ShogoVoiceProvider`
    // so consumers don't import from `@elevenlabs/react` directly.
    const idx = generateVoiceComponents().find((f) => f.fileName === 'index.ts')
    expect(idx).toBeDefined()
    expect(idx!.code).toContain(
      "export { ShogoVoiceProvider, type ShogoVoiceProviderProps } from '@shogo-ai/sdk/voice/react'",
    )
  })

  test('index.ts re-exports ShogoVoiceProvider from custom sdkReactImport', () => {
    const files = generateVoiceComponents({ sdkReactImport: '~/local/voice-react' })
    const idx = files.find((f) => f.fileName === 'index.ts')
    expect(idx).toBeDefined()
    expect(idx!.code).toContain(
      "export { ShogoVoiceProvider, type ShogoVoiceProviderProps } from '~/local/voice-react'",
    )
  })

  test('index.ts shows ShogoVoiceProvider setup in its docblock', () => {
    const idx = generateVoiceComponents().find((f) => f.fileName === 'index.ts')
    expect(idx).toBeDefined()
    // The docblock walks consumers through the one-time root wrap so a
    // generated pod's `VoiceButton` doesn't immediately throw the
    // "useRegisterCallbacks must be used within a ConversationProvider"
    // error after a fresh `shogo generate`.
    expect(idx!.code).toContain('ShogoVoiceProvider')
    expect(idx!.code).toContain('<ShogoVoiceProvider>')
  })
})
