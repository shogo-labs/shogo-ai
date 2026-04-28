const { getDefaultConfig } = require('expo/metro-config')

const config = getDefaultConfig(__dirname)

config.resolver = config.resolver || {}
config.resolver.assetExts = [...(config.resolver.assetExts || []), 'glb', 'gltf', 'hdr']
config.resolver.unstable_enablePackageExports = true

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (platform === 'web' && moduleName === '@react-three/fiber/native') {
    return context.resolveRequest(context, '@react-three/fiber', platform)
  }
  return context.resolveRequest(context, moduleName, platform)
}

module.exports = config
