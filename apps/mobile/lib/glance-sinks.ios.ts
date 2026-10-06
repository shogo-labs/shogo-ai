// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * iOS: Home Screen and Lock Screen widgets read the snapshot from the App
 * Group, and the Live Activity follows the agent that needs you or is working.
 */
import { ExtensionStorage } from '@bacons/apple-targets'
import { GLANCE_APP_GROUP, createWidgetSink } from './glance-storage'
import { registerGlanceSink } from './glance-publisher'
import { liveActivitySink, liveActivityTokens, listenForPushToStartToken } from './live-activity/agent-live-activity'
import { subscribePushToken } from './notifications/mobile-push-registration'

const storage = new ExtensionStorage(GLANCE_APP_GROUP)

registerGlanceSink(createWidgetSink(storage, () => ExtensionStorage.reloadWidget()))
registerGlanceSink(liveActivitySink)

// So the server can keep the activity current while the app is closed.
listenForPushToStartToken()
subscribePushToken((token) => void liveActivityTokens.setPushToken(token))
