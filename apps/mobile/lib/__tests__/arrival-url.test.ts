// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for the arrival-URL capture (SHO-174).
 *
 * The module-scope value is empty under Bun (no `window`), so every case here
 * passes the href explicitly — that is also how the hook uses it in tests.
 */
import { describe, expect, it } from 'bun:test'
import { arrivalHref, arrivalQueryParams, arrivalQueryParamsForProject } from '../arrival-url'

const ID = 'proj-abc'

describe('arrival-url', () => {
  it('is empty when there is no document (native / bun)', () => {
    expect(arrivalHref()).toBe('')
    expect(arrivalQueryParams()).toBeNull()
  })

  it('scopes params to the project in the arrival path', () => {
    const params = arrivalQueryParamsForProject(
      ID,
      `http://localhost:8081/projects/${ID}?tab=settings&file=src%2Findex.ts`,
    )
    expect(params).toEqual({ tab: 'settings', file: 'src/index.ts' })
  })

  it('returns null for a different project', () => {
    expect(
      arrivalQueryParamsForProject(
        ID,
        'http://localhost:8081/projects/other-project?tab=settings',
      ),
    ).toBeNull()
  })

  it('returns null when the arrival URL carried no query', () => {
    expect(
      arrivalQueryParamsForProject(ID, `http://localhost:8081/projects/${ID}`),
    ).toBeNull()
  })

  it('returns null without a project id', () => {
    expect(
      arrivalQueryParamsForProject(undefined, `http://localhost:8081/projects/${ID}?tab=x`),
    ).toBeNull()
  })

  it('returns null for an href that does not parse', () => {
    expect(arrivalQueryParamsForProject(ID, 'not a url')).toBeNull()
  })

  it('keeps a repeated key as its last value', () => {
    const params = arrivalQueryParamsForProject(
      ID,
      `http://localhost:8081/projects/${ID}?tab=settings&tab=canvas`,
    )
    expect(params?.tab).toBe('canvas')
  })
})
