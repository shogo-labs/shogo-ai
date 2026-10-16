// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import {
  COMPOSER_CATEGORIES,
  DOC_CATEGORIES,
  allMentionCandidates,
  buildMentionMenu,
  candidateForToken,
  mentionMenuData,
  type MentionMenuData,
} from '../mention-menu'
import { completionMenuKey } from '../completion-menu-keys'
import { monthGrid, parseClockInput, reminderPresets } from '../doc-tokens'
import { conversationRouteParams } from '../team-chat-links'
import { candidateText, encodeMentions, decodeMentions } from '../team-chat-state'

const NOW = new Date('2026-10-13T15:00:00Z') // a Tuesday

const people = Array.from({ length: 8 }, (_, i) => ({ id: `u${i}`, name: `Sam ${String.fromCharCode(65 + i)}`, email: `sam${i}@x.dev`, image: null, role: 'member' }))
people.push({ id: 'me', name: 'Me Myself', email: 'me@x.dev', image: null, role: 'owner' })

function data(over: Partial<MentionMenuData> = {}): MentionMenuData {
  return {
    ...mentionMenuData(
      {
        people,
        agents: [{ key: 'ws', projectId: null, name: 'Shogo', description: null, image: null }],
        channels: [
          { id: 'c1', name: 'devops', kind: 'public' },
          { id: 'c2', name: 'secret', kind: 'private' },
          { id: 'd1', name: null, kind: 'dm' },
        ],
        projects: [{ id: 'p1', name: 'Samurai Site', description: null }],
      },
      'me',
    ),
    now: NOW,
    timeZone: 'UTC',
    ...over,
  }
}

describe('buildMentionMenu', () => {
  test('a bare @ lists categories with counts, skipping empty ones', () => {
    const menu = buildMentionMenu(data(), DOC_CATEGORIES, '', null)
    expect(menu.rows.map((r) => [r.type, r.label])).toEqual([
      ['category', 'People'],
      ['category', 'Agents'],
      ['category', 'Channels'],
      ['category', 'Projects'],
      ['category', 'Dates'],
    ])
    expect(menu.rows[0].subtitle).toBe('8')
    expect(menu.rows[0].drill).toBe('people')
    expect(menu.footer).toBeNull()
  })

  test('recent picks come first, then a Browse section', () => {
    const menu = buildMentionMenu(data({ recent: ['<#c:c1>', '<@u:u3>', '<@u:gone>'] }), DOC_CATEGORIES, '', null)
    expect(menu.rows.slice(0, 3).map((r) => [r.section, r.label])).toEqual([
      ['Recent', 'devops'],
      [undefined, 'Sam D'],
      ['Browse', 'People'],
    ])
  })

  test('typing searches every category, grouped and capped with See all', () => {
    const menu = buildMentionMenu(data(), DOC_CATEGORIES, 'sam', null)
    const people = menu.rows.filter((r) => r.category === 'people')
    expect(people.filter((r) => r.type === 'item')).toHaveLength(5)
    expect(people[0].section).toBe('People')
    expect(people.at(-1)).toMatchObject({ type: 'see-all', label: 'See all 8 people', drill: 'people' })
    const project = menu.rows.find((r) => r.category === 'projects')!
    expect(project).toMatchObject({ section: 'Projects', label: 'Samurai Site' })
    expect(candidateText(project.candidate!)).toBe('@[project:Samurai Site]')
    expect(menu.rows.some((r) => r.label === 'Me Myself')).toBe(false)
  })

  test('inside a category the query only filters that category', () => {
    const menu = buildMentionMenu(data(), DOC_CATEGORIES, 'sam', 'people')
    expect(menu.rows[0]).toMatchObject({ type: 'back', label: 'People' })
    expect(menu.rows.slice(1).every((r) => r.category === 'people' && r.type === 'item')).toBe(true)
    expect(menu.rows).toHaveLength(9)
  })

  test('channels exclude DMs and insert as #name', () => {
    const menu = buildMentionMenu(data(), DOC_CATEGORIES, '', 'channels')
    const items = menu.rows.filter((r) => r.type === 'item')
    expect(items.map((r) => candidateText(r.candidate!))).toEqual(['#devops', '#secret'])
    expect(items[1].subtitle).toBe('Private channel')
  })

  test('dates offer quick picks and a picker', () => {
    const top = buildMentionMenu(data(), DOC_CATEGORIES, 'tomorrow', null)
    const date = top.rows.find((r) => r.category === 'dates')!
    expect(date.candidate!.token).toBe('<!date:2026-10-14>')
    expect(date.subtitle).toBe('Tomorrow · Oct 14')
    const drilled = buildMentionMenu(data(), DOC_CATEGORIES, '', 'dates')
    expect(drilled.rows.at(-1)!.type).toBe('pick-date')
    expect(drilled.rows.filter((r) => r.type === 'item').length).toBeGreaterThan(0)
    expect(buildMentionMenu(data(), DOC_CATEGORIES, 'date', null).rows.some((r) => r.type === 'pick-date')).toBe(true)
  })

  test('private channels flag non-members and explain who is notified', () => {
    const menu = buildMentionMenu(data({ memberIds: new Set(['u0', 'me']), membersOnly: true }), DOC_CATEGORIES, 'sam', 'people')
    expect(menu.rows.find((r) => r.label === 'Sam A')!.trailing).toBeNull()
    expect(menu.rows.find((r) => r.label === 'Sam B')!.trailing).toBe('Not in channel')
    expect(menu.footer).toBe('Only people in this channel will be notified')
  })

  test('the composer also offers groups and @here', () => {
    const menu = buildMentionMenu(data(), COMPOSER_CATEGORIES, '', null)
    expect(menu.rows.map((r) => r.label)).toContain('Notify')
    expect(menu.rows.map((r) => r.label)).not.toContain('Groups')
    expect(buildMentionMenu(data(), DOC_CATEGORIES, 'here', null).rows).toHaveLength(0)
    expect(buildMentionMenu(data(), COMPOSER_CATEGORIES, 'here', null).rows[0].candidate!.token).toBe('<!here>')
  })
})

describe('composer round trip', () => {
  test('channels, projects and dates encode to tokens and decode back', () => {
    const d = data()
    const all = allMentionCandidates(d)
    const byToken = new Map(all.map((c) => [c.token, c]))
    const picks = ['<#c:c1>', '<#p:p1>', '<!date:2026-10-19>', '<@u:u1>'].map((t) => candidateForToken(t, byToken, NOW, 'UTC')!)
    const text = `Ship ${picks.map(candidateText).join(' and ')}.`
    const wire = encodeMentions(text, picks)
    expect(wire).toBe('Ship <#c:c1> and <#p:p1> and <!date:2026-10-19> and <@u:u1>.')
    const back = decodeMentions(wire, all)
    expect(back.picked.map((c) => c.token)).toEqual(['<#c:c1>', '<#p:p1>', '<!date:2026-10-19>', '<@u:u1>'])
  })
})

describe('completionMenuKey', () => {
  const s = { index: 0, count: 3, canGoBack: false, queryEmpty: true }
  test('arrows wrap, Enter/Tab select, Escape closes', () => {
    expect(completionMenuKey('ArrowUp', s)).toEqual({ type: 'move', index: 2 })
    expect(completionMenuKey('ArrowDown', { ...s, index: 2 })).toEqual({ type: 'move', index: 0 })
    expect(completionMenuKey('Enter', { ...s, index: 1 })).toEqual({ type: 'select', index: 1 })
    expect(completionMenuKey('Tab', s)).toEqual({ type: 'select', index: 0 })
    expect(completionMenuKey('Escape', s)).toEqual({ type: 'close' })
    expect(completionMenuKey('a', s)).toEqual({ type: 'none' })
  })
  test('Left and Backspace on an empty query go back from a category', () => {
    expect(completionMenuKey('ArrowLeft', s)).toEqual({ type: 'none' })
    expect(completionMenuKey('ArrowLeft', { ...s, canGoBack: true })).toEqual({ type: 'back' })
    expect(completionMenuKey('Backspace', { ...s, canGoBack: true })).toEqual({ type: 'back' })
    expect(completionMenuKey('Backspace', { ...s, canGoBack: true, queryEmpty: false })).toEqual({ type: 'none' })
  })
})

describe('date picker helpers', () => {
  test('monthGrid lays out October 2026 from Sunday', () => {
    const weeks = monthGrid(2026, 9)
    expect(weeks[0]).toEqual([null, null, null, null, '2026-10-01', '2026-10-02', '2026-10-03'])
    expect(weeks.flat().filter(Boolean)).toHaveLength(31)
    expect(weeks.every((w) => w.length === 7)).toBe(true)
  })
  test('parseClockInput', () => {
    expect(parseClockInput('3pm')).toBe('15:00')
    expect(parseClockInput('3:30 PM')).toBe('15:30')
    expect(parseClockInput('12am')).toBe('00:00')
    expect(parseClockInput('12 pm')).toBe('12:00')
    expect(parseClockInput('09:05')).toBe('09:05')
    expect(parseClockInput('25:00')).toBeNull()
    expect(parseClockInput('13pm')).toBeNull()
    expect(parseClockInput('soon')).toBeNull()
  })
})

describe('reminderPresets', () => {
  const now = new Date('2026-10-13T12:00:00Z')

  test('a date offers 9:00 the morning of, the day before and the week before', () => {
    const presets = reminderPresets('2026-10-30', now, 'UTC')
    expect(presets.map((p) => p.label)).toEqual(['Morning of (9:00 AM)', 'Day before (9:00 AM)', 'Week before (9:00 AM)'])
    expect(presets.map((p) => p.at.toISOString())).toEqual([
      '2026-10-30T09:00:00.000Z',
      '2026-10-29T09:00:00.000Z',
      '2026-10-23T09:00:00.000Z',
    ])
  })

  test('a moment offers offsets before it, and anything already past is dropped', () => {
    const presets = reminderPresets('2026-10-13T12:30Z', now)
    expect(presets.map((p) => p.label)).toEqual(['At time of event', '15 minutes before'])
    expect(presets[1].at.toISOString()).toBe('2026-10-13T12:15:00.000Z')
    expect(reminderPresets('not a date', now)).toEqual([])
  })
})

describe('conversationRouteParams', () => {
  test('doc targets open the doc; messages open their thread', () => {
    expect(conversationRouteParams({ conversationId: 'c1', messageId: null, target: 'doc' })).toEqual({ conversationId: 'c1', doc: '1' })
    expect(conversationRouteParams({ conversationId: 'c1', messageId: 'm1' })).toEqual({ conversationId: 'c1', thread: 'm1' })
    expect(conversationRouteParams({ conversationId: 'c1', messageId: 'm2', threadRootId: 'm1' })).toEqual({ conversationId: 'c1', thread: 'm1' })
    expect(conversationRouteParams({ conversationId: 'c1' })).toEqual({ conversationId: 'c1' })
  })
})
