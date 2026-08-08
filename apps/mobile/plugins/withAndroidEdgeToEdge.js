// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

const fs = require('node:fs');
const path = require('node:path');
const {
  AndroidConfig,
  withAndroidStyles,
  withAppBuildGradle,
  withGradleProperties,
  withProjectBuildGradle,
} = require('expo/config-plugins');

const MATERIAL_DEPENDENCY =
  'implementation("com.google.android.material:material:1.14.0")';
const EDGE_TO_EDGE_INSTRUMENTATION_MARKER =
  'abstract class ShogoEdgeToEdgeVisitorFactory';

function upsertGradleProperty(properties, key, value) {
  const existing = properties.find(
    (property) => property.type === 'property' && property.key === key,
  );

  if (existing) {
    existing.value = value;
  } else {
    properties.push({ type: 'property', key, value });
  }
}

function removeGradleProperty(properties, key) {
  return properties.filter(
    (property) => !(property.type === 'property' && property.key === key),
  );
}

function withEdgeToEdgeProperties(config) {
  return withGradleProperties(config, (config) => {
    let properties = removeGradleProperty(
      config.modResults,
      'expo.edgeToEdgeEnabled',
    );

    upsertGradleProperty(properties, 'edgeToEdgeEnabled', 'true');

    config.modResults = properties;
    return config;
  });
}

function withCurrentMaterial(config) {
  return withAppBuildGradle(config, (config) => {
    if (config.modResults.language !== 'groovy') return config;

    if (!config.modResults.contents.includes(MATERIAL_DEPENDENCY)) {
      config.modResults.contents = config.modResults.contents.replace(
        /dependencies\s*\{/,
        `dependencies {\n    // Material 1.14 guards legacy system-bar APIs on pre-Android 15 devices.\n    ${MATERIAL_DEPENDENCY}`,
      );
    }

    return config;
  });
}

function withEdgeToEdgeInstrumentation(config) {
  return withProjectBuildGradle(config, (config) => {
    if (config.modResults.language !== 'groovy') return config;
    if (
      config.modResults.contents.includes(EDGE_TO_EDGE_INSTRUMENTATION_MARKER)
    ) {
      return config;
    }

    const instrumentation = fs.readFileSync(
      path.join(__dirname, 'android', 'edge-to-edge.gradle'),
      'utf8',
    );
    config.modResults.contents = config.modResults.contents.replace(
      /\nallprojects\s*\{/,
      `\n\n${instrumentation.trim()}\n\nallprojects {`,
    );
    return config;
  });
}

function withEdgeToEdgeTheme(config) {
  return withAndroidStyles(config, (config) => {
    const parent = AndroidConfig.Styles.getAppThemeGroup();

    config.modResults = AndroidConfig.Styles.assignStylesValue(
      config.modResults,
      {
        add: false,
        name: 'android:statusBarColor',
        parent,
        value: '',
      },
    );
    config.modResults = AndroidConfig.Styles.assignStylesValue(
      config.modResults,
      {
        add: true,
        name: 'android:windowLayoutInDisplayCutoutMode',
        parent,
        value: 'always',
      },
    );

    return config;
  });
}

/**
 * Keeps generated Android projects aligned with Android 15+ edge-to-edge rules.
 * The native directory is generated/ignored, so these changes must be applied
 * through a config plugin to affect local prebuilds and EAS store builds.
 */
function withAndroidEdgeToEdge(config) {
  config = withEdgeToEdgeProperties(config);
  config = withCurrentMaterial(config);
  config = withEdgeToEdgeInstrumentation(config);
  config = withEdgeToEdgeTheme(config);
  return config;
}

module.exports = withAndroidEdgeToEdge;
