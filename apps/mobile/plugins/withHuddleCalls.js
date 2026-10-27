// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Native setup for incoming huddle calls (see lib/native-call.native.ts).
//
// - iOS: CallKit and the `voip` background mode, so a VoIP push can ring the
//   call screen while the app is closed. react-native-callkeep's own plugin
//   adds CallKit; this links PushKit and forwards its AppDelegate callbacks
//   to react-native-voip-push-notification.
// - Android: the permissions a self-managed calling app needs to show a
//   full-screen incoming call and keep a call running in the background.

const fs = require('node:fs/promises')
const path = require('node:path')
const { AndroidConfig, IOSConfig, withAppDelegate, withDangerousMod, withInfoPlist, withXcodeProject } = require('expo/config-plugins')

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

function withPushKitAppDelegate(config) {
  return withAppDelegate(config, (config) => {
    const appDelegate = config.modResults
    if (appDelegate.language !== 'swift') {
      throw new Error('withHuddleCalls requires a Swift AppDelegate for PushKit callbacks')
    }

    let contents = appDelegate.contents
    if (!/^import PushKit$/m.test(contents)) {
      if (!/^import React\s*$/m.test(contents)) {
        throw new Error('withHuddleCalls could not add the PushKit import to AppDelegate.swift')
      }
      contents = contents.replace(/^import React\s*$/m, (line) => `${line}\nimport PushKit`)
    }

    const marker = '// shogo: PushKit delegate callbacks'
    if (!contents.includes(marker)) {
      contents = `${contents.trimEnd()}\n\n${marker}
extension AppDelegate: PKPushRegistryDelegate {
  public func pushRegistry(
    _ registry: PKPushRegistry,
    didUpdate credentials: PKPushCredentials,
    for type: PKPushType
  ) {
    RNVoipPushNotificationManager.didUpdate(credentials, forType: type.rawValue)
  }

  public func pushRegistry(_ registry: PKPushRegistry, didInvalidatePushTokenFor type: PKPushType) {
    // The next registration reports the replacement token to the app.
  }

  public func pushRegistry(
    _ registry: PKPushRegistry,
    didReceiveIncomingPushWith payload: PKPushPayload,
    for type: PKPushType,
    completion: @escaping () -> Void
  ) {
    let completionId = payload.dictionaryPayload["huddleId"] as? String ?? ""
    RNVoipPushNotificationManager.addCompletionHandler(completionId, completionHandler: completion)
    RNVoipPushNotificationManager.didReceiveIncomingPush(with: payload, forType: type.rawValue)
  }
}
`
    }

    appDelegate.contents = contents
    return config
  })
}

function withVoipPushNotificationBridgingHeader(config) {
  return withDangerousMod(config, ['ios', async (config) => {
    const projectName = config.modRequest.projectName
    const bridgingHeaderPath = path.join(
      config.modRequest.platformProjectRoot,
      projectName,
      `${projectName}-Bridging-Header.h`,
    )
    let contents = await fs.readFile(bridgingHeaderPath, 'utf8')
    const importStatement = '#import <RNVoipPushNotification/RNVoipPushNotificationManager.h>'
    if (!contents.includes(importStatement)) {
      contents = `${contents.trimEnd()}\n\n${importStatement}\n`
      await fs.writeFile(bridgingHeaderPath, contents)
    }
    return config
  }])
}

module.exports = function withHuddleCalls(config) {
  config = AndroidConfig.Permissions.withPermissions(config, ANDROID_CALL_PERMISSIONS)
  config = withVoipBackgroundMode(config)
  config = withPushKit(config)
  config = withPushKitAppDelegate(config)
  config = withVoipPushNotificationBridgingHeader(config)
  return config
}
