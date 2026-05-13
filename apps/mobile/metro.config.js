const path = require('path')
const { getDefaultConfig } = require('expo/metro-config')
const { withNativeWind } = require('nativewind/metro')
const config = getDefaultConfig(__dirname)

const monorepoRoot = path.resolve(__dirname, '../..')

config.watchFolders = [
  path.resolve(monorepoRoot, 'packages'),
  path.resolve(monorepoRoot, 'node_modules'),
]

config.resolver.unstable_enablePackageExports = true
config.resolver.useWatchman = false

// HMR opt-in for monorepo workspace packages.
//
// `@shogo-ai/sdk` ships compiled JS in `dist/` for npm consumers, but
// for in-monorepo development we want Metro to resolve directly to
// the SDK's TypeScript source so edits hot-reload without a tsup
// rebuild. The mechanism is:
//
//   1. The SDK's package.json declares `"development": "./src/.../index.ts"`
//      alongside `"import"`/`"require"` for every subpath export.
//   2. We add `'development'` to Metro's `unstable_conditionNames`
//      (gated by NODE_ENV so production exports of the mobile app
//      still resolve to `dist/`).
//   3. We add `'ts'`/`'tsx'` to `sourceExts` so Metro's transformer
//      accepts the resolved source files.
//
// The gating matters: Metro production builds (Expo prod export,
// EAS Build) set NODE_ENV=production, where we explicitly DO NOT
// want the dev source path active — production should always ship
// the audited `dist/` build. Local development, simulator runs, and
// EAS dev builds all run with NODE_ENV !== 'production' and benefit
// from instant SDK updates.
const enableSdkSourceHmr = process.env.NODE_ENV !== 'production'
if (enableSdkSourceHmr) {
  const existingConditions = config.resolver.unstable_conditionNames || []
  config.resolver.unstable_conditionNames = Array.from(
    new Set([...existingConditions, 'development']),
  )
  const existingSourceExts = config.resolver.sourceExts || []
  config.resolver.sourceExts = Array.from(
    new Set([...existingSourceExts, 'ts', 'tsx']),
  )
}
config.resolver.blockList = [
  new RegExp(path.resolve(monorepoRoot, 'packages/sdk/examples').replace(/[/\\]/g, '[/\\\\]') + '.*'),
  /\.old-[A-F0-9]+/,
  new RegExp(path.resolve(monorepoRoot, 'tests').replace(/[/\\]/g, '[/\\\\]') + '.*'),
  new RegExp(path.resolve(monorepoRoot, 'workspaces').replace(/[/\\]/g, '[/\\\\]') + '.*'),
  new RegExp(path.resolve(monorepoRoot, 'templates/runtime-template/node_modules').replace(/[/\\]/g, '[/\\\\]') + '.*'),
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

// SDK source files use `.js` extensions in their relative imports
// (e.g. `import './foo.js'` from a `.ts` file) — that's the standard
// TypeScript NodeNext pattern so the emitted `dist/*.js` references
// each other correctly. Bun and `tsc` auto-rewrite `.js` -> `.ts`/`.tsx`
// at resolution time; Metro by default takes the extension literally
// and ENOENTs.
//
// When SDK source HMR is active and the request originates from inside
// `packages/sdk/src/`, retry a trailing `.js` as `.ts` then `.tsx`.
// We bound the rewrite by origin path so workspace code that genuinely
// imports `.js` siblings is unaffected.
const SDK_SRC_FRAGMENT = `${path.sep}packages${path.sep}sdk${path.sep}src${path.sep}`

function resolveSdkSourceJsAsTs(context, moduleName, platform) {
  if (!enableSdkSourceHmr) return null
  if (!moduleName.endsWith('.js')) return null
  if (!moduleName.startsWith('./') && !moduleName.startsWith('../')) return null
  const origin = context.originModulePath
  if (!origin || !origin.includes(SDK_SRC_FRAGMENT)) return null
  const stem = moduleName.slice(0, -3)
  for (const ext of ['.ts', '.tsx']) {
    try {
      return context.resolveRequest(context, stem + ext, platform)
    } catch {
      // fall through to next extension
    }
  }
  return null
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
  const sdkSrcMatch = resolveSdkSourceJsAsTs(context, moduleName, platform)
  if (sdkSrcMatch) return sdkSrcMatch
  if (originalResolveRequest) {
    return originalResolveRequest(context, moduleName, platform)
  }
  return context.resolveRequest(context, moduleName, platform)
}

module.exports = withNativeWind(config, { input: './global.css' })
