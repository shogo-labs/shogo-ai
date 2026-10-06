// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/** Redraws the widget whenever Android asks (added, resized, periodic). */
import React from 'react'
import type { WidgetTaskHandlerProps } from 'react-native-android-widget'
import { AgentsWidget, ANDROID_WIDGET_NAME } from './AgentsWidget'
import { loadGlance } from './snapshot-store'

export async function widgetTaskHandler(props: WidgetTaskHandlerProps): Promise<void> {
  if (props.widgetInfo.widgetName !== ANDROID_WIDGET_NAME) return
  switch (props.widgetAction) {
    case 'WIDGET_ADDED':
    case 'WIDGET_UPDATE':
    case 'WIDGET_RESIZED':
      props.renderWidget(<AgentsWidget snapshot={await loadGlance()} now={Date.now()} />)
      break
    default:
      // Deleted, or a click: taps open the app or a deep link without JS.
      break
  }
}
