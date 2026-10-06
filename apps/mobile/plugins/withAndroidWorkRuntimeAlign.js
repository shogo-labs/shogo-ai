// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// react-native-android-widget pulls androidx.work:work-runtime-ktx 2.7.1 while
// other libraries use work-runtime 2.8.x. From 2.8 the Kotlin extensions live
// in work-runtime itself, so the old ktx artifact duplicates its classes and
// fails `checkReleaseDuplicateClasses`. Aligning ktx to 2.8.1 (an empty shim
// that points at work-runtime) removes the duplicates.

const { withAppBuildGradle } = require('expo/config-plugins');

const MARKER = '// shogo: align androidx.work';
const BLOCK = `
${MARKER}
configurations.all {
    resolutionStrategy {
        force "androidx.work:work-runtime-ktx:2.8.1"
        force "androidx.work:work-runtime:2.8.1"
    }
}
`;

module.exports = function withAndroidWorkRuntimeAlign(config) {
  return withAppBuildGradle(config, (config) => {
    if (!config.modResults.contents.includes(MARKER)) {
      config.modResults.contents += BLOCK;
    }
    return config;
  });
};
