// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * react-native-iap is only used on iOS (lib/iap.ts requires it behind a
 * Platform.OS === 'ios' check). Its Android module pulls in Play Billing
 * Library 7, which Google Play now rejects, so it is not linked on Android.
 */
module.exports = {
  dependencies: {
    'react-native-iap': {
      platforms: {
        android: null,
      },
    },
  },
}
