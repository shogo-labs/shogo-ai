// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * The two brakes on a guest export (SHO-593): the byte budget that keeps one
 * slow backup from piling up behind others, and the per-body cap that refuses an
 * archive the host could never have held — the read that reached ~33 GiB on
 * staging before its deadline.
 */

import { describe, expect, test } from 'bun:test'
import { BodyTooLargeError, ByteBudget, readBoundedBody } from './byte-budget'

const MIB = 1024 * 1024

function chunked(totalBytes: number, chunkBytes: number): Response {
  let sent = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= totalBytes) return controller.close()
      const size = Math.min(chunkBytes, totalBytes - sent)
      const chunk = new Uint8Array(size).fill(1)
      sent += size
      controller.enqueue(chunk)
    },
  })
  return new Response(body)
}

describe('ByteBudget', () => {
  test('serialises two reservations that cannot both fit, and reports the peak', async () => {
    const budget = new ByteBudget(100)

    await budget.acquire(60)
    let secondGranted = false
    const second = budget.acquire(60).then(() => {
      secondGranted = true
    })
    await Promise.resolve()
    expect(secondGranted).toBe(false)
    expect(budget.inUse).toBe(60)

    budget.release(60)
    await second
    expect(secondGranted).toBe(true)
    expect(budget.inUse).toBe(60)
    expect(budget.peakBytes).toBe(60)

    budget.release(60)
    expect(budget.inUse).toBe(0)
  })

  test('clamps a reservation larger than the whole budget so it still runs, alone', async () => {
    const budget = new ByteBudget(50)
    await budget.acquire(500) // a body bigger than the budget still gets a turn
    expect(budget.inUse).toBe(50)
    let other = false
    const waiting = budget.acquire(1).then(() => {
      other = true
    })
    await Promise.resolve()
    expect(other).toBe(false)
    budget.release(500)
    await waiting
    expect(budget.inUse).toBe(1)
  })

  test('a queued reservation records how long it waited', async () => {
    let clock = 1000
    const budget = new ByteBudget(10, () => clock)
    await budget.acquire(10)
    const waiting = budget.acquire(10)
    clock = 1750
    budget.release(10)
    await waiting
    expect(budget.waitedMs).toBe(750)
  })
})

describe('readBoundedBody', () => {
  test('reads a body with a content-length into exactly one copy', async () => {
    const res = new Response(new Uint8Array(64 * 1024).fill(3), {
      headers: { 'content-length': String(64 * 1024) },
    })
    const out = await readBoundedBody(res, { capBytes: 1 * MIB, label: 'test' })
    expect(out.byteLength).toBe(64 * 1024)
    expect(out[0]).toBe(3)
    expect(out[out.byteLength - 1]).toBe(3)
  })

  test('joins a chunked body and releases its budget reservation', async () => {
    const budget = new ByteBudget(4 * MIB)
    const out = await readBoundedBody(chunked(2 * MIB, 128 * 1024), {
      budget,
      capBytes: 8 * MIB,
      label: 'test',
    })
    expect(out.byteLength).toBe(2 * MIB)
    expect(budget.inUse).toBe(0)
  })

  test('refuses a declared body over the cap without reading it', async () => {
    let pulled = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++
        controller.enqueue(new Uint8Array(MIB))
      },
    })
    const res = new Response(body, { headers: { 'content-length': String(100 * MIB) } })

    const err = await readBoundedBody(res, { capBytes: 10 * MIB, label: 'huge export' }).catch((e) => e)

    expect(err).toBeInstanceOf(BodyTooLargeError)
    expect(err.bytes).toBe(100 * MIB)
    expect(err.message).toContain('huge export')
    expect(pulled).toBe(0)
  })

  test('stops a chunked body past the cap instead of buffering the tail', async () => {
    const budget = new ByteBudget(8 * MIB)
    const err = await readBoundedBody(chunked(64 * MIB, 1 * MIB), {
      budget,
      capBytes: 4 * MIB,
      label: 'chunked export',
    }).catch((e) => e)

    expect(err).toBeInstanceOf(BodyTooLargeError)
    expect(err.code).toBe('body-too-large')
    // The budget is released on the failure path too, or one refusal would wedge
    // every later export behind a reservation nothing holds.
    expect(budget.inUse).toBe(0)
  })

  test('moves 512 MiB through within the stated 2x chunked ceiling', async () => {
    const budget = new ByteBudget(512 * MIB)
    const before = process.memoryUsage().external
    let peak = before
    const poll = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().external)
    }, 5)
    let out: Uint8Array | null = null
    try {
      out = await readBoundedBody(chunked(512 * MIB, 1 * MIB), {
        budget,
        capBytes: 1024 * MIB,
        label: 'synthetic 512 MiB',
      })
    } finally {
      clearInterval(poll)
    }
    expect(out!.byteLength).toBe(512 * MIB)
    // A chunked body costs the chunks plus the join — 2x, as documented. Without
    // the cap, a 33 GiB body is 66 GiB of host memory; the ceiling is what keeps
    // the burst off the box.
    expect(peak - before).toBeLessThan(1024 * MIB)
    expect(budget.inUse).toBe(0)
  })
})
