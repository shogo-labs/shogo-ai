// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * ChatPanel queued-message behavior tests.
 *
 * Pins the algorithmic behavior of the inline queue helpers in ChatPanel /
 * ChatInput so regressions surface here rather than via UI smoke tests:
 *   - per-session queue cache survives session switches (and remounts)
 *   - remove / reorder produce the expected queue
 *   - editing pulls the original entry out and yields a draft request that
 *     restores both content and attachments
 *   - row display picks the right primary text and combined attachment label
 *
 * Run: bun test apps/mobile/lib/__tests__/chat-queue-behavior.test.ts
 */

import { describe, test, expect, beforeEach } from 'bun:test'

interface FileAttachment {
  dataUrl: string
  name: string
  type: string
}

interface QueuedMessage {
  id: string
  content: string
  files?: FileAttachment[]
  selectedModel?: string
}

// -- Per-session cache (mirrors `sessionQueueCache` in ChatPanel.tsx) --

function makeCache() {
  return new Map<string, QueuedMessage[]>()
}

function syncCache(
  cache: Map<string, QueuedMessage[]>,
  sessionId: string | null,
  queue: QueuedMessage[]
): void {
  if (!sessionId) return
  if (queue.length === 0) {
    cache.delete(sessionId)
  } else {
    cache.set(sessionId, queue)
  }
}

function hydrateFromCache(
  cache: Map<string, QueuedMessage[]>,
  sessionId: string | null
): QueuedMessage[] {
  if (!sessionId) return []
  return cache.get(sessionId) ?? []
}

// -- Pure mutation helpers (mirror handlers in ChatPanel.tsx) --

function removeQueued(queue: QueuedMessage[], id: string): QueuedMessage[] {
  return queue.filter((m) => m.id !== id)
}

function reorderQueued(
  queue: QueuedMessage[],
  id: string,
  direction: 'up' | 'down'
): QueuedMessage[] {
  const index = queue.findIndex((m) => m.id === id)
  if (index === -1) return queue
  const next = [...queue]
  if (direction === 'up' && index > 0) {
    ;[next[index - 1], next[index]] = [next[index], next[index - 1]]
  } else if (direction === 'down' && index < next.length - 1) {
    ;[next[index], next[index + 1]] = [next[index + 1], next[index]]
  }
  return next
}

interface DraftRequest {
  nonce: number
  content: string
  files?: FileAttachment[]
}

function editQueued(
  queue: QueuedMessage[],
  id: string,
  now: number
): { queue: QueuedMessage[]; draft: DraftRequest | null } {
  const target = queue.find((m) => m.id === id)
  if (!target) return { queue, draft: null }
  return {
    queue: queue.filter((m) => m.id !== id),
    draft: { nonce: now, content: target.content, files: target.files },
  }
}

// -- Display helpers (mirror queue row in ChatInput.tsx) --

interface QueueRowDisplay {
  primaryText: string
  attachmentLabel: string | null
  previewImageDataUrl: string | null
  imageCount: number
  fileCount: number
}

function deriveQueueRowDisplay(msg: QueuedMessage): QueueRowDisplay {
  const files = msg.files ?? []
  const imageFiles = files.filter((f) => f.type?.startsWith('image/'))
  const otherFiles = files.filter((f) => !f.type?.startsWith('image/'))
  const trimmedContent = msg.content?.trim() ?? ''
  const totalAttachmentLabel =
    files.length > 0
      ? `${files.length} ${files.length === 1 ? 'attachment' : 'attachments'}`
      : ''
  const primaryText = trimmedContent
    ? trimmedContent
    : totalAttachmentLabel || 'Empty message'

  let attachmentLabel: string | null = null
  if (trimmedContent && files.length > 0) {
    if (imageFiles.length > 0 && otherFiles.length > 0) {
      attachmentLabel = `${imageFiles.length} image${imageFiles.length === 1 ? '' : 's'} + ${otherFiles.length} file${otherFiles.length === 1 ? '' : 's'}`
    } else if (imageFiles.length > 0) {
      attachmentLabel = `${imageFiles.length} image${imageFiles.length === 1 ? '' : 's'}`
    } else {
      attachmentLabel = `${otherFiles.length} file${otherFiles.length === 1 ? '' : 's'}`
    }
  }

  return {
    primaryText,
    attachmentLabel,
    previewImageDataUrl: imageFiles[0]?.dataUrl ?? null,
    imageCount: imageFiles.length,
    fileCount: otherFiles.length,
  }
}

// ---------------------------------------------------------------------------

describe('per-session queue cache', () => {
  let cache: Map<string, QueuedMessage[]>

  beforeEach(() => {
    cache = makeCache()
  })

  test('hydrate returns [] for an unknown session', () => {
    expect(hydrateFromCache(cache, 'session-a')).toEqual([])
  })

  test('hydrate returns [] when sessionId is null', () => {
    expect(hydrateFromCache(cache, null)).toEqual([])
  })

  test('sync stores a non-empty queue and hydrate returns it', () => {
    const queue: QueuedMessage[] = [
      { id: 'q1', content: 'hello' },
      { id: 'q2', content: 'world' },
    ]
    syncCache(cache, 'session-a', queue)
    expect(hydrateFromCache(cache, 'session-a')).toEqual(queue)
  })

  test('queue persists across a "remount" (read after write to same key)', () => {
    syncCache(cache, 'session-a', [{ id: 'q1', content: 'hi' }])
    // Simulate component remount: ignore prior in-memory state, hydrate again.
    const restored = hydrateFromCache(cache, 'session-a')
    expect(restored).toEqual([{ id: 'q1', content: 'hi' }])
  })

  test('switching sessions hydrates the other session, not a wipe', () => {
    syncCache(cache, 'session-a', [{ id: 'q1', content: 'a-msg' }])
    syncCache(cache, 'session-b', [{ id: 'q2', content: 'b-msg' }])

    expect(hydrateFromCache(cache, 'session-b')).toEqual([
      { id: 'q2', content: 'b-msg' },
    ])
    // session-a is untouched
    expect(hydrateFromCache(cache, 'session-a')).toEqual([
      { id: 'q1', content: 'a-msg' },
    ])
  })

  test('emptying the queue clears the cache entry', () => {
    syncCache(cache, 'session-a', [{ id: 'q1', content: 'hi' }])
    expect(cache.has('session-a')).toBe(true)
    syncCache(cache, 'session-a', [])
    expect(cache.has('session-a')).toBe(false)
  })

  test('null sessionId is a no-op for sync', () => {
    syncCache(cache, null, [{ id: 'q1', content: 'hi' }])
    expect(cache.size).toBe(0)
  })
})

describe('queue mutations', () => {
  const base: QueuedMessage[] = [
    { id: 'q1', content: 'first' },
    { id: 'q2', content: 'second' },
    { id: 'q3', content: 'third' },
  ]

  test('removeQueued removes the matching entry', () => {
    expect(removeQueued(base, 'q2')).toEqual([
      { id: 'q1', content: 'first' },
      { id: 'q3', content: 'third' },
    ])
  })

  test('removeQueued is a no-op for unknown ids', () => {
    expect(removeQueued(base, 'missing')).toEqual(base)
  })

  test('reorderQueued up swaps with the previous item', () => {
    expect(reorderQueued(base, 'q2', 'up').map((m) => m.id)).toEqual([
      'q2',
      'q1',
      'q3',
    ])
  })

  test('reorderQueued up on the first item is a no-op', () => {
    expect(reorderQueued(base, 'q1', 'up')).toEqual(base)
  })

  test('reorderQueued down swaps with the next item', () => {
    expect(reorderQueued(base, 'q2', 'down').map((m) => m.id)).toEqual([
      'q1',
      'q3',
      'q2',
    ])
  })

  test('reorderQueued down on the last item is a no-op', () => {
    expect(reorderQueued(base, 'q3', 'down')).toEqual(base)
  })

  test('reorderQueued unknown id returns the original queue', () => {
    expect(reorderQueued(base, 'missing', 'up')).toEqual(base)
  })
})

describe('editQueued', () => {
  test('removes the entry and yields a draft request with content + files', () => {
    const file: FileAttachment = {
      dataUrl: 'data:image/png;base64,AAA',
      name: 'screenshot.png',
      type: 'image/png',
    }
    const queue: QueuedMessage[] = [
      { id: 'q1', content: 'keep' },
      { id: 'q2', content: 'edit me', files: [file] },
    ]

    const { queue: nextQueue, draft } = editQueued(queue, 'q2', 1234)

    expect(nextQueue).toEqual([{ id: 'q1', content: 'keep' }])
    expect(draft).toEqual({ nonce: 1234, content: 'edit me', files: [file] })
  })

  test('returns a null draft when the id is unknown', () => {
    const queue: QueuedMessage[] = [{ id: 'q1', content: 'a' }]
    const result = editQueued(queue, 'missing', 1)
    expect(result.queue).toEqual(queue)
    expect(result.draft).toBeNull()
  })

  test('preserves attachment-only entries on edit', () => {
    const file: FileAttachment = {
      dataUrl: 'data:image/png;base64,ZZZ',
      name: 'pic.png',
      type: 'image/png',
    }
    const queue: QueuedMessage[] = [
      { id: 'q1', content: '', files: [file] },
    ]
    const { queue: nextQueue, draft } = editQueued(queue, 'q1', 99)
    expect(nextQueue).toEqual([])
    expect(draft).toEqual({ nonce: 99, content: '', files: [file] })
  })
})

describe('deriveQueueRowDisplay', () => {
  test('text-only message renders the trimmed text and no attachment label', () => {
    const display = deriveQueueRowDisplay({
      id: 'q1',
      content: '   hello world   ',
    })
    expect(display.primaryText).toBe('hello world')
    expect(display.attachmentLabel).toBeNull()
    expect(display.previewImageDataUrl).toBeNull()
  })

  test('attachment-only message renders an attachment-count primary text', () => {
    const display = deriveQueueRowDisplay({
      id: 'q1',
      content: '',
      files: [
        { dataUrl: 'data:image/png;base64,A', name: 'a.png', type: 'image/png' },
      ],
    })
    expect(display.primaryText).toBe('1 attachment')
    expect(display.attachmentLabel).toBeNull()
    expect(display.previewImageDataUrl).toBe('data:image/png;base64,A')
  })

  test('text + image message keeps text as primary and shows image label', () => {
    const display = deriveQueueRowDisplay({
      id: 'q1',
      content: 'check this out',
      files: [
        {
          dataUrl: 'data:image/png;base64,IMG',
          name: 'a.png',
          type: 'image/png',
        },
      ],
    })
    expect(display.primaryText).toBe('check this out')
    expect(display.attachmentLabel).toBe('1 image')
    expect(display.previewImageDataUrl).toBe('data:image/png;base64,IMG')
    expect(display.imageCount).toBe(1)
    expect(display.fileCount).toBe(0)
  })

  test('text + multiple images uses pluralized image label', () => {
    const display = deriveQueueRowDisplay({
      id: 'q1',
      content: 'multi',
      files: [
        { dataUrl: 'd1', name: 'a.png', type: 'image/png' },
        { dataUrl: 'd2', name: 'b.png', type: 'image/png' },
      ],
    })
    expect(display.attachmentLabel).toBe('2 images')
    expect(display.imageCount).toBe(2)
  })

  test('text + image + non-image combines both counts', () => {
    const display = deriveQueueRowDisplay({
      id: 'q1',
      content: 'mixed',
      files: [
        { dataUrl: 'd1', name: 'a.png', type: 'image/png' },
        { dataUrl: 'd2', name: 'b.pdf', type: 'application/pdf' },
        { dataUrl: 'd3', name: 'c.pdf', type: 'application/pdf' },
      ],
    })
    expect(display.attachmentLabel).toBe('1 image + 2 files')
    expect(display.previewImageDataUrl).toBe('d1')
  })

  test('text + non-image-only uses file label', () => {
    const display = deriveQueueRowDisplay({
      id: 'q1',
      content: 'docs',
      files: [
        { dataUrl: 'd1', name: 'a.pdf', type: 'application/pdf' },
      ],
    })
    expect(display.attachmentLabel).toBe('1 file')
    expect(display.previewImageDataUrl).toBeNull()
  })

  test('empty content + no files falls back to "Empty message"', () => {
    const display = deriveQueueRowDisplay({ id: 'q1', content: '' })
    expect(display.primaryText).toBe('Empty message')
    expect(display.attachmentLabel).toBeNull()
    expect(display.previewImageDataUrl).toBeNull()
  })
})
