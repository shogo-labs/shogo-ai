import { describe, expect, test } from 'bun:test'
import { generateChatComponents } from '../chat-components-generator'

describe('generateChatComponents', () => {
  test('emits a safe ChatLauncher scaffold', () => {
    const files = generateChatComponents()
    expect(files.map((file) => file.fileName)).toEqual([
      'ChatLauncher.tsx',
      'ChatPage.tsx',
      'index.tsx',
    ])
    expect(files.every((file) => file.skipIfExists)).toBe(true)
    expect(files[0]?.code).toContain('@shogo-ai/chat/react')
    expect(files[0]?.code).toContain('publishableKey')
  })
})
