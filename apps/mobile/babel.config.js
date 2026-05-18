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
      // MUST be last. Without this, react-native-worklets cannot initialize
      // its native binding and any screen that uses Reanimated (chat composer,
      // gestures, animations) throws "Native part of Worklets doesn't seem to
      // be initialized" on first render — which was crashing the in-project
      // chat flow on iPad.
      'react-native-worklets/plugin',
    ],
  }
}
