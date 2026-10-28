// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * S6 — a URL printed in one project's terminal is not another project's
 * detected URL (SHO-200).
 *
 * A merged-root workspace runtime serves several projects from one process, so
 * the module-level "most recent detection" used to hand project A the URL of
 * whatever dev server project B started.
 *
 * Run: bun test packages/agent-runtime/src/__tests__/detected-urls-project-scope.test.ts
 */

import { afterEach, describe, expect, test } from 'bun:test'
import {
  ingestChunk,
  getDetectedForSession,
  getMostRecentDetectionForProject,
  listDetectionsForProject,
  clearDetection,
  _resetForTests,
} from '../detected-urls'

afterEach(() => _resetForTests())

describe('S6 — detections are scoped to their project', () => {
  test('project B printing a banner does not change project A', () => {
    ingestChunk('session-a', 'Local: http://localhost:5173/\n', 'proj_a')
    ingestChunk('session-b', 'Local: http://localhost:3000/\n', 'proj_b')

    expect(getMostRecentDetectionForProject('proj_a')?.url).toBe('http://localhost:5173')
    expect(getMostRecentDetectionForProject('proj_b')?.url).toBe('http://localhost:3000')
  })

  test('a project with no detection of its own gets null, never a neighbour', () => {
    ingestChunk('session-b', 'Local: http://localhost:3000/\n', 'proj_b')
    expect(getMostRecentDetectionForProject('proj_a')).toBeNull()
    expect(listDetectionsForProject('proj_a')).toEqual([])
  })

  test('the unattributed bucket is never returned for a project', () => {
    // A terminal the caller could not attribute (an older runtime, or a chunk
    // with no project) must not leak either.
    ingestChunk('orphan', 'Local: http://localhost:8080/\n')
    expect(getMostRecentDetectionForProject('proj_a')).toBeNull()
    expect(getMostRecentDetectionForProject(null)?.url).toBe('http://localhost:8080')
  })

  test('the detection carries the owning project', () => {
    const detection = ingestChunk('s', 'Local: http://localhost:5173/\n', 'proj_a')
    expect(detection?.projectId).toBe('proj_a')
    expect(getDetectedForSession('s')?.projectId).toBe('proj_a')
  })

  test('a stopped server disappears from its project', () => {
    ingestChunk('session-a', 'Local: http://localhost:5173/\n', 'proj_a')
    ingestChunk('session-b', 'Local: http://localhost:3000/\n', 'proj_a')
    clearDetection('session-b')
    // The project falls back to its other session, not to nothing and not to
    // another project's URL.
    expect(getMostRecentDetectionForProject('proj_a')?.url).toBe('http://localhost:5173')
    clearDetection('session-a')
    expect(getMostRecentDetectionForProject('proj_a')).toBeNull()
  })

  test('project A is unaffected when project B’s terminal exits', () => {
    ingestChunk('session-a', 'Local: http://localhost:5173/\n', 'proj_a')
    ingestChunk('session-b', 'Local: http://localhost:3000/\n', 'proj_b')
    clearDetection('session-b')
    expect(getMostRecentDetectionForProject('proj_a')?.url).toBe('http://localhost:5173')
    expect(getMostRecentDetectionForProject('proj_b')).toBeNull()
  })

  test('re-attributing a session moves its detection to the new project', () => {
    // The desktop path knows the project at spawn time; this covers a session
    // whose first chunks arrived before that was known.
    ingestChunk('s', 'Local: http://localhost:5173/\n')
    ingestChunk('s', 'Local: http://localhost:4173/\n', 'proj_a')
    expect(getMostRecentDetectionForProject('proj_a')?.url).toBe('http://localhost:4173')
    expect(getMostRecentDetectionForProject(null)).toBeNull()
  })
})
