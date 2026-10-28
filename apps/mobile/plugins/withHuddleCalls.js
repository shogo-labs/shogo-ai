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
    if (!/^import RNCallKeep$/m.test(contents)) {
      contents = contents.replace(/^import PushKit\s*$/m, (line) => `${line}\nimport RNCallKeep`)
    }

    const marker = '// shogo: PushKit delegate callbacks'
    const callbacks = `${marker}
extension AppDelegate: PKPushRegistryDelegate {
  // Swift shortens the Objective-C manager selectors when importing them:
  // didUpdatePushCredentials:forType: becomes didUpdate(_:forType:), and
  // didReceiveIncomingPushWithPayload:forType: becomes didReceiveIncomingPush(with:forType:).
  public func pushRegistry(
    _ registry: PKPushRegistry,
    didUpdate credentials: PKPushCredentials,
    for type: PKPushType
  ) {
    RNVoipPushNotificationManager.didUpdate(credentials, forType: type.rawValue)
  }

  public func pushRegistry(_ registry: PKPushRegistry, didInvalidatePushTokenFor type: PKPushType) {
    RNVoipPushNotificationManager.didInvalidatePushToken()
  }

  public func pushRegistry(
    _ registry: PKPushRegistry,
    didReceiveIncomingPushWith payload: PKPushPayload,
    for type: PKPushType,
    completion: @escaping () -> Void
  ) {
    let data = payload.dictionaryPayload
    let huddleId = data["huddleId"] as? String ?? ""
    let huddleUUID = UUID(uuidString: huddleId)
    let callUUID = huddleUUID?.uuidString.lowercased() ?? UUID().uuidString.lowercased()
    let caller = data["from"] as? [String: Any]
    let callerName = caller?["name"] as? String ?? data["callerName"] as? String ?? "Someone"
    let callerHandle = caller?["userId"] as? String ?? data["callerId"] as? String ?? callerName
    let hasRingContext = huddleUUID != nil
      && !(data["conversationId"] as? String ?? "").isEmpty
      && !(data["workspaceId"] as? String ?? "").isEmpty

    // CallKit must be notified from the PushKit callback itself. Waiting for
    // the React Native bridge can miss Apple's reporting deadline on cold launch.
    RNCallKeep.reportNewIncomingCall(
      callUUID,
      handle: callerHandle,
      handleType: "generic",
      hasVideo: false,
      localizedCallerName: callerName,
      supportsHolding: true,
      supportsDTMF: true,
      supportsGrouping: false,
      supportsUngrouping: false,
      fromPushKit: true,
      payload: data,
      withCompletionHandler: {
        completion()
        if !hasRingContext {
          RNCallKeep.endCall(withUUID: callUUID, reason: 1)
        }
      }
    )
    RNVoipPushNotificationManager.didReceiveIncomingPush(with: payload, forType: type.rawValue)
  }
}
`
    const markerIndex = contents.indexOf(marker)
    contents = markerIndex === -1
      ? `${contents.trimEnd()}\n\n${callbacks}`
      : `${contents.slice(0, markerIndex)}${callbacks}`

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

    // The upstream VoIP package has no token-invalidation event. Extend its
    // existing registration event with an empty token so JS can clear the
    // stale token for this Expo push subscription on the server.
    const voipPackagePath = path.dirname(require.resolve('react-native-voip-push-notification/index.js', {
      paths: [config.modRequest.projectRoot],
    }))
    const managerDirectory = path.join(voipPackagePath, 'ios', 'RNVoipPushNotification')
    const managerHeaderPath = path.join(managerDirectory, 'RNVoipPushNotificationManager.h')
    const managerImplementationPath = path.join(managerDirectory, 'RNVoipPushNotificationManager.m')
    let managerHeader = await fs.readFile(managerHeaderPath, 'utf8')
    let managerImplementation = await fs.readFile(managerImplementationPath, 'utf8')
    const headerDeclaration = '+ (void)didInvalidatePushToken;'
    if (!managerHeader.includes(headerDeclaration)) {
      managerHeader = managerHeader.replace(
        '+ (void)didUpdatePushCredentials:(PKPushCredentials *)credentials forType:(NSString *)type;',
        `+ (void)didUpdatePushCredentials:(PKPushCredentials *)credentials forType:(NSString *)type;\n${headerDeclaration}`,
      )
      await fs.writeFile(managerHeaderPath, managerHeader)
    }
    const invalidationMethod = `+ (void)didInvalidatePushToken
{
    _lastVoipToken = @"";
    RNVoipPushNotificationManager *voipPushManager = [RNVoipPushNotificationManager sharedInstance];
    [voipPushManager sendEventWithNameWrapper:RNVoipPushRemoteNotificationsRegisteredEvent body:_lastVoipToken];
}
`
    if (!managerImplementation.includes('didInvalidatePushToken')) {
      const insertionPoint = '// --- should be called from `AppDelegate.didReceiveIncomingPushWithPayload`'
      if (!managerImplementation.includes(insertionPoint)) {
        throw new Error('withHuddleCalls could not patch the VoIP token invalidation callback')
      }
      managerImplementation = managerImplementation.replace(insertionPoint, `${invalidationMethod}\n${insertionPoint}`)
      await fs.writeFile(managerImplementationPath, managerImplementation)
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
