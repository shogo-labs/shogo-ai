import { describe, test, expect, beforeEach } from 'bun:test'
import { BlockChunker } from '../block-chunker'

describe('BlockChunker', () => {
  test('flushes when buffer exceeds maxChars', () => {
    const chunks: string[] = []
    const chunker = new BlockChunker((c) => chunks.push(c), { minChars: 10, maxChars: 20, idleMs: 10000 })

    chunker.push('a'.repeat(25))
    expect(chunks.length).toBe(1)
    expect(chunks[0]).toBe('a'.repeat(25))
    chunker.dispose()
  })

  test('flushes at paragraph boundary when above minChars', () => {
    const chunks: string[] = []
    const chunker = new BlockChunker((c) => chunks.push(c), { minChars: 10, maxChars: 2000, idleMs: 10000 })

    chunker.push('Hello world.\n\nSecond paragraph.')
    expect(chunks.length).toBe(1)
    expect(chunks[0]).toBe('Hello world.')
    chunker.dispose()
  })

  test('does not split inside code fences', () => {
    const chunks: string[] = []
    const chunker = new BlockChunker((c) => chunks.push(c), { minChars: 10, maxChars: 2000, idleMs: 10000 })

    chunker.push('```python\nprint("hello")\n\nprint("world")\n```')
    // Should not flush mid-code-fence even though there's a double newline
    expect(chunks.length).toBe(0)
    chunker.flush()
    expect(chunks.length).toBe(1)
    expect(chunks[0]).toContain('```python')
    chunker.dispose()
  })

  test('flush() emits remaining buffer', () => {
    const chunks: string[] = []
    const chunker = new BlockChunker((c) => chunks.push(c), { minChars: 1000, maxChars: 5000, idleMs: 10000 })

    chunker.push('Short text.')
    expect(chunks.length).toBe(0)

    chunker.flush()
    expect(chunks.length).toBe(1)
    expect(chunks[0]).toBe('Short text.')
    chunker.dispose()
  })

  test('does not emit empty chunks', () => {
    const chunks: string[] = []
    const chunker = new BlockChunker((c) => chunks.push(c), { minChars: 10, maxChars: 2000, idleMs: 10000 })

    chunker.flush()
    expect(chunks.length).toBe(0)

    chunker.push('   ')
    chunker.flush()
    expect(chunks.length).toBe(0)
    chunker.dispose()
  })

  test('hasFlushed tracks whether any output was emitted', () => {
    const chunker = new BlockChunker(() => {}, { minChars: 10, maxChars: 2000, idleMs: 10000 })

    expect(chunker.hasFlushed).toBe(false)

    chunker.push('a'.repeat(30) + '\n\nmore')
    expect(chunker.hasFlushed).toBe(true)
    chunker.dispose()
  })

  test('idle timer flushes buffered text', async () => {
    const chunks: string[] = []
    const chunker = new BlockChunker((c) => chunks.push(c), { minChars: 1000, maxChars: 5000, idleMs: 50 })

    chunker.push('Buffered text.')
    expect(chunks.length).toBe(0)

    await new Promise((r) => setTimeout(r, 100))
    expect(chunks.length).toBe(1)
    expect(chunks[0]).toBe('Buffered text.')
    chunker.dispose()
  })

  test('accumulates multiple small deltas', () => {
    const chunks: string[] = []
    const chunker = new BlockChunker((c) => chunks.push(c), { minChars: 20, maxChars: 2000, idleMs: 10000 })

    chunker.push('Hello ')
    chunker.push('world ')
    chunker.push('this is a test.')
    // Still below minChars, no paragraph break
    expect(chunks.length).toBe(0)

    chunker.flush()
    expect(chunks.length).toBe(1)
    expect(chunks[0]).toBe('Hello world this is a test.')
    chunker.dispose()
  })
})
