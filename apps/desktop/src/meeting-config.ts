// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

export interface MeetingDetectionConfig {
  enabled: boolean
  autoDetect: boolean
}

export function shouldStartMeetingMonitor(config: MeetingDetectionConfig): boolean {
  return config.enabled && config.autoDetect
}
