// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Reopening a chat whose turn is still running must show that whole turn, not
 * only its latest action (the 2.4.1 regression).
 *
 * Nothing here is a hand-written fixture of the wire format. The frames come
 * from the runtime's own turn writer (`createBufferedTurns`) into the real
 * `StreamBufferStore`, the replay is built by the real `buildSnapshotReplay`,
 * and the client side is the app's real `withResumeReplayReset` transport, the
 * AI SDK's real `AbstractChat.resumeStream()`, and the panel's
 * `applyMessageSnapshot` + `foldSnapshotContinuation`. The earlier unit tests
 * passed because their fixtures opened with a `{ type: 'start', messageId }`
 * chunk the runtime never writes, so the snapshot always had an id there and
 * never did in production.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import {
  AbstractChat,
  parseJsonEventStream,
  uiMessageChunkSchema,
  type ChatState,
  type ChatStatus,
  type ChatTransport,
  type UIMessage,
  type UIMessageChunk,
} from 'ai'
import { StreamBufferStore } from '@shogo/shared-runtime'
import { LiveTurnGate } from '../live-turn-wait'
import { createBufferedTurns, type UiStreamWriter } from '../buffered-turn'
import { buildSnapshotReplay } from '../stream-snapshot'

/** The app's resume transport and transcript fold (apps/mobile/components/chat/resume-replay-transport.ts). */
interface ResumeClient {
  withResumeReplayReset: (
    transport: ChatTransport<UIMessage>,
    beforeReplay: () => void,
    onSnapshot?: (message: UIMessage) => void,
  ) => ChatTransport<UIMessage>
  applyMessageSnapshot: (messages: UIMessage[], snapshot: UIMessage) => UIMessage[]
  foldSnapshotContinuation: (messages: UIMessage[], snapshotId: string | null) => UIMessage[]
}
// Loaded by a non-literal path so this package's `tsc` (rootDir: src) does not
// pull the app's source into its program; bun resolves it at run time. The app
// module only imports types from `ai` and two sibling files.
const clientModule = '../../../../apps/mobile/components/chat/resume-replay-transport'
const { withResumeReplayReset, applyMessageSnapshot, foldSnapshotContinuation } =
  (await import(clientModule)) as ResumeClient

class ArrayChatState implements ChatState<UIMessage> {
  status: ChatStatus = 'ready'
  error: Error | undefined = undefined
  constructor(public messages: UIMessage[]) {}
  pushMessage = (message: UIMessage) => {
    this.messages = [...this.messages, message]
  }
  popMessage = () => {
    this.messages = this.messages.slice(0, -1)
  }
  replaceMessage = (index: number, message: UIMessage) => {
    this.messages = [...this.messages.slice(0, index), message, ...this.messages.slice(index + 1)]
  }
  snapshot = <T,>(thing: T): T => structuredClone(thing)
}

class TestChat extends AbstractChat<UIMessage> {
  constructor(transport: ChatTransport<UIMessage>, messages: UIMessage[]) {
    super({ id: 'chat-1', transport, state: new ArrayChatState(messages) })
  }
}

function toChunks(bytes: ReadableStream<Uint8Array>): ReadableStream<UIMessageChunk> {
  return parseJsonEventStream({ stream: bytes, schema: uiMessageChunkSchema }).pipeThrough(
    new TransformStream({
      transform(result, controller) {
        if (result.success) controller.enqueue(result.value as UIMessageChunk)
      },
    }),
  )
}

/** The saved history the panel paints before it attaches to the live turn. */
const history = (): UIMessage[] => [
  { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'first question' }] },
  { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'first answer' }] },
  { id: 'u2', role: 'user', parts: [{ type: 'text', text: 'now do the long job' }] },
]

/** Work the turn finished before anyone reopened the chat. */
function writeFinishedWork(writer: UiStreamWriter) {
  writer.write({ type: 'reasoning-start', id: 'r0' })
  writer.write({ type: 'reasoning-delta', id: 'r0', delta: 'planning the long job' })
  writer.write({ type: 'reasoning-end', id: 'r0' })
  writer.write({ type: 'tool-input-start', toolCallId: 'c1', toolName: 'exec', dynamic: true })
  writer.write({ type: 'tool-input-available', toolCallId: 'c1', toolName: 'exec', input: { command: 'ls' }, dynamic: true })
  writer.write({ type: 'tool-output-available', toolCallId: 'c1', output: { stdout: 'a b c' }, dynamic: true })
  writer.write({ type: 'text-start', id: 't0' })
  writer.write({ type: 'text-delta', id: 't0', delta: 'Step one is done.' })
  writer.write({ type: 'text-end', id: 't0' })
  // The action that is still running when the chat is reopened.
  writer.write({ type: 'tool-input-start', toolCallId: 'c2', toolName: 'wait', dynamic: true })
  writer.write({ type: 'tool-input-available', toolCallId: 'c2', toolName: 'wait', input: { seconds: 60 }, dynamic: true })
}

let store: StreamBufferStore | undefined
afterEach(() => store?.dispose())

describe('reopening a chat mid-turn (snapshot resume)', () => {
  test('shows the whole running turn under its prompt, not only its latest action', async () => {
    store = new StreamBufferStore()
    const turns = createBufferedTurns({ store, gate: new LiveTurnGate(store, 5) })

    let finish!: () => void
    const released = new Promise<void>((resolve) => { finish = resolve })
    let wroteWork!: () => void
    const workWritten = new Promise<void>((resolve) => { wroteWork = resolve })

    const turn = turns.start('chat-1', async (writer) => {
      writeFinishedWork(writer)
      wroteWork()
      await released
      writer.write({ type: 'tool-output-available', toolCallId: 'c2', output: { ok: true }, dynamic: true })
      writer.write({ type: 'text-start', id: 't1' })
      writer.write({ type: 'text-delta', id: 't1', delta: 'All done.' })
      writer.write({ type: 'text-end', id: 't1' })
    })
    await workWritten
    await new Promise((r) => setTimeout(r, 20))

    // The app's resume transport, over the runtime's `/stream?snapshot=1` replay.
    let snapshotId: string | null = null
    const chatRef: { current?: TestChat } = {}
    const transport = withResumeReplayReset(
      {
        sendMessages: async () => {
          throw new Error('not used')
        },
        reconnectToStream: async () =>
          toChunks(store!.createReplayStream('chat-1', { fromSeq: 0, buildReplay: buildSnapshotReplay })!),
      },
      () => {},
      (message) => {
        // What ChatPanel's applyResumeSnapshotRef does.
        snapshotId = message.id
        chatRef.current!.messages = applyMessageSnapshot(chatRef.current!.messages, message)
      },
    )
    const chat = new TestChat(transport, history())
    chatRef.current = chat

    const resumed = chat.resumeStream()
    await new Promise((r) => setTimeout(r, 50))
    finish()
    await turn.done
    await resumed

    expect(snapshotId).toBeTruthy()

    // What the transcript renders (ChatPanel's displayMessages).
    const shown = foldSnapshotContinuation(chat.messages, snapshotId)
    expect(shown.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(shown.slice(0, 3).map((m) => m.id)).toEqual(['u1', 'a1', 'u2'])

    const live = shown[3]!
    const parts = live.parts as Array<Record<string, any>>
    // The finished work from before the reopen…
    expect(parts.some((p) => p.type === 'reasoning' && p.text.includes('planning the long job'))).toBe(true)
    expect(parts.some((p) => p.type === 'dynamic-tool' && p.toolCallId === 'c1' && p.state === 'output-available')).toBe(true)
    expect(parts.some((p) => p.type === 'text' && p.text === 'Step one is done.')).toBe(true)
    // …and what happened after it.
    expect(parts.some((p) => p.type === 'dynamic-tool' && p.toolCallId === 'c2' && p.state === 'output-available')).toBe(true)
    expect(parts.some((p) => p.type === 'text' && p.text === 'All done.')).toBe(true)
  })

  test("the runtime's snapshot is named after the turn, so a second reopen replaces it", async () => {
    store = new StreamBufferStore()
    const turns = createBufferedTurns({ store, gate: new LiveTurnGate(store, 5) })
    let finish!: () => void
    const released = new Promise<void>((resolve) => { finish = resolve })
    const turn = turns.start('chat-2', async (writer) => {
      writeFinishedWork(writer)
      await released
    })
    await new Promise((r) => setTimeout(r, 20))

    const read = async () => {
      const reader = toChunks(store!.createReplayStream('chat-2', { fromSeq: 0, buildReplay: buildSnapshotReplay })!).getReader()
      const { value } = await reader.read()
      await reader.cancel()
      return (value as any).data.message as UIMessage
    }
    const first = await read()
    const second = await read()
    expect(first.id).toBe(`turn-${turn.turnId}`)
    expect(second.id).toBe(first.id)
    finish()
    await turn.done
  })
})
