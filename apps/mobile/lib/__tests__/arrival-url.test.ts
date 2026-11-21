// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for the arrival-URL capture and its one-shot claim (SHO-174).
 *
 * The module-scope value is empty under Bun (no `window`), so the href-taking
 * helpers are called with it explicitly — that is also how the hook uses them.
 * The claim is passed in per test so these cases do not share module state.
 */
import { describe, expect, it } from 'bun:test'
import {
  arrivalQueryParamsForProject,
  captureArrivalHref,
  claimArrivalQueryParams,
  peekArrivalQueryParamsForProject,
  type ArrivalClaim,
} from '../arrival-url'

const ID = 'proj-abc'
const OTHER = 'proj-other'

function freshClaim(): ArrivalClaim {
  return { claimed: false }
}

describe('arrival-url', () => {
  it('captures nothing when the document has no href (native)', () => {
    expect(captureArrivalHref(undefined)).toBe('')
    expect(captureArrivalHref(null)).toBe('')
    expect(captureArrivalHref('')).toBe('')
  })

  it('captures the href it is given', () => {
    expect(captureArrivalHref('http://localhost/projects/proj-abc?tab=settings')).toBe(
      'http://localhost/projects/proj-abc?tab=settings',
    )
  })

  it('restores nothing from a document with no href', () => {
    expect(arrivalQueryParamsForProject(ID, captureArrivalHref(undefined))).toBeNull()
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

describe('arrival claim', () => {
  // The href is read from the module, which is empty under Bun, so these cases
  // pin the claim semantics through the explicit-claim overload. `peek` with no
  // href to read is null either way, which is exactly the "nothing to restore"
  // path the hook must still consume.

  it('peek is null when there is nothing to read, claimed or not', () => {
    expect(peekArrivalQueryParamsForProject(ID, freshClaim())).toBeNull()
  })

  it('claim succeeds exactly once', () => {
    const claim = freshClaim()
    expect(claimArrivalQueryParams(claim)).toBe(true)
    expect(claimArrivalQueryParams(claim)).toBe(false)
    expect(claimArrivalQueryParams(claim)).toBe(false)
    expect(claim.claimed).toBe(true)
  })

  it('a taken claim stops the same project being restored again', () => {
    const claim = freshClaim()
    expect(claimArrivalQueryParams(claim)).toBe(true)
    // Second visit to the project (a remount): nothing left to peek.
    expect(peekArrivalQueryParamsForProject(ID, claim)).toBeNull()
  })

  it('a taken claim stops a different project picking it up too', () => {
    const claim = freshClaim()
    expect(claimArrivalQueryParams(claim)).toBe(true)
    expect(peekArrivalQueryParamsForProject(OTHER, claim)).toBeNull()
  })

  it('claims are independent per page load', () => {
    const first = freshClaim()
    const second = freshClaim()
    expect(claimArrivalQueryParams(first)).toBe(true)
    expect(claimArrivalQueryParams(second)).toBe(true)
  })
})
