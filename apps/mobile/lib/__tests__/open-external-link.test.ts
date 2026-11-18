// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The one way this app hands a URL to something outside itself (SHO-436).
 *
 * Two Sentry crashes came from `Linking.openURL` rejecting with nobody
 * listening: a `data:` URL (Android: `Could not open URL 'data:…'`) and a
 * `tel:` on a device with no dialer (`ActivityNotFoundException`). The helper
 * must refuse what no opener can launch, route `tel:`/`mailto:` to the system
 * opener instead of a browser, and never throw into a press handler.
 */

import { afterEach, describe, expect, it, mock } from 'bun:test'

const browserOpened: string[] = []
const systemOpened: string[] = []
const alerts: Array<{ title: string; message?: string }> = []
let browserBehaviour: 'ok' | 'throws' = 'ok'
let systemBehaviour: 'ok' | 'throws' = 'ok'

mock.module('expo-web-browser', () => ({
  openBrowserAsync: async (url: string) => {
    browserOpened.push(url)
    if (browserBehaviour === 'throws') throw new Error('no browser to present')
    return { type: 'opened' }
  },
}))

mock.module('react-native', () => ({
  Platform: { OS: 'android' },
  Alert: {
    alert: (title: string, message?: string) => {
      alerts.push({ title, message })
    },
  },
  Linking: {
    openURL: async (url: string) => {
      systemOpened.push(url)
      if (systemBehaviour === 'throws') {
        throw new Error(`Could not open URL '${url}': ActivityNotFoundException`)
      }
    },
  },
}))

const { isOpenableUrl, openExternalLink } = await import('../open-external-link')

afterEach(() => {
  browserOpened.length = 0
  systemOpened.length = 0
  alerts.length = 0
  browserBehaviour = 'ok'
  systemBehaviour = 'ok'
})

describe('openExternalLink', () => {
  it('opens an http link in the in-app browser, not the system opener', async () => {
    await openExternalLink('https://shogo.ai/privacy')

    expect(browserOpened).toEqual(['https://shogo.ai/privacy'])
    expect(systemOpened).toEqual([])
  })

  it('falls back to the system browser when the in-app one cannot present', async () => {
    browserBehaviour = 'throws'

    await openExternalLink('https://shogo.ai/terms')

    expect(browserOpened).toEqual(['https://shogo.ai/terms'])
    expect(systemOpened).toEqual(['https://shogo.ai/terms'])
  })

  it('never throws into the press handler', async () => {
    browserBehaviour = 'throws'
    systemBehaviour = 'throws'

    await expect(openExternalLink('https://shogo.ai/privacy')).resolves.toBeUndefined()
  })

  it('refuses a data: URL instead of handing it to Android', async () => {
    const dataUrl = 'data:text/markdown;base64,IyBIaQ=='

    await openExternalLink(dataUrl)

    expect(browserOpened).toEqual([])
    expect(systemOpened).toEqual([])
    expect(alerts).toHaveLength(1)
  })

  it('sends tel: straight to the system opener, never to a browser', async () => {
    await openExternalLink('tel:+15551234567')

    expect(browserOpened).toEqual([])
    expect(systemOpened).toEqual(['tel:+15551234567'])
  })

  it('catches a dialer that does not exist and tells the person', async () => {
    systemBehaviour = 'throws'

    await expect(openExternalLink('tel:+15551234567')).resolves.toBeUndefined()

    expect(alerts).toHaveLength(1)
    expect(alerts[0]!.message).toContain('call')
  })

  it('reports nothing when the caller asked for silence', async () => {
    systemBehaviour = 'throws'

    await openExternalLink('tel:+15551234567', { silent: true })

    expect(alerts).toEqual([])
  })
})

describe('isOpenableUrl', () => {
  it('accepts addresses an opener can launch', () => {
    for (const url of ['https://shogo.ai', 'http://localhost:3000', 'tel:+15551234567', 'mailto:a@b.co']) {
      expect(isOpenableUrl(url)).toBe(true)
    }
  })

  it('rejects content and script schemes', () => {
    for (const url of [
      'data:text/markdown;base64,IyBIaQ==',
      'javascript:alert(1)',
      'vbscript:msgbox(1)',
      'blob:https://shogo.ai/1234',
      '',
      '   ',
    ]) {
      expect(isOpenableUrl(url)).toBe(false)
    }
  })
})
