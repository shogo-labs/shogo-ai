const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config')
const { withNativeWind } = require('nativewind/metro')

const config = {}

module.exports = withNativeWind(mergeConfig(getDefaultConfig(__dirname), config), {
  input: './global.css',
})
