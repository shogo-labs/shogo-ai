import { afterEach, describe, expect, test } from 'bun:test'
import {
  createOpenAttemptId,
  getMarks,
  mark,
  reset,
  setOpenAttemptId,
} from '../cold-start-timing'

describe('cold-start timing correlation', () => {
  afterEach(() => reset())

  test('creates unique open ids', () => {
    expect(createOpenAttemptId()).not.toBe(createOpenAttemptId())
  })

  test('adds the current open id to marks', () => {
    setOpenAttemptId('open-test')
    mark('project:test', { phase: 'test' })
    const entry = getMarks().find((item) => item.id === 'project:test')
    expect(entry?.meta).toEqual({ openAttemptId: 'open-test', phase: 'test' })
  })
})
