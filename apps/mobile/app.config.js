// Keep native Firebase config optional for local development and smoke builds.
// Android release jobs create this gitignored file from the validated Actions
// secret before resolving Expo config; without it, prebuild remains usable.
const { existsSync } = require('node:fs')
const { resolve } = require('node:path')

const { withSentryProject, withUpdateChannel } = require('./config/expo-env-config')

const expoConfig = require('./app.json').expo
const androidConfig = { ...expoConfig.android }

if (existsSync(resolve(__dirname, 'google-services.json'))) {
  androidConfig.googleServicesFile = './google-services.json'
}

// `EXPO_UPDATES_CHANNEL` (set by the Android/iOS release workflows) pins the
// binary to its own EAS Update branch; `SENTRY_PROJECT` names the Sentry
// project that platform's native uploads belong to. Both are no-ops locally.
const updates = withUpdateChannel(expoConfig.updates, process.env.EXPO_UPDATES_CHANNEL)
const plugins = withSentryProject(expoConfig.plugins, process.env.SENTRY_PROJECT)

module.exports = {
  ...expoConfig,
  android: androidConfig,
  ...(updates ? { updates } : {}),
  ...(plugins ? { plugins } : {}),
}
