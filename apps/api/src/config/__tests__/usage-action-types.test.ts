// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-355 acceptance 5 — a new billed action type can't be forgotten.
 *
 * `ConsumeUsageParams.actionType` is typed as `BilledUsageActionType`, which
 * fails typecheck for a typed caller. This is the belt to that braces: it scans
 * the source for every `actionType: '<literal>'` and fails unless the literal is
 * in `BILLED_USAGE_ACTION_TYPES` or `NON_BILLED_USAGE_ACTION_TYPES` — catching
 * untyped callers (`prisma.usageEvent.create({ data: { actionType: '…' } })`).
 *
 *   bun test apps/api/src/config/__tests__/usage-action-types.test.ts
 */

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  BILLED_USAGE_ACTION_TYPES,
  BILLED_USAGE_ACTION_TYPE_LIST,
  NON_BILLED_USAGE_ACTION_TYPES,
  USAGE_CATEGORY_LABELS,
  USAGE_CATEGORY_ORDER,
  isNonBilledUsageActionType,
  usageActionLabel,
  usageCategoryFor,
} from '../usage-action-types'

const API_SRC = join(import.meta.dir, '../..')

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__tests__' || entry === 'generated') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      sourceFiles(full, out)
      continue
    }
    if (/\.(ts|tsx)$/.test(entry) && !/\.test\.|\.spec\./.test(entry)) out.push(full)
  }
  return out
}

describe('usage action-type registry', () => {
  test('every literal actionType in the API is registered', () => {
    const known = new Set<string>([
      ...Object.keys(BILLED_USAGE_ACTION_TYPES),
      ...NON_BILLED_USAGE_ACTION_TYPES,
    ])
    const unregistered: string[] = []
    for (const file of sourceFiles(API_SRC)) {
      const source = readFileSync(file, 'utf8')
      for (const match of source.matchAll(/actionType:\s*'([a-z0-9_]+)'/g)) {
        if (!known.has(match[1])) {
          unregistered.push(`${file.replace(API_SRC, '')}: ${match[1]}`)
        }
      }
    }
    expect(unregistered).toEqual([])
  })

  test('every billed type rolls up into a category with a label', () => {
    for (const [actionType, category] of Object.entries(BILLED_USAGE_ACTION_TYPES)) {
      expect(usageCategoryFor(actionType)).toBe(category)
      expect(USAGE_CATEGORY_LABELS[category]).toBeTruthy()
    }
  })

  test('non-billed and unknown types have no category', () => {
    for (const actionType of NON_BILLED_USAGE_ACTION_TYPES) {
      expect(usageCategoryFor(actionType)).toBeNull()
    }
    expect(usageCategoryFor('something_new')).toBeNull()
  })

  test('the media image/video/3D/music/hosting/social types are billed', () => {
    for (const actionType of [
      'ai_image_generation',
      'ai_video_generation',
      'ai_3d_generation',
      'ai_music_generation',
      'ai_audio_transcription',
      'published_hosting',
      'social_account_monthly',
      'social_dm',
      'social_x_api',
      'social_media_lookup',
      'voice_media_usage',
    ]) {
      expect(usageCategoryFor(actionType)).not.toBeNull()
    }
  })

  /**
   * SHO-323's native-release meters arrived on main after this registry was
   * written, and the literal scan above is what caught them in the merge queue.
   * They are billed (each debits a wallet), so they must be `billed`, and they
   * must not be folded into `hosting` — an EAS build is not "Published hosting".
   */
  test('the native release meters are billed in their own category', () => {
    for (const actionType of ['native_build', 'native_test_run', 'native_update_mau']) {
      expect(usageCategoryFor(actionType), actionType).toBe('native')
      expect(BILLED_USAGE_ACTION_TYPE_LIST, actionType).toContain(actionType)
      expect(isNonBilledUsageActionType(actionType), actionType).toBe(false)
    }
    expect(USAGE_CATEGORY_LABELS.native).toBe('Native')
    expect(USAGE_CATEGORY_ORDER).toContain('native')
    // Per-type names, so a test run is not drawn as a build.
    expect(usageActionLabel('native_build')).toBe('EAS build')
    expect(usageActionLabel('native_test_run')).toBe('EAS test run')
    expect(usageActionLabel('native_update_mau')).toBe('Native update MAU')
  })
})
