// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Who appears on a huddle surface and how the stage is laid out: raised hands
 * first, rung-in people last, a shared screen over everything, a pin over the
 * speaker. Plus the poll helpers and the share-link shape used in huddles.
 */
import { describe, expect, test } from 'bun:test'
import { buildRoster, gridColumns, miniFeature, miniScreen, miniSelfView, pickStage, summarizeNames } from '../huddle-roster'
import { audienceQuestionOf, pollOf, pollVoterCount, sortQuestions } from '../team-chat-kinds'
import { huddleJoinLink } from '../team-chat-links'

const person = (userId: string, extra: Record<string, unknown> = {}) => ({
  userId,
  name: userId.toUpperCase(),
  image: null,
  isLocal: userId === 'me',
  muted: false,
  cameraOn: false,
  screenOn: false,
  speaking: false,
  quality: 'good',
  handRaisedAt: null,
  guest: false,
  ...extra,
})

const tile = (userId: string, source: 'camera' | 'screen') => ({ key: `${userId}:${source}`, userId, name: userId, source, isLocal: userId === 'me', track: {} }) as any

const build = (participants: any[], extra: Record<string, unknown> = {}) =>
  buildRoster({ participants, huddle: null, video: [], speaking: [], me: 'me', ...extra } as any)

describe('buildRoster', () => {
  test('raised hands come first (earliest first), then the call, then people still being rung', () => {
    const roster = build([person('me'), person('ana', { handRaisedAt: 200 }), person('ben', { handRaisedAt: 100 }), person('cy')], {
      huddle: {
        participants: [],
        invited: [
          { userId: 'dee', name: 'Dee', image: null, status: 'ringing' },
          { userId: 'eli', name: 'Eli', image: null, status: 'declined' },
          { userId: 'fay', name: 'Fay', image: null, status: 'missed' },
        ],
      },
    })
    expect(roster.map((e) => e.userId)).toEqual(['ben', 'ana', 'me', 'cy', 'dee', 'eli', 'fay'])
    expect(roster.slice(4).map((e) => e.status)).toEqual(['ringing', 'declined', 'missed'])
  })

  test('a person the server has but the room has not reported yet still gets a tile, and an invitee already in the call is not shown twice', () => {
    const roster = build([person('me')], {
      huddle: {
        participants: [{ userId: 'pat', name: 'Pat', image: null }],
        invited: [{ userId: 'pat', name: 'Pat', image: null, status: 'ringing' }],
      },
    })
    expect(roster.map((e) => [e.userId, e.status])).toEqual([
      ['me', 'in-call'],
      ['pat', 'in-call'],
    ])
  })

  test('speaking, mute and guests carry through, and video tiles attach to their person', () => {
    const roster = build([person('me'), person('ana', { muted: true, guest: true })], {
      speaking: ['ana'],
      video: [tile('ana', 'camera'), tile('ana', 'screen')],
    })
    const ana = roster.find((e) => e.userId === 'ana')!
    expect(ana).toMatchObject({ speaking: true, muted: true, guest: true })
    expect(ana.camera?.source).toBe('camera')
    expect(ana.screen?.source).toBe('screen')
  })
})

describe('pickStage and miniFeature', () => {
  const roster = () => build([person('me'), person('ana'), person('ben')], { video: [tile('ben', 'camera')] })

  test('grid layout spotlights no one; speaker layout follows the loudest other person', () => {
    expect(pickStage(roster(), 'grid', null, ['ana']).spotlight).toBeNull()
    expect(pickStage(roster(), 'speaker', null, ['ana']).spotlight?.userId).toBe('ana')
    expect(pickStage(roster(), 'speaker', null, []).spotlight?.userId).toBe('ana')
    expect(pickStage(roster(), 'speaker', null, ['me']).spotlight?.userId).toBe('ana')
  })

  test('a pin beats the speaker, and a shared screen beats the pin', () => {
    expect(pickStage(roster(), 'speaker', 'ben', ['ana']).spotlight?.userId).toBe('ben')
    const sharing = build([person('me'), person('ana'), person('ben')], { video: [tile('ana', 'screen')] })
    const stage = pickStage(sharing, 'speaker', 'ben', ['ben'])
    expect(stage.screen?.userId).toBe('ana')
    expect(stage.spotlight).toBeNull()
  })

  test('the mini card features the pin, then the speaker, then anyone else, then you', () => {
    expect(miniFeature(roster(), ['ana'], 'ben')?.userId).toBe('ben')
    expect(miniFeature(roster(), ['ana'], null)?.userId).toBe('ana')
    expect(miniFeature(roster(), [], null)?.userId).toBe('ana')
    expect(miniFeature(build([person('me')]), [], null)?.userId).toBe('me')
  })
})

describe('mini card screen and self-view', () => {
  test('a shared screen shows on the mini card, someone else\'s before your own', () => {
    expect(miniScreen(build([person('me'), person('ana')]))).toBeNull()
    expect(miniScreen(build([person('me'), person('ana')], { video: [tile('ana', 'screen')] }))?.userId).toBe('ana')
    expect(miniScreen(build([person('me'), person('ana')], { video: [tile('me', 'screen'), tile('ana', 'screen')] }))?.userId).toBe('ana')
  })

  test('you get a self-view when your camera is on and someone else is featured', () => {
    const roster = build([person('me', { cameraOn: true }), person('ana')], { video: [tile('me', 'camera')] })
    expect(miniSelfView(roster, miniFeature(roster, [], null))?.userId).toBe('me')
    expect(miniSelfView(roster, roster.find((e) => e.isLocal)!)).toBeNull()
    const off = build([person('me'), person('ana')])
    expect(miniSelfView(off, miniFeature(off, [], null))).toBeNull()
  })
})

describe('layout helpers', () => {
  test('grid columns grow with the call', () => {
    expect([1, 2, 4, 5, 9, 10, 50].map(gridColumns)).toEqual([1, 2, 2, 3, 3, 4, 4])
  })
  test('name summaries stay short', () => {
    expect(summarizeNames(['Ana'])).toBe('Ana')
    expect(summarizeNames(['Ana', 'Ben'])).toBe('Ana and Ben')
    expect(summarizeNames(['Ana', 'Ben', 'Cy', 'Dee'])).toBe('Ana, Ben and 2 more')
  })
})

describe('polls and questions in the huddle thread', () => {
  const poll = { question: 'Ship it?', options: [{ id: 'y', text: 'Yes' }, { id: 'n', text: 'No' }], multiple: false, closed: false, tally: { y: 2 }, voters: { y: ['a', 'b'], n: [] } }
  const question = (id: string, upvotes: number, answered = false, createdAt = '2026-10-21T00:00:00.000Z') => ({
    id,
    createdAt,
    blocks: { question: { answered, upvotes, upvoters: [] } } as Record<string, unknown>,
  })

  test('only well-formed blocks count, and missing tallies default to empty', () => {
    expect(pollOf({ blocks: { poll } as any })?.question).toBe('Ship it?')
    expect(pollOf({ blocks: { poll: { question: 'x' } } as any })).toBeNull()
    expect(pollOf({ blocks: null })).toBeNull()
    expect(pollOf({ blocks: { poll: { ...poll, tally: undefined, voters: undefined } } as any })).toMatchObject({ tally: {}, voters: {} })
    expect(audienceQuestionOf({ blocks: { question: { answered: false } } as any })).toMatchObject({ upvotes: 0, upvoters: [] })
    expect(audienceQuestionOf({ blocks: { question: 'nope' } as any })).toBeNull()
  })

  test('voters are counted once even when they picked several options', () => {
    expect(pollVoterCount({ ...poll, multiple: true, voters: { y: ['a', 'b'], n: ['b', 'c'] } })).toBe(3)
  })

  test('questions sort by upvotes with answered ones last; ties go to the older question', () => {
    const sorted = sortQuestions([
      question('answered-popular', 9, true),
      question('new', 1, false, '2026-10-21T02:00:00.000Z'),
      question('old', 1, false, '2026-10-21T01:00:00.000Z'),
      question('top', 5),
    ])
    expect(sorted.map((m) => m.id)).toEqual(['top', 'old', 'new', 'answered-popular'])
  })
})

describe('huddle links', () => {
  test('the share link points at the public join page and escapes the token', () => {
    expect(huddleJoinLink('abc', 'https://app.shogo.test')).toBe('https://app.shogo.test/huddle/join/abc')
    expect(huddleJoinLink('a/b c', 'https://app.shogo.test')).toBe('https://app.shogo.test/huddle/join/a%2Fb%20c')
  })
})
