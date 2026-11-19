// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Open a marketing/support link in an in-app browser.
 *
 * The login screen's Terms and Privacy links used `Linking.openURL`, whose
 * failure path was an alert — and on the device in App Review the alert was the
 * only thing that happened, which is a Guideline 5.1.1 rejection risk because
 * the privacy policy never opened (SHO-430). `expo-web-browser` presents the
 * page inside the app (`SFSafariViewController` / Custom Tabs), so there is no
 * hand-off to another app to fail.
 *
 * Never throws and never alerts: the caller is a text link inside a consent
 * notice, and a link that does not open must not interrupt signing in. The
 * system opener is only the last resort, for the case where the in-app browser
 * module has nothing to present.
 */
import * as WebBrowser from 'expo-web-browser'
import { Linking } from 'react-native'

export async function openExternalLink(url: string): Promise<void> {
  try {
    await WebBrowser.openBrowserAsync(url)
    return
  } catch (error) {
    console.warn('[openExternalLink] in-app browser failed', url, error)
  }
  try {
    await Linking.openURL(url)
  } catch (error) {
    console.warn('[openExternalLink] system browser failed', url, error)
  }
}
