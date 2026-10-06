// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Android: the Home Screen widget, and an ongoing notification that follows the
 * agent that needs you or is working.
 */
import { createElement } from 'react'
import { requestWidgetUpdate } from 'react-native-android-widget'
import { AgentsWidget, ANDROID_WIDGET_NAME } from './android-widget/AgentsWidget'
import { saveGlance } from './android-widget/snapshot-store'
import { ongoingSink } from './android-live/android-ongoing'
import { registerGlanceSink } from './glance-publisher'

registerGlanceSink(async (snapshot) => {
  await saveGlance(snapshot)
  await requestWidgetUpdate({
    widgetName: ANDROID_WIDGET_NAME,
    renderWidget: () => createElement(AgentsWidget, { snapshot, now: Date.now() }),
  })
})

registerGlanceSink(ongoingSink)
