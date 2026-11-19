// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The parts of `app.config.js` that depend on the CI environment.
 *
 * `app.config.js` is loaded by Expo as a plain CommonJS module at prebuild
 * time, so the logic that is worth a unit test lives here instead of in the
 * config object itself.
 */

/**
 * The update channel a binary asks EAS Update for.
 *
 * expo-updates has exactly one way to know it: the `expo-channel-name` request
 * header baked into the native manifest at prebuild (`UpdatesConfiguration`
 * reads `requestHeaders["expo-channel-name"]` on Android, `AppController` the
 * same key on iOS). The Android and iOS release workflows have always exported
 * `EXPO_UPDATES_CHANNEL` for `expo prebuild`, but nothing anywhere consumed
 * that variable — so every locally prebuilt binary (that is, every release
 * build in this repo) shipped with no channel at all and could not be pinned
 * to its own update branch.
 */
const UPDATE_CHANNEL_HEADER = 'expo-channel-name'

/** `updates` with the channel header added, or `updates` untouched when no channel is set. */
function withUpdateChannel(updates, channel) {
  const name = typeof channel === 'string' ? channel.trim() : ''
  if (!name) return updates
  return {
    ...updates,
    requestHeaders: {
      ...(updates && updates.requestHeaders ? updates.requestHeaders : {}),
      [UPDATE_CHANNEL_HEADER]: name,
    },
  }
}

/**
 * Point the Sentry Expo plugin at the project this platform's DSN reports to.
 *
 * The plugin only takes a single `project`, and `app.json` had it pinned to
 * `shogo-ios`; an Android build's Sentry Gradle integration would therefore
 * have uploaded its artifacts to the iOS project, where events from the
 * Android DSN (`shogo-android`) can never find them. Each workflow passes the
 * right one; with no value the plugin entry is left exactly as it is.
 */
function withSentryProject(plugins, project) {
  const name = typeof project === 'string' ? project.trim() : ''
  if (!name || !Array.isArray(plugins)) return plugins
  return plugins.map((entry) => {
    const plugin = Array.isArray(entry) ? entry[0] : entry
    if (plugin !== '@sentry/react-native/expo') return entry
    const options = Array.isArray(entry) && entry[1] && typeof entry[1] === 'object' ? entry[1] : {}
    return [plugin, { ...options, project: name }]
  })
}

module.exports = {
  UPDATE_CHANNEL_HEADER,
  withUpdateChannel,
  withSentryProject,
}
