// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The menu-bar dropdown: ordering, caps, empty state, cloud vs local, and the
 * recording row. Electron-free by design — the builder is a pure function of
 * the model plus the app state, so this runs without a Tray.
 */

import { describe, expect, test } from 'bun:test'
import {
  buildTrayMenuTemplate,
  describeTrayMenuTemplate,
  ellipsizeMenuTitle,
  type TrayIcons,
  type TrayMenuHandlers,
  type TrayMenuOptions,
  type TrayMeetingSnapshot,
} from '../tray-menu'
import { EMPTY_TRAY_MODEL, parseTrayModel, type TrayModel, type TrayRow } from '../tray-protocol'

const icons: TrayIcons = {
  running: { id: 'orange' } as never,
  needsYou: { id: 'red' } as never,
  newReply: { id: 'blue' } as never,
}

function calls() {
  const log: string[] = []
  const handlers: TrayMenuHandlers = {
    onOpenChat: (row) => log.push(`open:${row.sessionId}`),
    onNewChat: () => log.push('new-chat'),
    onClearNotifications: () => log.push('clear'),
    onOpenApp: () => log.push('open-app'),
    onToggleShowCount: (next) => log.push(`show-count:${next}`),
    onOpenSettings: () => log.push('settings'),
    onQuit: () => log.push('quit'),
    onOpenMeetings: () => log.push('open-meetings'),
    onSetIslandEnabled: (next) => log.push(`island:${next}`),
    onSetMeetingsEnabled: (next) => log.push(`meetings:${next}`),
    onStartRecording: () => log.push('start-recording'),
    onStopRecording: () => log.push('stop-recording'),
    onSetAutoDetect: (next) => log.push(`auto-detect:${next}`),
    onSetAutoRecord: (next) => log.push(`auto-record:${next}`),
  }
  return { log, handlers }
}

const idleMeeting: TrayMeetingSnapshot = {
  enabled: true,
  autoDetect: true,
  autoRecord: false,
  islandEnabled: true,
  recording: false,
  recordingLabel: '',
}

function options(overrides: Partial<TrayMenuOptions> = {}): TrayMenuOptions {
  const { handlers } = calls()
  return {
    model: EMPTY_TRAY_MODEL,
    localMode: true,
    showCount: true,
    meeting: idleMeeting,
    icons,
    handlers,
    ...overrides,
  }
}

function row(overrides: Partial<TrayRow> & { sessionId: string }): TrayRow {
  return {
    projectId: null,
    title: overrides.sessionId,
    status: null,
    path: `/(app)/agent?chatSessionId=${overrides.sessionId}`,
    ...overrides,
  }
}

/** A model as main receives it: through the real parser, so `attentionCount`
 * and `canClear` are derived exactly like they are in production. */
function model(overrides: Partial<TrayModel>): TrayModel {
  return parseTrayModel({ ...EMPTY_TRAY_MODEL, ...overrides })
}

/** The template's menu items by label, searching submenus too. */
function itemAt(template: ReturnType<typeof buildTrayMenuTemplate>, label: string) {
  for (const item of template) {
    if (item.label === label) return item
    if (Array.isArray(item.submenu)) {
      const found = item.submenu.find((child) => child.label === label)
      if (found) return found
    }
  }
  return undefined
}

describe('buildTrayMenuTemplate', () => {
  test('pinned chats come first, then one section per agent, then the actions', () => {
    const template = buildTrayMenuTemplate(
      options({
        model: model({
          pinned: [row({ sessionId: 'pin-1', title: 'Pinned chat' })],
          groups: [
            { title: 'Shogo', rows: [row({ sessionId: 'ws-1', title: 'Workspace chat', status: 'running' })] },
            {
              title: 'Shogo Dev 5',
              rows: [row({ sessionId: 'p-1', projectId: 'proj-1', title: 'Card work', status: 'needs_you' })],
            },
          ],
        }),
      }),
    )
    expect(describeTrayMenuTemplate(template)).toEqual([
      '- Pinned (disabled)',
      '- Pinned chat',
      '- ---',
      '- Shogo (disabled)',
      '- Workspace chat',
      '- Shogo Dev 5 (disabled)',
      '- Card work',
      '- ---',
      '- New Chat',
      '- Clear All Notifications (disabled)',
      '- ---',
      '- Open Shogo',
      '- Show Count [x]',
      '- Meetings',
      '-- Meetings & transcription [x]',
      '-- ---',
      '-- Start Recording',
      '-- ---',
      '-- Auto-detect Meetings [x]',
      '-- Auto-record [ ]',
      '-- Show Island [x]',
      '-- ---',
      '-- Open Meetings',
      '- ---',
      '- Settings',
      '- Quit Shogo',
    ])
  })

  test('each row carries its dot icon by status', () => {
    const template = buildTrayMenuTemplate(
      options({
        model: model({
          groups: [
            {
              title: 'Shogo',
              rows: [
                row({ sessionId: 'run', title: 'Running', status: 'running' }),
                row({ sessionId: 'ask', title: 'Needs you', status: 'needs_you' }),
                row({ sessionId: 'new', title: 'New reply', status: 'new' }),
              ],
            },
          ],
        }),
      }),
    )
    expect(itemAt(template, 'Running')?.icon).toBe(icons.running as never)
    expect(itemAt(template, 'Needs you')?.icon).toBe(icons.needsYou as never)
    expect(itemAt(template, 'New reply')?.icon).toBe(icons.newReply as never)
  })

  test('falls back to the 5 recent chats when nothing has a dot', () => {
    const recent = Array.from({ length: 5 }, (_, i) => row({ sessionId: `r${i}`, title: `Recent ${i}` }))
    const template = buildTrayMenuTemplate(options({ model: model({ recent }) }))
    const lines = describeTrayMenuTemplate(template)
    expect(lines.slice(0, 6)).toEqual([
      '- Recent (disabled)',
      '- Recent 0',
      '- Recent 1',
      '- Recent 2',
      '- Recent 3',
      '- Recent 4',
    ])
  })

  test('empty model still yields a usable menu', () => {
    const lines = describeTrayMenuTemplate(buildTrayMenuTemplate(options()))
    expect(lines[0]).toBe('- No chats yet (disabled)')
    expect(lines).toContain('- New Chat')
    expect(lines).toContain('- Clear All Notifications (disabled)')
    expect(lines).toContain('- Quit Shogo')
  })

  test('Clear All Notifications is enabled only when a blue dot is showing', () => {
    const withNew = buildTrayMenuTemplate(
      options({ model: model({ groups: [{ title: 'Shogo', rows: [row({ sessionId: 'n', status: 'new' })] }] }) }),
    )
    expect(itemAt(withNew, 'Clear All Notifications')?.enabled).not.toBe(false)

    const onlyRunning = buildTrayMenuTemplate(
      options({ model: model({ groups: [{ title: 'Shogo', rows: [row({ sessionId: 'r', status: 'running' })] }] }) }),
    )
    expect(itemAt(onlyRunning, 'Clear All Notifications')?.enabled).toBe(false)
  })

  test('cloud mode omits Meetings entirely; local mode keeps every control', () => {
    const cloud = describeTrayMenuTemplate(buildTrayMenuTemplate(options({ localMode: false })))
    expect(cloud).not.toContain('- Meetings')
    expect(cloud.some((line) => line.includes('Start Recording'))).toBe(false)
    expect(cloud).toContain('- Settings')
    expect(cloud).toContain('- Quit Shogo')

    const local = describeTrayMenuTemplate(buildTrayMenuTemplate(options({ localMode: true })))
    expect(local).toContain('- Meetings')
    expect(local).toContain('-- Meetings & transcription [x]')
    expect(local).toContain('-- Start Recording')
    expect(local).toContain('-- Auto-detect Meetings [x]')
    expect(local).toContain('-- Auto-record [ ]')
    expect(local).toContain('-- Show Island [x]')
    expect(local).toContain('-- Open Meetings')
  })

  test('recording shows the timer and Stop Recording instead of Start', () => {
    const lines = describeTrayMenuTemplate(
      buildTrayMenuTemplate(
        options({ meeting: { ...idleMeeting, recording: true, recordingLabel: '1:23' } }),
      ),
    )
    expect(lines).toContain('-- Recording 1:23 (disabled)')
    expect(lines).toContain('-- Stop Recording')
    expect(lines).not.toContain('-- Start Recording')
  })

  test('Show Count reflects the stored setting and reports the next value', () => {
    const { log, handlers } = calls()
    const off = buildTrayMenuTemplate(options({ showCount: false, handlers }))
    expect(itemAt(off, 'Show Count')?.checked).toBe(false)
    const item = itemAt(off, 'Show Count')!
    // Electron hands the item back after toggling it.
    item.click?.({ ...item, checked: true } as never, undefined as never, undefined as never)
    expect(log).toEqual(['show-count:true'])
  })

  test('clicking a chat row hands back its own row', () => {
    const { log, handlers } = calls()
    const template = buildTrayMenuTemplate(
      options({ handlers, model: model({ pinned: [row({ sessionId: 'abc' })] }) }),
    )
    const item = itemAt(template, 'abc')!
    item.click?.(item, undefined as never, undefined as never)
    expect(log).toEqual(['open:abc'])
  })

  test('long titles are elided at 48 characters', () => {
    expect(ellipsizeMenuTitle('x'.repeat(80))).toHaveLength(48)
    expect(ellipsizeMenuTitle('x'.repeat(80)).endsWith('…')).toBe(true)
    expect(ellipsizeMenuTitle('  A normal title  ')).toBe('A normal title')
  })
})
