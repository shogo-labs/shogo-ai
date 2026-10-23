// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { hostMemory } from './register'

describe('hostMemory', () => {
  test('reads MemTotal and MemAvailable in MiB', () => {
    const meminfo = 'MemTotal:       263921664 kB\nMemFree:         1024 kB\nMemAvailable:   131960832 kB\n'
    expect(hostMemory(meminfo)).toEqual({ totalMiB: 257736, availableMiB: 128868 })
  })

  test('is undefined when either field is missing', () => {
    expect(hostMemory('MemTotal: 1024 kB\n')).toBeUndefined()
    expect(hostMemory('')).toBeUndefined()
  })
})
