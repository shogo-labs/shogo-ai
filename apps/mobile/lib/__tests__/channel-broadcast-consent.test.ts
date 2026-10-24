// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, mock, test } from 'bun:test'
import { encodeMentions, mentionCandidates } from '../team-chat-state'
import {
  broadcastConfirmCopy,
  broadcastsNeedingConsent,
  confirmsChannelBroadcast,
} from '../channel-broadcast-consent'

describe('broadcastsNeedingConsent', () => {
  test('a picked @channel in a channel needs asking', () => {
    expect(broadcastsNeedingConsent('<!channel> standup in five', 'public')).toEqual(['channel'])
    expect(broadcastsNeedingConsent('<!channel> standup in five', 'private')).toEqual(['channel'])
  })

  test('@here needs asking too, because it reaches whoever is online', () => {
    expect(broadcastsNeedingConsent('<!here> anyone around?', 'public')).toEqual(['here'])
  })

  test('reports both tokens once each, in first-seen order', () => {
    expect(broadcastsNeedingConsent('<!here> then <!channel> then <!here>', 'public')).toEqual(['here', 'channel'])
  })

  test('a DM broadcasts to nobody new, so it is not asked about', () => {
    // `<!channel>` in a DM reaches the two people already in it.
    expect(broadcastsNeedingConsent('<!channel> hi', 'dm')).toEqual([])
    expect(broadcastsNeedingConsent('<!channel> hi', 'group_dm')).toEqual([])
  })

  test('a plain message and a #channel reference are not broadcasts', () => {
    expect(broadcastsNeedingConsent('see <#c:abc123> for context', 'public')).toEqual([])
    expect(broadcastsNeedingConsent('<@u:user1> can you look?', 'public')).toEqual([])
    expect(broadcastsNeedingConsent('', 'public')).toEqual([])
  })

  test('a missing kind is never asked about', () => {
    expect(broadcastsNeedingConsent('<!channel> hi', null)).toEqual([])
    expect(broadcastsNeedingConsent('<!channel> hi', undefined)).toEqual([])
  })

  test('a token inside backticks still counts, because the server still matches it', () => {
    // `parseMentions` on the server scans the whole string; a token in code is
    // not inert, so asking about less than the server acts on would be theatre.
    expect(broadcastsNeedingConsent('try `<!channel>` in the header', 'public')).toEqual(['channel'])
  })
})

describe('broadcastConfirmCopy', () => {
  test('names the channel it is warning about', () => {
    expect(broadcastConfirmCopy(['channel'], 'engineering')).toEqual({
      title: 'Notify everyone in #engineering?',
      body: 'Everyone in #engineering will get a notification for this message.',
    })
  })

  test('does not double the hash when the name already carries one', () => {
    expect(broadcastConfirmCopy(['channel'], '#engineering').title).toBe('Notify everyone in #engineering?')
  })

  test('falls back to "this channel" when the name is unknown', () => {
    expect(broadcastConfirmCopy(['channel'], null).title).toBe('Notify everyone in this channel?')
    expect(broadcastConfirmCopy(['channel'], '   ').body).toBe(
      'Everyone in this channel will get a notification for this message.',
    )
  })

  test('@here promises only the people who are online', () => {
    expect(broadcastConfirmCopy(['here'], 'engineering')).toEqual({
      title: 'Notify everyone online?',
      body: 'Everyone who is online right now will get a notification for this message.',
    })
  })

  test('naming the channel wins when both tokens are present', () => {
    // `<!here>` reaches a subset of the channel, so the channel is the stronger
    // warning; both tokens together drop the redundant "in #x" from the title
    // but keep the channel in the body, where the audience actually is.
    for (const tokens of [['here', 'channel'], ['channel', 'here']] as const) {
      const copy = broadcastConfirmCopy([...tokens], 'engineering')
      expect(copy.title).toBe('Notify everyone?')
      expect(copy.body).toBe('Everyone in #engineering will get a notification for this message.')
    }
  })
})

describe('confirmsChannelBroadcast', () => {
  test('sends without asking when nothing broadcasts', async () => {
    const ask = mock(async () => false)
    expect(await confirmsChannelBroadcast('just a message', { kind: 'public', name: 'eng' }, { ask })).toBe(true)
    expect(ask).not.toHaveBeenCalled()
  })

  test('asks with the channel copy, and a decline holds the message back', async () => {
    const asked: unknown[] = []
    const allowed = await confirmsChannelBroadcast('<!channel> ship it', { kind: 'public', name: 'eng' }, {
      ask: async (copy) => {
        asked.push(copy)
        return false
      },
    })
    expect(allowed).toBe(false)
    expect(asked).toEqual([broadcastConfirmCopy(['channel'], 'eng')])
  })

  test('a confirmation lets it through', async () => {
    expect(
      await confirmsChannelBroadcast('<!channel> ship it', { kind: 'public', name: 'eng' }, { ask: async () => true }),
    ).toBe(true)
  })
})

describe('the picker → token → confirm chain', () => {
  /**
   * The composer reaches this module with text it has already encoded, so the
   * path that matters is: picking `@channel` from the menu leaves an reference
   * whose token is `<!channel>`, and `encodeMentions` swaps the label for it.
   * If that ever stops producing a token, the confirmation silently never fires
   * — which is exactly the bug this feature exists to prevent, inverted.
   */
  const mentionables = { people: [], agents: [] }

  test('picking @channel from the menu produces the token the confirm looks for', () => {
    const picked = mentionCandidates(mentionables, null, null).filter((c) => c.display === 'channel')
    expect(picked).toHaveLength(1)

    const wire = encodeMentions('@channel standup in five', picked as any)
    expect(wire).toBe('<!channel> standup in five')
    expect(broadcastsNeedingConsent(wire, 'public')).toEqual(['channel'])
  })

  test('picking @here produces the token the confirm looks for', () => {
    const picked = mentionCandidates(mentionables, null, null).filter((c) => c.display === 'here')
    expect(encodeMentions('@here anyone around?', picked as any)).toBe('<!here> anyone around?')
  })

  test('typing @channel without picking it produces no token, so nothing is asked', () => {
    // The server resolves friendly names for people, agents and groups only —
    // never `here`/`channel` — so an unpicked `@channel` is inert text. Asking
    // about it would warn about a broadcast that never happens.
    const wire = encodeMentions('@channel standup in five', [])
    expect(wire).toBe('@channel standup in five')
    expect(broadcastsNeedingConsent(wire, 'public')).toEqual([])
  })
})
