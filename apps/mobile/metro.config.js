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

// =====================================================================
// Reanimated / Worklets stub aliases (App Review hotfix — May 2026)
// =====================================================================
// The iOS Podfile (and Android autolinking) deliberately omit
// `react-native-reanimated` and `react-native-worklets`:
//
//     // apps/mobile/package.json
//     "expo": { "autolinking": { "exclude": [
//        "react-native-reanimated", "react-native-worklets"
//     ] } }
//
// + `app.json` has `newArchEnabled: false`, which Reanimated 4 / Worklets
// require. The native binding does not ship in the production binary.
//
// However NativeWind ⇒ `react-native-css-interop@0.2.x` issues an
// unconditional `require('react-native-reanimated')` whenever any styled
// component carries a `transition-*` / `animate-*` / `duration-*` class
// (hundreds of components do — chat composer, billing cards, project
// shell, etc.). Without a real module to resolve to, the destructured
// top-level statement
//
//     const { makeMutable, withTiming, … } = require('react-native-reanimated')
//
// resolved to `undefined` inside the Hermes/iOS bundle and the renderer
// crashed with `TypeError: Cannot read property 'makeMutable' of
// undefined`. This is exactly the App Store / TestFlight crash users
// reported on build 1.0.8 (run id 26500877669).
//
// Aliasing both packages to JS-only no-op shims in `./stubs/` keeps the
// `require()` resolvable, returns safe no-op exports for every entry
// point css-interop / gesture-handler / screens probe at runtime, and
// — critically — adds no native dependency. Animations become instant
// (acceptable for non-essential UI flair), nothing crashes, and we keep
// the binary footprint and architecture posture we shipped with.
//
// If/when we want real Reanimated, the fix is bigger than removing this
// alias: flip `newArchEnabled` to true, install both packages as direct
// deps of apps/mobile, drop them from `autolinking.exclude`, regenerate
// the Podfile/manifest, and run the full RN-newarch migration. Until
// then, this alias is the canonical path.
const REANIMATED_STUB = path.resolve(__dirname, 'stubs/react-native-reanimated.js')
const WORKLETS_STUB = path.resolve(__dirname, 'stubs/react-native-worklets.js')
const EXPO_MODULES_CORE_JS_LOGGER_STUB = path.resolve(
  __dirname,
  'stubs/expo-modules-core-native-js-logger.js',
)

function resolveStubFor(context, moduleName) {
  if (moduleName === 'react-native-reanimated') return REANIMATED_STUB
  if (moduleName === 'react-native-worklets') return WORKLETS_STUB
  // Subpath imports like `react-native-reanimated/lib/...` — fall through
  // to the stub for parity, since we want every reanimated re-export to
  // hit the same noop surface.
  if (moduleName.startsWith('react-native-reanimated/')) return REANIMATED_STUB
  if (moduleName.startsWith('react-native-worklets/')) {
    // Two carve-outs to leave intact:
    //
    // 1. `react-native-worklets/plugin` — the Babel transform; pulled in
    //    from `babel.config.js` via Node's `require()` at *build* time.
    //    Metro never sees it, but for completeness don't stub it either.
    // 2. `react-native-worklets/__generatedWorklets/<hash>.js` — factory
    //    files the Babel plugin emits to disk inside the worklets package
    //    when it autoworkletizes a function. If we redirected these to
    //    the stub, the generated `default(...)` factory call would land
    //    on a plain object and throw. Letting them resolve normally is
    //    safe because each generated factory only imports JS-side helpers
    //    from `react-native-worklets`, which themselves go through this
    //    alias and end up at the stub.
    if (moduleName === 'react-native-worklets/plugin') return null
    if (moduleName.startsWith('react-native-worklets/__generatedWorklets/')) return null
    return WORKLETS_STUB
  }
  if (
    moduleName === './NativeJSLogger' &&
    context?.originModulePath?.includes(`${path.sep}expo-modules-core${path.sep}src${path.sep}sweet${path.sep}`)
  ) {
    return EXPO_MODULES_CORE_JS_LOGGER_STUB
  }
  return null
}

// Shogo source files use `.js` extensions in their relative imports
// (e.g. `import './foo.js'` from a `.ts` file) — that's the standard
// TypeScript NodeNext pattern so the emitted `dist/*.js` references
// each other correctly. Bun and `tsc` auto-rewrite `.js` -> `.ts`/`.tsx`
// at resolution time; Metro by default takes the extension literally
// and ENOENTs.
//
// When source HMR is active and the request originates from inside any
// `packages/<pkg>/src/` directory we own, retry a trailing `.js` as
// `.ts` then `.tsx`. We bound the rewrite by origin path so workspace
// code that genuinely imports `.js` siblings is unaffected.
const SHOGO_SOURCE_PACKAGES = ['sdk', 'core', 'agent', 'db', 'email', 'voice', 'cli']
const SHOGO_SRC_FRAGMENTS = SHOGO_SOURCE_PACKAGES.map(
  (pkg) => `${path.sep}packages${path.sep}${pkg}${path.sep}src${path.sep}`,
)

function isShogoSourceOrigin(origin) {
  if (!origin) return false
  return SHOGO_SRC_FRAGMENTS.some((fragment) => origin.includes(fragment))
}

function resolveSdkSourceJsAsTs(context, moduleName, platform) {
  if (!enableSdkSourceHmr) return null
  if (!moduleName.endsWith('.js')) return null
  if (!moduleName.startsWith('./') && !moduleName.startsWith('../')) return null
  if (!isShogoSourceOrigin(context.originModulePath)) return null
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
  // Redirect Reanimated / Worklets requires to JS-only stubs since the
  // native pods aren't part of this build (see banner above).
  const stub = resolveStubFor(context, moduleName)
  if (stub) {
    return { type: 'sourceFile', filePath: stub }
  }
  const sdkSrcMatch = resolveSdkSourceJsAsTs(context, moduleName, platform)
  if (sdkSrcMatch) return sdkSrcMatch
  if (originalResolveRequest) {
    return originalResolveRequest(context, moduleName, platform)
  }
  return context.resolveRequest(context, moduleName, platform)
}

module.exports = withNativeWind(config, { input: './global.css' })
