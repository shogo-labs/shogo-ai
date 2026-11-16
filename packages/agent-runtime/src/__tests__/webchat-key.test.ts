// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * WebChat widget-key lifecycle (SHO-380).
 *
 * The key is the only credential an embedded page carries, so it must be
 * created once and stay stable across reconnects, and an already-connected
 * channel with no key must get one persisted without the owner reconnecting.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  backfillWebchatWidgetSecret,
  resolveWebchatWidgetSecret,
} from '../channels/webchat-key'

const { WebChatAdapter } = await import('../channels/webchat')

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

describe('WebChatAdapter widget key exposure', () => {
  test('getStatus — the payload behind the public health route — omits the key', async () => {
    const adapter = new WebChatAdapter()
    await adapter.connect({ widgetSecret: 'super-secret', title: 'Hi' })

    expect(adapter.getWidgetSecret()).toBe('super-secret')
    expect(JSON.stringify(adapter.getStatus())).not.toContain('super-secret')
  })

  test('validateWidgetSecret accepts the key and rejects anything else', async () => {
    const adapter = new WebChatAdapter()
    await adapter.connect({ widgetSecret: 'super-secret', title: 'Hi' })

    expect(adapter.validateWidgetSecret('super-secret')).toBe(true)
    expect(adapter.validateWidgetSecret('nope')).toBe(false)
    expect(adapter.validateWidgetSecret('')).toBe(false)
  })
})

describe('resolveWebchatWidgetSecret', () => {
  test('keeps an explicit key from the incoming config', () => {
    expect(resolveWebchatWidgetSecret({ widgetSecret: 'incoming' }, { widgetSecret: 'saved' }))
      .toBe('incoming')
  })

  test('keeps the saved key on reconnect so existing embeds keep working', () => {
    expect(resolveWebchatWidgetSecret({}, { widgetSecret: 'saved' })).toBe('saved')
    expect(resolveWebchatWidgetSecret(undefined, { widgetSecret: 'saved' })).toBe('saved')
  })

  test('generates a key when neither side has one', () => {
    const key = resolveWebchatWidgetSecret({}, undefined)
    expect(key).toMatch(UUID_RE)
    expect(resolveWebchatWidgetSecret({}, {})).toMatch(UUID_RE)
  })
})

describe('backfillWebchatWidgetSecret', () => {
  let dir: string
  let configPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sho380-'))
    configPath = join(dir, 'config.json')
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const write = (config: unknown) => writeFileSync(configPath, JSON.stringify(config, null, 2))
  const read = () => JSON.parse(readFileSync(configPath, 'utf-8'))

  test('returns null when there is no config file', () => {
    expect(backfillWebchatWidgetSecret(configPath)).toBeNull()
  })

  test('returns null when there is no webchat channel', () => {
    write({ channels: [{ type: 'telegram', config: { token: 'x' } }] })
    expect(backfillWebchatWidgetSecret(configPath)).toBeNull()
  })

  test('leaves an existing key untouched', () => {
    write({ channels: [{ type: 'webchat', config: { widgetSecret: 'keep-me' } }] })
    expect(backfillWebchatWidgetSecret(configPath)).toBe('keep-me')
    expect(read().channels[0].config.widgetSecret).toBe('keep-me')
  })

  test('generates and persists a key for a channel that has none', () => {
    write({ channels: [{ type: 'webchat', config: { title: 'Hi' } }] })
    const key = backfillWebchatWidgetSecret(configPath)
    expect(key).toMatch(UUID_RE)
    expect(read().channels[0].config.widgetSecret).toBe(key)
    // Stable on the next start.
    expect(backfillWebchatWidgetSecret(configPath)).toBe(key)
  })

  test('creates a config object when the channel entry has none', () => {
    write({ channels: [{ type: 'webchat' }] })
    const key = backfillWebchatWidgetSecret(configPath)
    expect(key).toMatch(UUID_RE)
    expect(read().channels[0].config.widgetSecret).toBe(key)
  })
})
