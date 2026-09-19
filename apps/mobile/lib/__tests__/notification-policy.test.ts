import { describe, expect, test } from 'bun:test'
import {
  filterNotificationsForPlatform,
  isMobileTaskNotificationType,
} from '../notification-policy'

describe('notification policy', () => {
  test('identifies native task notifications', () => {
    expect(isMobileTaskNotificationType('agent_task_started')).toBe(true)
    expect(isMobileTaskNotificationType('agent_task_completed')).toBe(true)
    expect(isMobileTaskNotificationType('workspace_updated')).toBe(false)
  })

  test('filters native task notifications only from web', () => {
    const notifications = [
      { type: 'agent_task_completed', id: 'task' },
      { type: 'workspace_updated', id: 'workspace' },
    ]

    expect(filterNotificationsForPlatform(notifications, 'web')).toEqual([
      { type: 'workspace_updated', id: 'workspace' },
    ])
    expect(filterNotificationsForPlatform(notifications, 'ios')).toEqual(notifications)
  })
})
