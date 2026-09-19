// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/** Notifications that describe work started from the native task surface. */
export const MOBILE_TASK_NOTIFICATION_TYPES = [
  'agent_task_started',
  'agent_task_completed',
  'agent_task_failed',
] as const

export function isMobileTaskNotificationType(type: string): boolean {
  return (MOBILE_TASK_NOTIFICATION_TYPES as readonly string[]).includes(type)
}

/** Keep native task notifications out of the web-only notification surfaces. */
export function shouldShowNotificationOnPlatform(type: string, platform: string): boolean {
  return platform !== 'web' || !isMobileTaskNotificationType(type)
}

export function filterNotificationsForPlatform<T extends { type: string }>(items: T[], platform: string): T[] {
  return items.filter((item) => shouldShowNotificationOnPlatform(item.type, platform))
}
