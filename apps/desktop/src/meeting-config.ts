// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import type { MeetingConfig } from './config'

export interface MeetingDetectionConfig {
  enabled: boolean
  autoDetect: boolean
}

export function shouldStartMeetingMonitor(config: MeetingDetectionConfig): boolean {
  return config.enabled && config.autoDetect
}

/**
 * Fields the desktop acts on. The desktop config is their source of truth and
 * the local API keeps a mirror; transcription settings (model, cloud,
 * diarization) belong to the API alone and are never sent from here.
 */
export const DESKTOP_MEETING_KEYS = [
  'enabled',
  'autoDetect',
  'autoRecord',
  'autoRecordConfirmCount',
  'gracePeriodSeconds',
  'autoStopSeconds',
] as const satisfies readonly (keyof MeetingConfig)[]

export type DesktopMeetingFields = Pick<MeetingConfig, (typeof DESKTOP_MEETING_KEYS)[number]>

export function pickDesktopMeetingFields(config: Partial<MeetingConfig>): Partial<DesktopMeetingFields> {
  const picked: Partial<DesktopMeetingFields> = {}
  for (const key of DESKTOP_MEETING_KEYS) {
    if (key in config) (picked as Record<string, unknown>)[key] = config[key]
  }
  return picked
}
