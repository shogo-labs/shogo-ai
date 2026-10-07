// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * iOS Live Activity for agents that need you or are working. Started and
 * updated here while the app runs; the API takes over through APNs when it is
 * closed, using the tokens reported below.
 */
import { addPushToStartTokenListener, createLiveActivity, type LiveActivity } from 'expo-widgets'
import { api, createHttpClient } from '../api'
import AgentActivity, { AGENT_ACTIVITY_NAME } from './AgentActivity'
import { createLiveActivitySink, type LiveActivityApi } from './live-activity-controller'
import { createLiveActivityTokenSync } from './live-activity-tokens'
import type { AgentActivityProps } from './live-activity-plan'

const factory = createLiveActivity<AgentActivityProps>(AGENT_ACTIVITY_NAME, AgentActivity)

export const liveActivityTokens = createLiveActivityTokenSync((body) => api.putLiveActivityTokens(createHttpClient(), body))

const watched = new WeakSet<LiveActivity<AgentActivityProps>>()

function watch(instance: LiveActivity<AgentActivityProps>) {
  if (watched.has(instance)) return
  watched.add(instance)
  void instance.getPushToken().then((token) => (token ? liveActivityTokens.setActivityToken(token) : undefined)).catch(() => {})
  instance.addPushTokenListener((event) => void liveActivityTokens.setActivityToken(event.pushToken))
}

const nativeApi: LiveActivityApi = {
  isRunning: () => factory.getInstances().length > 0,
  start(props) {
    watch(factory.start(props, props.link))
  },
  async update(props) {
    await Promise.all(factory.getInstances().map((instance) => (watch(instance), instance.update(props))))
  },
  async end(props) {
    await Promise.all(factory.getInstances().map((instance) => instance.end('default', props ?? undefined)))
    await liveActivityTokens.setActivityToken(null)
  },
}

/** A glance sink that drives the Live Activity. */
export const liveActivitySink = createLiveActivitySink(nativeApi)

let pushToStartListening = false
/** Lets the server start the activity remotely (iOS 17.2+). */
export function listenForPushToStartToken() {
  if (pushToStartListening) return
  pushToStartListening = true
  try {
    addPushToStartTokenListener((event) => void liveActivityTokens.setPushToStartToken(event.activityPushToStartToken))
  } catch {
    // Live Activities are not available on this device.
  }
}
