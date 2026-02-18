/**
 * Cron Manager Unit Tests
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, rmSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { CronManager, CronError } from '../cron-manager'

const TEST_DIR = '/tmp/test-cron-manager'
const PERSIST_PATH = join(TEST_DIR, 'cron.json')

describe('CronManager', () => {
  let cm: CronManager
  let firedJobs: Array<{ name: string; prompt: string }>

  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
    mkdirSync(TEST_DIR, { recursive: true })
    firedJobs = []

    cm = new CronManager({
      persistPath: PERSIST_PATH,
      onJobFire: async (job) => {
        firedJobs.push({ name: job.name, prompt: job.prompt })
        return `Completed: ${job.name}`
      },
      minIntervalSeconds: 1,
    })
  })

  afterEach(() => {
    cm.stop()
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  describe('addJob', () => {
    test('adds a job and persists it', () => {
      const job = cm.addJob({
        name: 'test-job',
        intervalSeconds: 60,
        prompt: 'Do something',
      })

      expect(job.name).toBe('test-job')
      expect(job.enabled).toBe(true)
      expect(job.intervalSeconds).toBe(60)
      expect(job.createdAt).toBeDefined()

      expect(existsSync(PERSIST_PATH)).toBe(true)
      const persisted = JSON.parse(readFileSync(PERSIST_PATH, 'utf-8'))
      expect(persisted).toHaveLength(1)
      expect(persisted[0].name).toBe('test-job')
    })

    test('rejects intervals below minimum', () => {
      expect(() =>
        cm.addJob({ name: 'fast', intervalSeconds: 0, prompt: 'x' })
      ).toThrow('Minimum interval')
    })

    test('rejects when max jobs reached', () => {
      const limited = new CronManager({
        persistPath: PERSIST_PATH,
        onJobFire: async () => 'ok',
        maxJobs: 2,
        minIntervalSeconds: 1,
      })

      limited.addJob({ name: 'j1', intervalSeconds: 60, prompt: 'a' })
      limited.addJob({ name: 'j2', intervalSeconds: 60, prompt: 'b' })

      expect(() =>
        limited.addJob({ name: 'j3', intervalSeconds: 60, prompt: 'c' })
      ).toThrow('Maximum job limit')

      limited.stop()
    })

    test('updates existing job', () => {
      cm.addJob({ name: 'j1', intervalSeconds: 60, prompt: 'v1' })
      const updated = cm.addJob({ name: 'j1', intervalSeconds: 120, prompt: 'v2' })

      expect(updated.intervalSeconds).toBe(120)
      expect(updated.prompt).toBe('v2')
      expect(cm.listJobs()).toHaveLength(1)
    })
  })

  describe('removeJob', () => {
    test('removes a job', () => {
      cm.addJob({ name: 'j1', intervalSeconds: 60, prompt: 'x' })
      expect(cm.removeJob('j1')).toBe(true)
      expect(cm.listJobs()).toHaveLength(0)
    })

    test('returns false for missing job', () => {
      expect(cm.removeJob('nonexistent')).toBe(false)
    })
  })

  describe('enable/disable', () => {
    test('disables a job', () => {
      cm.addJob({ name: 'j1', intervalSeconds: 60, prompt: 'x' })
      expect(cm.disableJob('j1')).toBe(true)
      expect(cm.getJob('j1')?.enabled).toBe(false)
    })

    test('enables a disabled job', () => {
      cm.addJob({ name: 'j1', intervalSeconds: 60, prompt: 'x' })
      cm.disableJob('j1')
      expect(cm.enableJob('j1')).toBe(true)
      expect(cm.getJob('j1')?.enabled).toBe(true)
    })

    test('returns false for missing job', () => {
      expect(cm.enableJob('missing')).toBe(false)
      expect(cm.disableJob('missing')).toBe(false)
    })
  })

  describe('listJobs', () => {
    test('lists all jobs', () => {
      cm.addJob({ name: 'a', intervalSeconds: 60, prompt: 'pa' })
      cm.addJob({ name: 'b', intervalSeconds: 120, prompt: 'pb' })

      const jobs = cm.listJobs()
      expect(jobs).toHaveLength(2)
      expect(jobs.map((j) => j.name).sort()).toEqual(['a', 'b'])
    })
  })

  describe('triggerJob', () => {
    test('manually triggers a job', async () => {
      cm.addJob({ name: 'j1', intervalSeconds: 60, prompt: 'Run report' })

      const result = await cm.triggerJob('j1')
      expect(result.success).toBe(true)
      expect(result.jobName).toBe('j1')
      expect(result.response).toBe('Completed: j1')
      expect(firedJobs).toHaveLength(1)
      expect(firedJobs[0].prompt).toBe('Run report')
    })

    test('throws for missing job', async () => {
      try {
        await cm.triggerJob('missing')
        expect(true).toBe(false)
      } catch (err) {
        expect(err).toBeInstanceOf(CronError)
      }
    })

    test('tracks lastRunAt after trigger', async () => {
      cm.addJob({ name: 'j1', intervalSeconds: 60, prompt: 'x' })
      await cm.triggerJob('j1')

      const job = cm.getJob('j1')!
      expect(job.lastRunAt).toBeDefined()
    })
  })

  describe('auto-disable on failures', () => {
    test('disables job after max consecutive failures', async () => {
      const failingCm = new CronManager({
        persistPath: PERSIST_PATH,
        onJobFire: async () => { throw new Error('API down') },
        minIntervalSeconds: 1,
      })

      failingCm.addJob({
        name: 'fragile',
        intervalSeconds: 60,
        prompt: 'x',
        maxFailures: 2,
      })

      await failingCm.triggerJob('fragile')
      expect(failingCm.getJob('fragile')?.enabled).toBe(true)
      expect(failingCm.getJob('fragile')?.failureCount).toBe(1)

      await failingCm.triggerJob('fragile')
      expect(failingCm.getJob('fragile')?.enabled).toBe(false)
      expect(failingCm.getJob('fragile')?.failureCount).toBe(2)

      failingCm.stop()
    })

    test('resets failure count on success', async () => {
      let shouldFail = true
      const mixed = new CronManager({
        persistPath: PERSIST_PATH,
        onJobFire: async () => {
          if (shouldFail) throw new Error('fail')
          return 'ok'
        },
        minIntervalSeconds: 1,
      })

      mixed.addJob({ name: 'j1', intervalSeconds: 60, prompt: 'x', maxFailures: 3 })

      await mixed.triggerJob('j1') // fail
      expect(mixed.getJob('j1')?.failureCount).toBe(1)

      shouldFail = false
      await mixed.triggerJob('j1') // succeed
      expect(mixed.getJob('j1')?.failureCount).toBe(0)

      mixed.stop()
    })
  })

  describe('persistence', () => {
    test('loads jobs from disk on start', () => {
      cm.addJob({ name: 'persistent', intervalSeconds: 60, prompt: 'saved' })
      cm.stop()

      const cm2 = new CronManager({
        persistPath: PERSIST_PATH,
        onJobFire: async () => 'ok',
        minIntervalSeconds: 1,
      })
      cm2.start()

      expect(cm2.listJobs()).toHaveLength(1)
      expect(cm2.getJob('persistent')?.prompt).toBe('saved')

      cm2.stop()
    })
  })

  describe('start/stop', () => {
    test('isStarted reflects state', () => {
      expect(cm.isStarted).toBe(false)
      cm.start()
      expect(cm.isStarted).toBe(true)
      cm.stop()
      expect(cm.isStarted).toBe(false)
    })
  })
})
