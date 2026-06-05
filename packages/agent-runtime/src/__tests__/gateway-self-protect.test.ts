// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, test, expect } from 'bun:test'
import {
  commandTargetsGateway,
  getGatewayIdentity,
  gatewayKillRefusal,
  type GatewayIdentity,
} from '../gateway-self-protect'

const ID: GatewayIdentity = {
  pid: 4242,
  ppid: 4000,
  nameTokens: ['bun', 'server.js'],
  cmdline: '/usr/local/bin/bun /opt/shogo/server.js --port 8080',
}

const blocked = (cmd: string) => commandTargetsGateway(cmd, ID).blocked

describe('commandTargetsGateway — blocks gateway-killing commands', () => {
  test('pkill -f matching the runtime cmdline (the observed mimo failure)', () => {
    expect(blocked('pkill -f bun')).toBe(true)
    expect(blocked('pkill -f server.js')).toBe(true)
    expect(blocked('pkill -f /opt/shogo')).toBe(true)
    expect(blocked('pkill -9 -f bun')).toBe(true)
  })

  test('pkill by name matching the runtime', () => {
    expect(blocked('pkill bun')).toBe(true)
  })

  test('killall the runtime + killall5', () => {
    expect(blocked('killall bun')).toBe(true)
    expect(blocked('killall5')).toBe(true)
    expect(blocked('killall -9 bun')).toBe(true)
  })

  test('kill by gateway pid / ppid / kill-everything', () => {
    expect(blocked('kill 4242')).toBe(true)
    expect(blocked('kill -9 4242')).toBe(true)
    expect(blocked('kill 4000')).toBe(true)
    expect(blocked('kill -- -1')).toBe(true)
  })

  test('a kill hidden in a chained command is still caught', () => {
    expect(blocked('npm run build && pkill -f bun')).toBe(true)
    expect(blocked('echo done; killall bun')).toBe(true)
    expect(blocked('foo | pkill -f server.js')).toBe(true)
  })

  test('absolute path to pkill still resolves', () => {
    expect(blocked('/usr/bin/pkill -f bun')).toBe(true)
  })
})

describe('commandTargetsGateway — allows narrow / unrelated kills', () => {
  test('killing a different dev server by name does not match the runtime', () => {
    expect(blocked('pkill -f vite')).toBe(false)
    expect(blocked('pkill node')).toBe(false) // runtime is bun here, not node
  })

  test('a -f regex that does not match the gateway cmdline is allowed', () => {
    expect(blocked('pkill -f "node .*myapp"')).toBe(false)
  })

  test('killing a specific non-gateway pid is allowed', () => {
    expect(blocked('kill 9999')).toBe(false)
    expect(blocked('kill -9 12345')).toBe(false)
  })

  test('merely mentioning pkill as an argument is not a kill', () => {
    expect(blocked('echo pkill -f bun')).toBe(false)
    expect(blocked('grep pkill notes.txt')).toBe(false)
  })

  test('non-kill commands are allowed', () => {
    expect(blocked('ls -la')).toBe(false)
    expect(blocked('bun run build')).toBe(false)
  })
})

describe('getGatewayIdentity / gatewayKillRefusal', () => {
  test('identity reflects the current process and does not throw', () => {
    const id = getGatewayIdentity()
    expect(id.pid).toBe(process.pid)
    expect(id.nameTokens.length).toBeGreaterThan(0)
    expect(typeof id.cmdline).toBe('string')
  })

  test('refusal message includes the reason and a narrower-target hint', () => {
    const msg = gatewayKillRefusal('`pkill -f bun` matches the Shogo runtime')
    expect(msg).toContain('Refused')
    expect(msg).toContain('pkill -f bun')
    expect(msg.toLowerCase()).toContain('lsof')
  })
})
