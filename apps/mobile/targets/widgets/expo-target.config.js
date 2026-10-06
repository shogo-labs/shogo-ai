/** @type {import('@bacons/apple-targets/app.plugin').ConfigFunction} */
module.exports = (config) => ({
  type: 'widget',
  name: 'ShogoWidgets',
  displayName: 'Shogo',
  // containerBackground and Lock Screen accessories need iOS 17.
  deploymentTarget: '17.0',
  frameworks: ['SwiftUI', 'WidgetKit'],
  colors: {
    $accent: '#FB8C00',
    $widgetBackground: { color: '#16171D', darkColor: '#16171D' },
  },
  entitlements: {
    // The app writes the glance snapshot here; keep in sync with lib/glance-storage.ts.
    'com.apple.security.application-groups':
      config.ios?.entitlements?.['com.apple.security.application-groups'] ?? ['group.ai.shogo.app'],
  },
})
