// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/** Lets Android draw the widget from JS, even when the app is not open. */
import { registerWidgetTaskHandler } from 'react-native-android-widget'
import { widgetTaskHandler } from './widget-task-handler'

registerWidgetTaskHandler(widgetTaskHandler)
