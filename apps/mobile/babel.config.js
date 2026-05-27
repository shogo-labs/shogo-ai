module.exports = function (api) {
  api.cache(true)
  return {
    presets: [
      ['babel-preset-expo', { jsxImportSource: 'nativewind' }],
      'nativewind/babel',
    ],
    plugins: [
      [
        'module-resolver',
        {
          root: ['./'],
          alias: {
            '@': './',
            'tailwind.config': './tailwind.config.ts',
          },
        },
      ],
      // MUST be last. Pairs with the Metro stubs of
      // `react-native-reanimated` / `react-native-worklets` in
      // `metro.config.js` (see banner there) — together they keep the
      // worklets pipeline self-consistent without the native pod.
      //
      // The babel plugin is what auto-workletizes gesture-handler and
      // reanimated callbacks. With the plugin enabled, the autoworkletized
      // code requires JS-only worklets helpers (`createSerializable`,
      // `runOnJS`, …) from `react-native-worklets`; Metro then redirects
      // those requires to our stub and the helpers become no-ops.
      //
      // Without the plugin, the same callbacks were left referencing the
      // native worklets runtime, which doesn't ship in this binary, and
      // the iPad chat composer threw "Native part of Worklets doesn't seem
      // to be initialized" on first render. Removing this line is only
      // safe in tandem with adding back the real worklets pod.
      'react-native-worklets/plugin',
    ],
  }
}
