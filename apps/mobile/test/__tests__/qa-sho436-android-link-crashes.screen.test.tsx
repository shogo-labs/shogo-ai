// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-436 acceptance: the two Android crash reports, reproduced exactly.
 *
 * SHOGO-ANDROID-1D — a pasted markdown block travels through chat as a
 * `data:text/markdown;base64,…` attachment; handing that to `Linking.openURL`
 * throws `Could not open URL 'data:…'`.
 * SHOGO-ANDROID-10 — a `tel:` intent on a device with no dialer throws
 * `Unable to find explicit activity class {com.android.server.telecom/…}`.
 *
 * Written by QA from the card's acceptance criteria, independently of the
 * developer's tests. The payload is built by the real producer
 * (`pastedEntryToAttachment`, which `long-text-utils` uses for every paste),
 * and the `Linking` mock rejects with the strings from the two Sentry issues,
 * so a path that still hands the URL to the OS fails here instead of passing.
 */

import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** Every URL handed to the OS, with what Android would have done with it. */
const systemOpened: string[] = []
const alerts: Array<{ title: string; message?: string }> = []
const browserOpened: string[] = []
const fetched: string[] = []
const realFetch = globalThis.fetch

// The app's auth client pings on import; keep that off the network.
globalThis.fetch = (async (input: unknown) => {
  fetched.push(String(input))
  return { ok: false, status: 401, headers: new Map(), text: async () => '' } as unknown as Response
}) as typeof fetch

mock.module('expo-web-browser', () => ({
  openBrowserAsync: async (url: string) => {
    browserOpened.push(url)
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
  // What Android did with each URL in the two reports.
  Linking: {
    openURL: async (url: string) => {
      if (/^data:/i.test(url)) {
        throw new Error(`Could not open URL '${url}': No Activity found to handle Intent`)
      }
      if (/^tel:/i.test(url)) {
        throw new Error(
          'Unable to find explicit activity class {com.android.server.telecom/com.android.server.telecom.components.TelecomActivity}; have you declared this activity in your AndroidManifest.xml?',
        )
      }
      systemOpened.push(url)
    },
  },
}))

const { openExternalLink } = await import('../../lib/open-external-link')
const { decodeDataUrlText } = await import('../../lib/data-url')
const { analyzeContent, pastedEntryToAttachment } = await import(
  '../../components/chat/long-text-utils'
)

afterEach(() => {
  systemOpened.length = 0
  alerts.length = 0
  browserOpened.length = 0
  fetched.length = 0
})

afterAll(() => {
  globalThis.fetch = realFetch
})

/** The attachment the composer really builds for a long paste. */
function pastedAttachment(content: string) {
  return pastedEntryToAttachment({
    id: 'paste-1',
    content,
    info: analyzeContent(content),
  })
}

describe('AC1 — a data: attachment is content, never an address', () => {
  test('the URL the composer builds decodes back to the pasted text', () => {
    const content = '# Pasted notes\n\n- first\n- second\n\nÜnïcode & ✓\n'.repeat(30)
    const attachment = pastedAttachment(content)

    expect(attachment.type).toBe('text/markdown')
    expect(attachment.dataUrl.startsWith('data:text/markdown;base64,')).toBe(true)

    // This is what the in-app viewer shows: the file itself, decoded locally.
    const decoded = decodeDataUrlText(attachment.dataUrl)
    expect(decoded?.mediaType).toBe('text/markdown')
    expect(decoded?.text).toBe(content)
  })

  test('a JSON paste decodes too — the same chip path, one rule', () => {
    const content = JSON.stringify({ ticket: 'SHO-436', ok: true }, null, 2).repeat(40)
    const attachment = pastedAttachment(content)

    expect(attachment.type).toBe('application/json')
    expect(decodeDataUrlText(attachment.dataUrl)?.text).toBe(content)
  })

  test('the opener refuses it: no OS call, no browser, the person is told once', async () => {
    const attachment = pastedAttachment('# notes\n\n'.repeat(40))

    await expect(openExternalLink(attachment.dataUrl)).resolves.toBeUndefined()

    expect(browserOpened).toEqual([])
    expect(systemOpened).toEqual([])
    expect(alerts).toHaveLength(1)
  })
})

describe('AC2 — a tel: link with no dialer does not crash the app', () => {
  test('the ActivityNotFoundException is caught and the person is told', async () => {
    // Resolving rather than rejecting is the fix: an unhandled rejection on a
    // press handler is the native crash report.
    await expect(openExternalLink('tel:+15551234567')).resolves.toBeUndefined()

    // A browser cannot place a call, so the URL goes straight to the OS.
    expect(browserOpened).toEqual([])
    expect(alerts).toHaveLength(1)
    expect(alerts[0]?.message).toContain('call')
  })

  test('mailto: and sms: take the same guarded route, never a browser', async () => {
    await openExternalLink('mailto:sales@shogo.ai')
    await openExternalLink('sms:+15551234567')

    expect(browserOpened).toEqual([])
    expect(systemOpened).toEqual(['mailto:sales@shogo.ai', 'sms:+15551234567'])
  })
})

describe('AC1/AC2 — nothing in the app hands a URL to the OS behind the helper', () => {
  function sourceFiles(dir: string, acc: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === '__tests__' || name.startsWith('.')) continue
      const path = join(dir, name)
      if (statSync(path).isDirectory()) {
        sourceFiles(path, acc)
        continue
      }
      if (/\.(tsx|ts|jsx|js)$/.test(name) && !/\.test\.|\.spec\./.test(name)) acc.push(path)
    }
    return acc
  }

  test('only lib/open-external-link.ts calls Linking.openURL', () => {
    const mobileRoot = resolve(import.meta.dir, '../..')
    const allowed = join('lib', 'open-external-link.ts')
    const hits: string[] = []

    for (const root of ['app', 'components', 'lib', 'hooks', 'contexts', 'stubs']) {
      for (const file of sourceFiles(join(mobileRoot, root))) {
        const relative = file.slice(mobileRoot.length + 1)
        if (relative === allowed) continue
        if (/\bLinking\.openURL\s*\(/.test(readFileSync(file, 'utf8'))) hits.push(relative)
      }
    }

    expect(hits).toEqual([])
  })
})
