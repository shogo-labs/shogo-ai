// Keep native Firebase config optional for local development and smoke builds.
// Android release jobs create this gitignored file from the validated Actions
// secret before resolving Expo config; without it, prebuild remains usable.
const { existsSync } = require('node:fs')
const { resolve } = require('node:path')

const expoConfig = require('./app.json').expo
const androidConfig = { ...expoConfig.android }

if (existsSync(resolve(__dirname, 'google-services.json'))) {
  androidConfig.googleServicesFile = './google-services.json'
}

module.exports = {
  ...expoConfig,
  android: androidConfig,
}
