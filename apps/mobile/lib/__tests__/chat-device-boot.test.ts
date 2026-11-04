// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Opening a chat from the device (SHO-309).
 *
 * The two loaders Russell saw on every open came from one place each: the
 * workspace screen threw away the session and profile it had just resolved
 * (`Preparing Workspace Agent Chat…`), and the panel started empty on a chat
 * whose transcript was already on the device (`Loading conversation...`). These
 * hold the boot record and the paint decisions that replace them.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  chatHistoryKey,
  clearChatHistory,
  peekChatBoot,
  readChatBoot,
  removeChatBoot,
  setChatHistoryBackend,
  writeChatBoot,
  writeChatHistory,
} from '../chat-history-store'
import {
  bootWaitCanEndWithoutRecord,
  chatHistoryOrigin,
  loadWorkspaceChatBoot,
  peekWorkspaceChatBoot,
  rememberWorkspaceChatBoot,
  seedTranscript,
  transcriptLoaderVisible,
  workspaceChatBootKey,
  workspaceChatLoadingView,
} from '../chat-device-boot'
import {
  clearChatPanelMessageCache,
  writeSessionMessageCache,
} from '../chat-panel-message-cache'

const profile = { name: 'Mina', avatarUrl: null }

beforeEach(async () => {
  clearChatPanelMessageCache()
})

afterEach(async () => {
  await clearChatHistory()
  // Drops the synchronous mirrors too: the next test starts cold, like a
  // reload would.
  setChatHistoryBackend(null)
})

/** Forget the JS-session mirror but keep what the device holds. */
function simulateReload() {
  setChatHistoryBackend(null)
}

describe('workspace chat boot record', () => {
  test('the key is scoped by user, server and workspace', () => {
    expect(workspaceChatBootKey('u1', 'https://cloud', 'w1')).toBe(
      chatHistoryKey('u1', 'https://cloud', 'workspace-agent:w1'),
    )
    // A paired computer's workspace is a different server: same user, same
    // workspace id, different key.
    expect(workspaceChatBootKey('u1', 'machine-7', 'w1')).not.toBe(
      workspaceChatBootKey('u1', 'https://cloud', 'w1'),
    )
    // Another user never reads this one's chat.
    expect(workspaceChatBootKey('u2', 'https://cloud', 'w1')).not.toBe(
      workspaceChatBootKey('u1', 'https://cloud', 'w1'),
    )
    expect(workspaceChatBootKey(null, 'https://cloud', 'w1')).toBeNull()
    expect(workspaceChatBootKey('u1', 'https://cloud', undefined)).toBeNull()
  })

  test('the server segment falls back the way chat history does', () => {
    expect(chatHistoryOrigin('machine-7')).toBe('machine-7')
    expect(chatHistoryOrigin(null)).toBe(String(chatHistoryOrigin(undefined)))
  })

  test('a load that answered is readable synchronously on the next open', async () => {
    const key = workspaceChatBootKey('u1', 'origin', 'w1')!
    await rememberWorkspaceChatBoot(key, { sessionId: 's1', profile })

    const peeked = peekWorkspaceChatBoot<typeof profile>(key)
    expect(peeked?.sessionId).toBe('s1')
    expect(peeked?.profile?.name).toBe('Mina')
    expect(peekWorkspaceChatBoot(workspaceChatBootKey('u1', 'origin', 'w2'))).toBeNull()
  })

  test('the record survives a reload', async () => {
    const key = workspaceChatBootKey('u1', 'origin', 'w1')!
    await rememberWorkspaceChatBoot(key, { sessionId: 's1', profile })
    simulateReload()

    expect(peekWorkspaceChatBoot(key)).toBeNull()
    const staged = await loadWorkspaceChatBoot<typeof profile>(key)
    expect(staged?.sessionId).toBe('s1')
    expect(staged?.profile?.name).toBe('Mina')
    // …and the read put it back in the mirror for the next synchronous peek.
    expect(peekWorkspaceChatBoot<typeof profile>(key)?.sessionId).toBe('s1')
  })

  test('a profile-only write keeps the session, and vice versa', async () => {
    const key = workspaceChatBootKey('u1', 'origin', 'w1')!
    await rememberWorkspaceChatBoot(key, { sessionId: 's1', profile })
    await rememberWorkspaceChatBoot(key, { profile: { name: 'Nova', avatarUrl: 'a.png' } })

    expect(peekChatBoot<typeof profile>(key)?.sessionId).toBe('s1')
    expect(peekWorkspaceChatBoot<typeof profile>(key)?.profile?.name).toBe('Nova')

    await rememberWorkspaceChatBoot(key, { sessionId: 's2' })
    const both = peekWorkspaceChatBoot<typeof profile>(key)
    expect(both?.sessionId).toBe('s2')
    expect(both?.profile?.name).toBe('Nova')
  })

  test('a cold profile-only write does not drop the session on the device', async () => {
    const key = workspaceChatBootKey('u1', 'origin', 'w1')!
    await rememberWorkspaceChatBoot(key, { sessionId: 's1', profile })
    simulateReload()

    await rememberWorkspaceChatBoot(key, { profile })
    simulateReload()

    const stored = await loadWorkspaceChatBoot<typeof profile>(key)
    expect(stored?.sessionId).toBe('s1')
  })

  test('sign-out clears it along with chat history', async () => {
    const key = workspaceChatBootKey('u1', 'origin', 'w1')!
    await rememberWorkspaceChatBoot(key, { sessionId: 's1', profile })
    await writeChatHistory('project', key, {
      messages: [{ id: 'm1' }],
      cursor: null,
      total: 1,
      hasMoreOlder: false,
      savedAt: Date.now(),
    })

    await clearChatHistory()

    expect(peekChatBoot(key)).toBeNull()
    expect(await readChatBoot(key)).toBeNull()
  })

  test('one workspace can be forgotten without touching another', async () => {
    const keep = workspaceChatBootKey('u1', 'origin', 'keep')!
    const drop = workspaceChatBootKey('u1', 'origin', 'drop')!
    await rememberWorkspaceChatBoot(keep, { sessionId: 's-keep', profile })
    await rememberWorkspaceChatBoot(drop, { sessionId: 's-drop', profile })

    await removeChatBoot(drop)

    expect(peekChatBoot(keep)?.sessionId).toBe('s-keep')
    expect(peekChatBoot(drop)).toBeNull()
  })

  test('a boot record is never mistaken for a transcript', async () => {
    const key = workspaceChatBootKey('u1', 'origin', 'w1')!
    await rememberWorkspaceChatBoot(key, { sessionId: 's1', profile })
    // No `messages` field, so the panel's seed finds nothing for it.
    expect(seedTranscript('s1', key).messages).toBeNull()
  })
})

describe('the first paint', () => {
  const row = (id: string) => ({ id, role: 'user', parts: [{ type: 'text', text: id }] })

  test('the memory cache wins — it is the transcript this window last painted', () => {
    writeSessionMessageCache('s1', [row('memory')])
    const seed = seedTranscript('s1', 'u1:origin:s1')
    expect(seed.source).toBe('memory')
    expect(seed.messages?.[0].id).toBe('memory')
  })

  test('with memory empty, the device mirror is the seed (a reload)', async () => {
    const key = 'u1:origin:s1'
    await writeChatHistory('project', key, {
      messages: [row('device')],
      cursor: '2026-11-04T00:00:00.000Z',
      total: 1,
      hasMoreOlder: false,
      savedAt: Date.now(),
    })
    expect(seedTranscript('s1', key).source).toBe('device')
    expect(seedTranscript('s1', key).messages?.[0].id).toBe('device')
  })

  test('nothing on the device is a genuine miss', () => {
    const seed = seedTranscript('s-never-seen', 'u1:origin:s-never-seen')
    expect(seed.source).toBe('none')
    expect(seed.messages).toBeNull()
    expect(seedTranscript(null, null).messages).toBeNull()
  })

  test('the loader is only for a chat that really has to be fetched', () => {
    const base = { hasSession: true, isComplete: false, isStreaming: false, hydrationPending: false }
    expect(transcriptLoaderVisible(base)).toBe(true)
    // The device read has not answered: paint nothing, not a loader.
    expect(transcriptLoaderVisible({ ...base, hydrationPending: true })).toBe(false)
    expect(transcriptLoaderVisible({ ...base, isComplete: true })).toBe(false)
    expect(transcriptLoaderVisible({ ...base, isStreaming: true })).toBe(false)
    expect(transcriptLoaderVisible({ ...base, hasSession: false })).toBe(false)
  })

  test('the workspace screen shows a loader only on a first-ever open', () => {
    const base = {
      hasWorkspace: true,
      hasProfile: false,
      hasSession: false,
      bootPending: false,
      error: null,
    }
    expect(workspaceChatLoadingView(base)).toBe('spinner')
    expect(workspaceChatLoadingView({ ...base, bootPending: true })).toBe('blank')
    expect(workspaceChatLoadingView({ ...base, error: 'boom' })).toBe('error')
    expect(
      workspaceChatLoadingView({ ...base, hasProfile: true, hasSession: true }),
    ).toBe('chat')
    // A cached chat outranks a failed revalidation.
    expect(
      workspaceChatLoadingView({
        ...base,
        hasProfile: true,
        hasSession: true,
        error: 'boom',
      }),
    ).toBe('chat')
    // No workspace yet is the app booting, not this chat — and it is the frame a
    // reopen starts on (the collection is refetching), so a spinner here would
    // cover a chat the device holds (SHO-309, caught in CI).
    expect(workspaceChatLoadingView({ ...base, hasWorkspace: false })).toBe('blank')
    expect(
      workspaceChatLoadingView({ ...base, hasWorkspace: false, bootPending: true }),
    ).toBe('blank')
  })

  test('the device wait ends only when the account has no workspace at all', () => {
    // A key that is merely not resolved yet is the case the wait exists for:
    // the user or the workspace in view has not answered, or the collection is
    // refreshing. Releasing here paints the spinner over a chat the device has.
    expect(
      bootWaitCanEndWithoutRecord({ collectionReady: true, workspaceCount: 2 }),
    ).toBe(false)
    expect(
      bootWaitCanEndWithoutRecord({ collectionReady: false, workspaceCount: 0 }),
    ).toBe(false)
    // Nothing to open, so nothing can arrive.
    expect(
      bootWaitCanEndWithoutRecord({ collectionReady: true, workspaceCount: 0 }),
    ).toBe(true)
  })
})
