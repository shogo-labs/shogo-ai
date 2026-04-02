// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

const { withAndroidManifest } = require('expo/config-plugins');

const MLKIT_ACTIVITY =
  'com.google.mlkit.vision.codescanner.internal.GmsBarcodeScanningDelegateActivity';

/**
 * Expo Config Plugin that removes hard-coded screenOrientation="portrait"
 * from third-party library activities in AndroidManifest.xml.
 *
 * Android 16 ignores orientation restrictions on large-screen devices, so
 * keeping them triggers Play Console warnings without providing real benefit.
 */
function withRemoveOrientationLocks(config) {
  return withAndroidManifest(config, (config) => {
    const manifest = config.modResults;

    manifest.manifest.$['xmlns:tools'] =
      'http://schemas.android.com/tools';

    const application = manifest.manifest.application?.[0];
    if (!application) return config;

    if (!application.activity) {
      application.activity = [];
    }

    const existing = application.activity.find(
      (a) => a.$?.['android:name'] === MLKIT_ACTIVITY,
    );

    if (existing) {
      existing.$['android:screenOrientation'] = 'unspecified';
      existing.$['tools:replace'] = 'android:screenOrientation';
    } else {
      application.activity.push({
        $: {
          'android:name': MLKIT_ACTIVITY,
          'android:screenOrientation': 'unspecified',
          'tools:replace': 'android:screenOrientation',
        },
      });
    }

    return config;
  });
}

module.exports = withRemoveOrientationLocks;
