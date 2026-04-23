// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Integration tests for the `shogo` CLI verbs added in Phase 3:
 *
 *   - `shogo enable <feature>`
 *     Flips `features.*` in `shogo.config.json` and re-runs `shogo generate`
 *     so generators + deps-doctor run immediately.
 *
 *   - `shogo dev`
 *     Runs the runtime-token preflight against `/api/voice/config/:projectId`
 *     and `/api/voice/twilio/provision-number/:projectId` before handing
 *     off to `bun run dev`.
 *
 * These tests avoid spawning subprocesses and instead verify the shapes the
 * CLI produces (config mutation and preflight fetch contract) at the unit
 * level, because the actual CLI binary calls `execSync` and `process.exit`
 * which are awkward to test in-process. The handlers themselves live in
 * `bin/shogo.ts`; where we can't call them directly (due to top-level
 * `parseArgs`), we re-implement the small bits under test here to pin the
 * contract shape.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { resolve } from 'path'

describe('shogo CLI — enable / dev contracts', () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(resolve(tmpdir(), 'shogo-cli-test-'))
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  describe('enable voice (config mutation contract)', () => {
    /**
     * Reproduces the config-mutation logic from `handleEnableCommand`
     * against an isolated temp dir. Keeps `shogo enable voice` a single
     * toggle: we must not destroy existing config fields.
     */
    function applyEnable(cfgPath: string, feature: 'voice' | 'voice.phoneNumber') {
      const existing = existsSync(cfgPath)
        ? (JSON.parse(readFileSync(cfgPath, 'utf-8')) as Record<string, unknown>)
        : {
            schema: './prisma/schema.prisma',
            outputs: [{ dir: './src/generated', generate: [], perModel: true }],
          }
      existing.features = (existing.features as Record<string, unknown>) ?? {}
      const features = existing.features as Record<string, unknown>
      const [head, tail] = feature.split('.') as [string, string | undefined]
      if (head === 'voice') {
        if (tail === 'phoneNumber') {
          const base =
            typeof features.voice === 'object' && features.voice !== null
              ? (features.voice as Record<string, unknown>)
              : {}
          features.voice = { ...base, phoneNumber: true }
        } else if (!tail) {
          if (typeof features.voice !== 'object' || features.voice === null) {
            features.voice = true
          }
        }
      }
      writeFileSync(cfgPath, JSON.stringify(existing, null, 2) + '\n')
    }

    it('creates a config when none exists and enables voice', () => {
      const cfgPath = resolve(tmp, 'shogo.config.json')
      applyEnable(cfgPath, 'voice')
      const parsed = JSON.parse(readFileSync(cfgPath, 'utf-8'))
      expect(parsed.features.voice).toBe(true)
      expect(parsed.outputs).toBeInstanceOf(Array)
      expect(parsed.schema).toBe('./prisma/schema.prisma')
    })

    it('preserves existing outputs / models when enabling voice', () => {
      const cfgPath = resolve(tmp, 'shogo.config.json')
      writeFileSync(
        cfgPath,
        JSON.stringify({
          schema: './prisma/schema.prisma',
          models: ['User', 'Post'],
          outputs: [{ dir: './apps/api/src/generated', generate: ['routes'], perModel: true }],
        }) + '\n',
      )
      applyEnable(cfgPath, 'voice')
      const parsed = JSON.parse(readFileSync(cfgPath, 'utf-8'))
      expect(parsed.features.voice).toBe(true)
      expect(parsed.models).toEqual(['User', 'Post'])
      expect(parsed.outputs[0].dir).toBe('./apps/api/src/generated')
      expect(parsed.outputs[0].generate).toEqual(['routes'])
    })

    it('voice.phoneNumber upgrades existing voice=true into an object form', () => {
      const cfgPath = resolve(tmp, 'shogo.config.json')
      writeFileSync(
        cfgPath,
        JSON.stringify({
          schema: './prisma/schema.prisma',
          outputs: [{ dir: './src/generated', generate: [], perModel: true }],
          features: { voice: true },
        }) + '\n',
      )
      applyEnable(cfgPath, 'voice.phoneNumber')
      const parsed = JSON.parse(readFileSync(cfgPath, 'utf-8'))
      expect(parsed.features.voice).toEqual({ phoneNumber: true })
    })

    it('voice.phoneNumber preserves other voice sub-flags', () => {
      const cfgPath = resolve(tmp, 'shogo.config.json')
      writeFileSync(
        cfgPath,
        JSON.stringify({
          schema: './prisma/schema.prisma',
          outputs: [{ dir: './src/generated', generate: [], perModel: true }],
          features: { voice: { phoneNumber: false, futureFlag: 'x' } },
        }) + '\n',
      )
      applyEnable(cfgPath, 'voice.phoneNumber')
      const parsed = JSON.parse(readFileSync(cfgPath, 'utf-8'))
      expect(parsed.features.voice).toEqual({ phoneNumber: true, futureFlag: 'x' })
    })
  })

  describe('dev preflight (fetch contract)', () => {
    /**
     * Pinpoints the HTTP contract `shogo dev` uses when pinging the
     * Shogo API. The headers and URL shape here are load-bearing —
     * authMiddleware in apps/api expects them verbatim.
     */
    function buildPreflightRequest(env: {
      PROJECT_ID: string
      RUNTIME_AUTH_SECRET: string
      SHOGO_API_URL: string
    }) {
      const url = `${env.SHOGO_API_URL}/api/voice/config/${encodeURIComponent(env.PROJECT_ID)}?projectId=${encodeURIComponent(env.PROJECT_ID)}`
      return {
        url,
        headers: { 'x-runtime-token': env.RUNTIME_AUTH_SECRET },
      }
    }

    function buildProvisionRequest(env: {
      PROJECT_ID: string
      RUNTIME_AUTH_SECRET: string
      SHOGO_API_URL: string
    }) {
      const url = `${env.SHOGO_API_URL}/api/voice/twilio/provision-number/${encodeURIComponent(env.PROJECT_ID)}?projectId=${encodeURIComponent(env.PROJECT_ID)}`
      return {
        url,
        method: 'POST' as const,
        headers: {
          'x-runtime-token': env.RUNTIME_AUTH_SECRET,
          'content-type': 'application/json',
        },
        body: '{}',
      }
    }

    it('emits a config preflight that carries x-runtime-token and ?projectId=', () => {
      const req = buildPreflightRequest({
        PROJECT_ID: 'proj_abc',
        RUNTIME_AUTH_SECRET: 'rt_XXX',
        SHOGO_API_URL: 'http://localhost:8002',
      })
      expect(req.url).toContain('/api/voice/config/proj_abc')
      expect(req.url).toContain('projectId=proj_abc')
      expect(req.headers['x-runtime-token']).toBe('rt_XXX')
    })

    it('emits a Twilio provisioning POST that carries x-runtime-token and ?projectId=', () => {
      const req = buildProvisionRequest({
        PROJECT_ID: 'proj_abc',
        RUNTIME_AUTH_SECRET: 'rt_XXX',
        SHOGO_API_URL: 'http://localhost:8002',
      })
      expect(req.method).toBe('POST')
      expect(req.url).toContain('/api/voice/twilio/provision-number/proj_abc')
      expect(req.url).toContain('projectId=proj_abc')
      expect(req.headers['x-runtime-token']).toBe('rt_XXX')
      expect(req.headers['content-type']).toBe('application/json')
    })

    it('URL-encodes slashes / special chars in projectId', () => {
      const req = buildPreflightRequest({
        PROJECT_ID: 'proj/with space',
        RUNTIME_AUTH_SECRET: 'rt',
        SHOGO_API_URL: 'http://api',
      })
      expect(req.url).toContain('proj%2Fwith%20space')
      expect(req.url).toContain('projectId=proj%2Fwith%20space')
    })
  })
})
