import { describe, expect, test } from 'bun:test'
import { loadLearnProfile, type LearnProfileDb } from '../learn-profile.service'
import { LEARN_BADGES, LEARN_LESSONS } from '../../config/learn-gamification'

function fakeDb(data: {
  completions?: Array<{ userId: string; courseId: string; lessonId: string; day: string }>
  badges?: Array<{ userId: string; badgeId: string; earnedAt: Date }>
  enrollments?: Array<{ userId: string; courseId: string; status: string; progress: unknown }>
}): LearnProfileDb & { calls: any[] } {
  const calls: any[] = []
  return {
    calls,
    learnLessonCompletion: { findMany: async (a: any) => (calls.push(a), (data.completions ?? []).filter((c) => c.userId === a.where.userId)) },
    learnBadge: {
      findMany: async (a: any) =>
        (data.badges ?? []).filter((b) => b.userId === a.where.userId).sort((x, y) => y.earnedAt.getTime() - x.earnedAt.getTime()),
    },
    courseEnrollment: {
      findMany: async (a: any) =>
        (data.enrollments ?? []).filter((e) => e.userId === a.where.userId && e.courseId === a.where.courseId && e.status === a.where.status),
    },
  }
}

const NOW = Date.UTC(2026, 10, 20, 18, 0, 0)

describe('loadLearnProfile', () => {
  test('null until the person starts learning', async () => {
    expect(await loadLearnProfile('u1', { db: fakeDb({}), now: NOW })).toBeNull()
  })

  test('level, XP, streak and recent badges, with the same numbers as learn.shogo.ai', async () => {
    const db = fakeDb({
      completions: LEARN_LESSONS['start-here'].map((lessonId, i) => ({ userId: 'u1', courseId: 'start-here', lessonId, day: `2026-11-${16 + i}` })),
      badges: [
        { userId: 'u1', badgeId: 'first-lesson', earnedAt: new Date('2026-11-16T10:00:00Z') },
        { userId: 'u1', badgeId: 'course-start-here', earnedAt: new Date('2026-11-20T10:00:00Z') },
        { userId: 'u1', badgeId: 'retired-badge', earnedAt: new Date('2026-11-20T11:00:00Z') },
        { userId: 'u2', badgeId: 'streak-30', earnedAt: new Date('2026-11-20T11:00:00Z') },
      ],
    })
    const p = (await loadLearnProfile('u1', { db, now: NOW, tz: 'UTC' }))!
    expect(p.lessonsCompleted).toBe(5)
    expect(p.coursesCompleted).toBe(1)
    expect(p.xp).toBe(5 * 10 + 50 + 20 + 20)
    expect(p.level.name).toBe('Builder')
    expect(p.streak).toEqual({ current: 5, longest: 5 })
    expect(p.badgeCount).toBe(2)
    expect(p.badgeTotal).toBe(LEARN_BADGES.length)
    expect(p.badges.map((b) => b.id)).toEqual(['course-start-here', 'first-lesson'])
    expect(p.badges[0]).toMatchObject({ name: 'Start here graduate', icon: 'graduation' })
    expect(p.url).toBe('https://learn.shogo.ai')
  })

  test('Solo Founder lessons from the course board count toward XP', async () => {
    const db = fakeDb({ enrollments: [{ userId: 'u1', courseId: 'solo-founder-v1', status: 'active', progress: { completedLessons: ['m0', 'm1'] } }] })
    const p = (await loadLearnProfile('u1', { db, now: NOW }))!
    expect(p.lessonsCompleted).toBe(2)
    expect(p.xp).toBe(20)
    expect(p.streak.current).toBe(0)
  })
})
