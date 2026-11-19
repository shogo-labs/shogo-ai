// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The login screen's Terms / Privacy links (SHO-430).
 *
 * `Linking.openURL` failed on the device in App Review and its catch raised the
 * "Couldn't open link" alert — a policy link nobody could read is a Guideline
 * 5.1.1 rejection. The helper must present the page in-app and must never throw
 * into the press handler, whatever the browser module does.
 */

import { afterEach, describe, expect, it, mock } from 'bun:test'

const opened: string[] = []
const linkingOpened: string[] = []
let browserBehaviour: 'ok' | 'throws' = 'ok'

mock.module('expo-web-browser', () => ({
  openBrowserAsync: async (url: string) => {
    opened.push(url)
    if (browserBehaviour === 'throws') throw new Error('no browser to present')
    return { type: 'opened' }
  },
}))

mock.module('react-native', () => ({
  Platform: { OS: 'ios' },
  Linking: {
    openURL: async (url: string) => {
      linkingOpened.push(url)
    },
  },
}))

const { openExternalLink } = await import('../open-external-link')

afterEach(() => {
  opened.length = 0
  linkingOpened.length = 0
  browserBehaviour = 'ok'
})

describe('openExternalLink', () => {
  it('opens the link in the in-app browser, not the system opener', async () => {
    await openExternalLink('https://shogo.ai/privacy')

    expect(opened).toEqual(['https://shogo.ai/privacy'])
    expect(linkingOpened).toEqual([])
  })

  it('falls back to the system browser when the in-app one cannot present', async () => {
    browserBehaviour = 'throws'

    await openExternalLink('https://shogo.ai/terms')

    expect(opened).toEqual(['https://shogo.ai/terms'])
    expect(linkingOpened).toEqual(['https://shogo.ai/terms'])
  })

  it('never throws into the press handler', async () => {
    browserBehaviour = 'throws'

    await expect(openExternalLink('https://shogo.ai/privacy')).resolves.toBeUndefined()
  })
})
