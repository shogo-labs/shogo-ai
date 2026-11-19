// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Pins the wiring of the login screen's Terms / Privacy links (SHO-430).
 *
 * `ConsentNotice`/the native panel can only render inside a full RN tree (the
 * module loads `require()`d hero artwork at import time), so the behaviour is
 * tested where it lives: `lib/open-external-link` for the opener itself, and
 * here for the two ends that have to stay connected for it to be used at all —
 * the screen handing it to `LoginScreen`, and the screen calling it instead of
 * `Linking.openURL` + alert.
 */

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'

const signInScreen = readFileSync(
  new URL('../../app/(auth)/sign-in.tsx', import.meta.url),
  'utf8',
)
const loginScreen = readFileSync(
  new URL('../../../../packages/shared-ui/src/screens/LoginScreen.tsx', import.meta.url),
  'utf8',
)

describe('login screen consent links', () => {
  it('hands the in-app browser opener to LoginScreen', () => {
    expect(signInScreen).toContain("import { openExternalLink } from '../../lib/open-external-link'")
    expect(signInScreen).toContain('onOpenExternalLink={openExternalLink}')
  })

  it('routes both consent links through the injected opener', () => {
    expect(loginScreen).toContain('onPress={() => openLink(PRIVACY_URL)}')
    expect(loginScreen).toContain('onPress={() => openLink(TERMS_URL)}')
  })

  it('no longer alerts when a link cannot be opened', () => {
    expect(loginScreen).not.toContain(`RNAlert.alert("Couldn't open link", url)`)
  })

  it('opens a browser tab where no in-app browser is available', () => {
    expect(loginScreen).toContain("window.open(url, '_blank', 'noopener,noreferrer')")
  })
})
