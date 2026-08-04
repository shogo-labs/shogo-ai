// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

const {
  AndroidConfig,
  withAppBuildGradle,
  withDangerousMod,
  withGradleProperties,
} = require("expo/config-plugins");
const fs = require("node:fs/promises");
const path = require("node:path");

const R8_PROPERTIES = {
  "android.enableMinifyInReleaseBuilds": "true",
  "android.enableShrinkResourcesInReleaseBuilds": "true",
};

const EXPO_RECORDS_KEEP_RULE =
  "-keep class expo.modules.kotlin.records.** { *; }";
const EXPO_RECORDS_KEEP_BLOCK = [
  "# Expo Modules converts native bridge argument records through Kotlin",
  "# reflection. Optimizing these converter classes breaks SecureStore options.",
  EXPO_RECORDS_KEEP_RULE,
].join("\n");

function withR8GradleProperties(config) {
  return withGradleProperties(config, (config) => {
    for (const [name, value] of Object.entries(R8_PROPERTIES)) {
      AndroidConfig.BuildProperties.updateAndroidBuildProperty(
        config.modResults,
        name,
        value,
      );
    }

    return config;
  });
}

function withOptimizedProguardDefaults(config) {
  return withAppBuildGradle(config, (config) => {
    if (config.modResults.language !== "groovy") {
      throw new Error("withAndroidR8 only supports a Groovy app build.gradle");
    }

    const optimizedDefaults =
      'getDefaultProguardFile("proguard-android-optimize.txt")';

    if (!config.modResults.contents.includes(optimizedDefaults)) {
      const defaultRules = 'getDefaultProguardFile("proguard-android.txt")';

      if (!config.modResults.contents.includes(defaultRules)) {
        throw new Error(
          "Unable to enable optimized R8 defaults: Expo app build.gradle template changed",
        );
      }

      config.modResults.contents = config.modResults.contents.replace(
        defaultRules,
        optimizedDefaults,
      );
    }

    return config;
  });
}

function withR8CompatibilityRules(config) {
  return withDangerousMod(config, [
    "android",
    async (config) => {
      const rulesPath = path.join(
        config.modRequest.platformProjectRoot,
        "app",
        "proguard-rules.pro",
      );
      const rules = await fs.readFile(rulesPath, "utf8");

      if (!rules.includes(EXPO_RECORDS_KEEP_RULE)) {
        await fs.writeFile(
          rulesPath,
          `${rules.trimEnd()}\n\n${EXPO_RECORDS_KEEP_BLOCK}\n`,
        );
      }

      return config;
    },
  ]);
}

function withAndroidR8(config) {
  config = withR8GradleProperties(config);
  config = withOptimizedProguardDefaults(config);
  config = withR8CompatibilityRules(config);
  return config;
}

module.exports = withAndroidR8;
