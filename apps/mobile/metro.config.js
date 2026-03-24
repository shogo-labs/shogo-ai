const path = require('path')
const { getDefaultConfig } = require('expo/metro-config')
const { withNativeWind } = require('nativewind/metro')
const { withSentryConfig } = require('@sentry/react-native/metro')

const config = getDefaultConfig(__dirname)

const monorepoRoot = path.resolve(__dirname, '../..')

config.resolver.unstable_enablePackageExports = true
config.resolver.useWatchman = false
config.resolver.blockList = [
  new RegExp(path.resolve(monorepoRoot, 'packages/sdk/examples').replace(/[/\\]/g, '[/\\\\]') + '.*'),
  /\.old-[A-F0-9]+/,
  new RegExp(path.resolve(monorepoRoot, 'tests').replace(/[/\\]/g, '[/\\\\]') + '.*'),
]

const SINGLETON_PACKAGES = [
  'react',
  'react-dom',
  'react-native',
  'react-native-web',
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
  'mobx',
  'mobx-react-lite',
  'mobx-state-tree',
  'react-native-css-interop',
  'nativewind',
]

const singletonPaths = {}
for (const pkg of SINGLETON_PACKAGES) {
  try {
    singletonPaths[pkg] = path.dirname(require.resolve(`${pkg}/package.json`, { paths: [__dirname] }))
  } catch {}
}

const originalResolveRequest = config.resolver.resolveRequest
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (singletonPaths[moduleName]) {
    return context.resolveRequest(
      { ...context, originModulePath: path.join(__dirname, '_virtual.js') },
      moduleName,
      platform,
    )
  }
  if (originalResolveRequest) {
    return originalResolveRequest(context, moduleName, platform)
  }
  return context.resolveRequest(context, moduleName, platform)
}

module.exports = withSentryConfig(withNativeWind(config, { input: './global.css' }))
