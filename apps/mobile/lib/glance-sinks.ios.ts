// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * iOS: no glance sinks yet. The Home Screen widget (`targets/widgets`, via
 * `@bacons/apple-targets`) and the Live Activity (`expo-widgets`) need their
 * own App IDs, the `group.ai.shogo.app` App Group and App Store provisioning
 * profiles before CI can sign them, so their config plugins are not in
 * app.json. Without those native targets the sinks would write to nothing and
 * the Live Activity calls would throw. Restore the sinks together with the
 * plugins and the App Group entitlement.
 */
export {}
