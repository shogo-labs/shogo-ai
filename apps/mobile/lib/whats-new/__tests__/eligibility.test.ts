import { describe, expect, test } from 'bun:test'
import { selectWhatsNewRelease, type WhatsNewRelease } from '../eligibility'

const releases: WhatsNewRelease[] = [
  {
    version: '1.12',
    slug: 'v1-12',
    title: 'Shogo 1.12',
    date: '2026-06-26',
    announce: true,
    intro: 'Latest release',
    highlights: [],
    url: 'https://docs.shogo.ai/changelog/v1-12',
  },
  {
    version: '1.11',
    slug: 'v1-11',
    title: 'Shogo 1.11',
    date: '2026-05-01',
    announce: true,
    intro: 'Previous release',
    highlights: [],
    url: 'https://docs.shogo.ai/changelog/v1-11',
  },
  {
    version: '2.0',
    slug: 'v2-0',
    title: 'Shogo 2.0',
    date: '2026-08-01',
    announce: false,
    intro: 'Not announced',
    highlights: [],
    url: 'https://docs.shogo.ai/changelog/v2-0',
  },
]

describe('selectWhatsNewRelease', () => {
  test('selects the newest eligible announcement', () => {
    expect(selectWhatsNewRelease(releases, '1.12.4', null, '2026-01-01')?.version).toBe('1.12')
  })

  test('suppresses releases at or below the seen version', () => {
    expect(selectWhatsNewRelease(releases, '1.12', '1.12', '2026-01-01')).toBeNull()
  })

  test('does not show a release to users who joined after it shipped', () => {
    expect(selectWhatsNewRelease(releases, '1.12', null, '2026-07-01')).toBeNull()
  })

  test('does not show when the app version is unavailable', () => {
    expect(selectWhatsNewRelease(releases, null, null, '2026-01-01')).toBeNull()
  })
})
