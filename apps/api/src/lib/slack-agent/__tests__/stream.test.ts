import { describe, expect, test } from 'bun:test'
import { SlackStreamWriter, type SlackApiClient } from '../stream'

describe('SlackStreamWriter', () => {
  test('streams text and maps tool lifecycle to task updates', async () => {
    const calls: Array<{ method: string; body: Record<string, unknown> }> = []
    const client: SlackApiClient = {
      async call(method, body) {
        calls.push({ method, body })
        if (method === 'chat.startStream') return { ok: true, ts: '1710000000.1' }
        return { ok: true }
      },
    }
    const writer = new SlackStreamWriter({
      client,
      channelId: 'D123',
      threadTs: '1710000000.0',
      now: () => 1000,
    })

    await writer.write({ type: 'text-delta', delta: 'Planning this change.' })
    await writer.write({ type: 'tool-input-start', toolCallId: 'tool-1', toolName: 'read_file' })
    await writer.write({ type: 'tool-output-available', toolCallId: 'tool-1', output: { ok: true } })
    await writer.stop('Done.')

    expect(calls.map((call) => call.method)).toEqual([
      'chat.startStream',
      'chat.appendStream',
      'chat.appendStream', // tool-input-start task_update
      'assistant.threads.setStatus', // "is using Read File…" shimmer
      'chat.appendStream', // tool-output-available task_update
      'chat.stopStream',
      'assistant.threads.setStatus', // cleared on stop
    ])
    expect(calls[1].body.chunks).toEqual([{
      type: 'markdown_text',
      text: 'Planning this change.',
    }])
    expect(calls[3]).toEqual({
      method: 'assistant.threads.setStatus',
      body: { channel_id: 'D123', thread_ts: '1710000000.0', status: 'is using Read File…' },
    })
    expect(calls[4].body.chunks).toEqual([{
      type: 'task_update',
      id: 'tool-1',
      title: 'Read File',
      status: 'complete',
    }])
    expect(calls[5].body.chunks).toEqual([{ type: 'markdown_text', text: 'Done.' }])
    expect(calls[5].body.blocks).toBeArray()
    expect(calls[6]).toEqual({
      method: 'assistant.threads.setStatus',
      body: { channel_id: 'D123', thread_ts: '1710000000.0', status: '' },
    })
  })

  test('finishes when the runtime emits a turn-complete event', async () => {
    const methods: string[] = []
    const client: SlackApiClient = {
      async call(method) {
        methods.push(method)
        if (method === 'chat.startStream') return { ok: true, ts: 'stream-1' }
        return { ok: true }
      },
    }
    const writer = new SlackStreamWriter({ client, channelId: 'C123', threadTs: '1' })
    await writer.write({ type: 'data-turn-complete', data: { status: 'completed' } })
    await writer.stop()
    expect(methods.filter((method) => method === 'chat.stopStream')).toHaveLength(1)
  })

  test('does not append filler text on a normal stop() with no leftover text', async () => {
    const calls: Array<{ method: string; body: Record<string, unknown> }> = []
    const client: SlackApiClient = {
      async call(method, body) {
        calls.push({ method, body })
        if (method === 'chat.startStream') return { ok: true, ts: 'stream-1' }
        return { ok: true }
      },
    }
    const writer = new SlackStreamWriter({ client, channelId: 'C123', threadTs: '1', now: () => 1000 })

    // Text is flushed eagerly (now() - lastFlushAt >= 750), so by the time
    // stop() runs (with no finalText, as the real dispatch path calls it)
    // `this.text` is already empty — stop() must not invent filler text.
    await writer.write({ type: 'text-delta', delta: 'The COUNTER project is built and running.' })
    await writer.stop()

    const stopCall = calls.find((call) => call.method === 'chat.stopStream')
    expect(stopCall).toBeDefined()
    expect(stopCall!.body.chunks).toBeUndefined()
  })

  test('separates text segments split by a tool call with a paragraph break', async () => {
    const calls: Array<{ method: string; body: Record<string, unknown> }> = []
    const client: SlackApiClient = {
      async call(method, body) {
        calls.push({ method, body })
        if (method === 'chat.startStream') return { ok: true, ts: 'stream-1' }
        return { ok: true }
      },
    }
    const writer = new SlackStreamWriter({ client, channelId: 'C123', threadTs: '1', now: () => 1000 })

    await writer.write({ type: 'text-start', id: 'seg-1' })
    await writer.write({ type: 'text-delta', id: 'seg-1', delta: 'Let me mount the COUNTER project now.' })
    await writer.write({ type: 'text-end', id: 'seg-1' })
    await writer.write({ type: 'tool-input-start', toolCallId: 'tool-1', toolName: 'mount_project', input: { projectId: 'COUNTER' } })
    await writer.write({ type: 'tool-output-available', toolCallId: 'tool-1', output: { ok: true } })
    await writer.write({ type: 'text-start', id: 'seg-2' })
    await writer.write({ type: 'text-delta', id: 'seg-2', delta: 'Mounted!' })
    await writer.stop()

    const appendCalls = calls.filter((call) => call.method === 'chat.appendStream')
    const combinedText = appendCalls
      .flatMap((call) => call.body.chunks as any[])
      .filter((chunk) => chunk.type === 'markdown_text')
      .map((chunk) => chunk.text)
      .join('')
    expect(combinedText).toBe('Let me mount the COUNTER project now.\n\nMounted!')
  })
})
