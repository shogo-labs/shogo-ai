// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Native setup for incoming huddle calls (see lib/native-call.native.ts).
//
// - iOS: CallKit and the `voip` background mode, so a VoIP push can ring the
//   call screen while the app is closed. react-native-callkeep's own plugin
//   adds the background mode and CallKit; this adds PushKit, which
//   react-native-voip-push-notification does not link itself.
// - Android: the permissions a self-managed calling app needs to show a
//   full-screen incoming call and keep a call running in the background.

const { AndroidConfig, IOSConfig, withInfoPlist, withXcodeProject } = require('expo/config-plugins')

const ANDROID_CALL_PERMISSIONS = [
  'android.permission.MANAGE_OWN_CALLS',
  'android.permission.USE_FULL_SCREEN_INTENT',
  'android.permission.FOREGROUND_SERVICE_PHONE_CALL',
]

function withVoipBackgroundMode(config) {
  return withInfoPlist(config, (config) => {
    const modes = Array.isArray(config.modResults.UIBackgroundModes) ? config.modResults.UIBackgroundModes : []
    if (!modes.includes('voip')) modes.push('voip')
    config.modResults.UIBackgroundModes = modes
    return config
  })
}

function withPushKit(config) {
  return withXcodeProject(config, (config) => {
    const target = IOSConfig.XcodeUtils.getApplicationNativeTarget({
      project: config.modResults,
      projectName: config.modRequest.projectName,
    })
    config.modResults.addFramework('PushKit.framework', { target: target.uuid })
    return config
  })
}

module.exports = function withHuddleCalls(config) {
  config = AndroidConfig.Permissions.withPermissions(config, ANDROID_CALL_PERMISSIONS)
  config = withVoipBackgroundMode(config)
  config = withPushKit(config)
  return config
}
