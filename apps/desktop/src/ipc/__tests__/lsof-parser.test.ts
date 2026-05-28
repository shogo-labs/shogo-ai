// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, it } from 'bun:test'
import { parseLsof, parseAddressPort, diffNewPorts } from '../lsof-parser'

describe('parseAddressPort', () => {
  it('parses wildcard IPv4', () => {
    expect(parseAddressPort('*:3000')).toEqual({ address: '*', port: 3000 })
  })

  it('parses IPv4 loopback', () => {
    expect(parseAddressPort('127.0.0.1:8080')).toEqual({ address: '127.0.0.1', port: 8080 })
  })

  it('parses bracketed IPv6 loopback', () => {
    expect(parseAddressPort('[::1]:3000')).toEqual({ address: '::1', port: 3000 })
  })

  it('parses IPv6 wildcard', () => {
    expect(parseAddressPort('[::]:8080')).toEqual({ address: '::', port: 8080 })
  })

  it('parses full IPv6 address', () => {
    expect(parseAddressPort('[fe80::1]:5000')).toEqual({ address: 'fe80::1', port: 5000 })
  })

  it('rejects empty input', () => {
    expect(parseAddressPort('')).toBeNull()
  })

  it('rejects no colon', () => {
    expect(parseAddressPort('hello')).toBeNull()
  })

  it('rejects no port after colon', () => {
    expect(parseAddressPort('127.0.0.1:')).toBeNull()
  })

  it('rejects non-numeric port', () => {
    expect(parseAddressPort('127.0.0.1:abc')).toBeNull()
  })

  it('rejects port out of range', () => {
    expect(parseAddressPort('127.0.0.1:99999')).toBeNull()
    expect(parseAddressPort('127.0.0.1:0')).toBeNull()
  })

  it('rejects unclosed bracket', () => {
    expect(parseAddressPort('[::1:3000')).toBeNull()
  })

  it('rejects bracket without trailing colon-port', () => {
    expect(parseAddressPort('[::1]')).toBeNull()
    expect(parseAddressPort('[::1]3000')).toBeNull()
  })
})

describe('parseLsof', () => {
  const sample = `COMMAND     PID  USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME
node      12345 user   17u  IPv4 0x1234567890123456      0t0  TCP *:3000 (LISTEN)
node      12345 user   18u  IPv6 0x1234567890123456      0t0  TCP [::1]:3000 (LISTEN)
postgres   9999 user    7u  IPv4 0xabcdef               0t0  TCP 127.0.0.1:5432 (LISTEN)
nginx       111 root    6u  IPv4 0x123                  0t0  TCP *:80 (LISTEN)
nginx       111 root    7u  IPv6 0x123                  0t0  TCP [::]:80 (LISTEN)`

  it('parses a typical lsof block', () => {
    const rows = parseLsof(sample)
    expect(rows).toEqual([
      { port: 80,   command: 'nginx',    pid: 111,   address: '*',         type: 'IPv4' },
      { port: 3000, command: 'node',     pid: 12345, address: '*',         type: 'IPv4' },
      { port: 5432, command: 'postgres', pid: 9999,  address: '127.0.0.1', type: 'IPv4' },
    ])
  })

  it('skips header row', () => {
    const headerOnly = 'COMMAND     PID  USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME'
    expect(parseLsof(headerOnly)).toEqual([])
  })

  it('skips lsof warnings on stdout', () => {
    const input = `lsof: WARNING: can't stat() apfs file system /System/Volumes/Data
COMMAND     PID  USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME
node      12345 user   17u  IPv4 0x1234567890123456      0t0  TCP *:3000 (LISTEN)`
    expect(parseLsof(input)).toEqual([
      { port: 3000, command: 'node', pid: 12345, address: '*', type: 'IPv4' },
    ])
  })

  it('skips non-LISTEN rows defensively', () => {
    const input = `COMMAND     PID  USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME
node      12345 user   17u  IPv4 0x...                  0t0  TCP *:3000 (ESTABLISHED)
node      67890 user   18u  IPv4 0x...                  0t0  TCP *:4000 (LISTEN)`
    const rows = parseLsof(input)
    expect(rows).toEqual([
      { port: 4000, command: 'node', pid: 67890, address: '*', type: 'IPv4' },
    ])
  })

  it('dedupes IPv4/IPv6 twins (same port, same pid)', () => {
    const input = `COMMAND     PID  USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME
node      12345 user   17u  IPv4 0x123                  0t0  TCP *:3000 (LISTEN)
node      12345 user   18u  IPv6 0x123                  0t0  TCP [::1]:3000 (LISTEN)`
    const rows = parseLsof(input)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual({ port: 3000, command: 'node', pid: 12345, address: '*', type: 'IPv4' })
  })

  it('keeps separate rows when same port is bound by different pids', () => {
    const input = `COMMAND     PID  USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME
nginx       111 root    6u  IPv4 0x123                  0t0  TCP *:80 (LISTEN)
nginx       222 root    7u  IPv4 0x456                  0t0  TCP *:80 (LISTEN)`
    const rows = parseLsof(input)
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.pid).sort((a, b) => a - b)).toEqual([111, 222])
  })

  it('sorts ascending by port, then pid', () => {
    const input = `COMMAND     PID  USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME
a         300 u    1u  IPv4 0                            0t0  TCP *:9000 (LISTEN)
b         100 u    1u  IPv4 0                            0t0  TCP *:3000 (LISTEN)
c         200 u    1u  IPv4 0                            0t0  TCP *:5000 (LISTEN)`
    const rows = parseLsof(input)
    expect(rows.map((r) => r.port)).toEqual([3000, 5000, 9000])
  })

  it('handles empty input', () => {
    expect(parseLsof('')).toEqual([])
  })

  it('skips malformed rows without nuking the rest', () => {
    const input = `COMMAND     PID  USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME
this is not a valid row at all
node      12345 user   17u  IPv4 0x123                  0t0  TCP *:3000 (LISTEN)
short row (LISTEN)
postgres   9999 user    7u  IPv4 0xabc                  0t0  TCP 127.0.0.1:5432 (LISTEN)`
    const rows = parseLsof(input)
    expect(rows.map((r) => r.port)).toEqual([3000, 5432])
  })

  it('skips rows with invalid pid', () => {
    const input = `COMMAND     PID  USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME
node       abc user   17u  IPv4 0x123                  0t0  TCP *:3000 (LISTEN)`
    expect(parseLsof(input)).toEqual([])
  })
})

describe('diffNewPorts', () => {
  const a = { port: 3000, command: 'node', pid: 1, address: '*', type: 'IPv4' as const }
  const b = { port: 5000, command: 'vite', pid: 2, address: '*', type: 'IPv4' as const }
  const c = { port: 8080, command: 'nginx', pid: 3, address: '*', type: 'IPv4' as const }

  it('returns all entries when prev is empty', () => {
    expect(diffNewPorts([], [a, b])).toEqual([a, b])
  })

  it('returns only newly-added entries', () => {
    expect(diffNewPorts([a], [a, b, c])).toEqual([b, c])
  })

  it('returns empty when nothing changed', () => {
    expect(diffNewPorts([a, b], [a, b])).toEqual([])
  })

  it('treats same port under a new pid as new', () => {
    const aNewPid = { ...a, pid: 99 }
    expect(diffNewPorts([a], [aNewPid])).toEqual([aNewPid])
  })

  it('ignores removed entries (they are not new)', () => {
    expect(diffNewPorts([a, b], [a])).toEqual([])
  })
})
