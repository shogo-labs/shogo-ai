// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for CommandClassifier (short vs long heuristic).
 */
import { describe, it, expect } from 'bun:test'
import { classifyCommand, isShortCommand } from '../command-classifier'

describe('CommandClassifier', () => {
  describe('classifyCommand()', () => {
    // ─── Long-running commands ──────────────────────────────────
    it('detects background operator (&)', () => {
      const r = classifyCommand('sleep 30 &')
      expect(r.kind).toBe('long')
    })

    it('detects dev server (bun run dev)', () => {
      const r = classifyCommand('bun run dev')
      expect(r.kind).toBe('long')
    })

    it('detects expo start', () => {
      const r = classifyCommand('npx expo start')
      expect(r.kind).toBe('long')
    })

    it('detects npm start', () => {
      const r = classifyCommand('npm start')
      expect(r.kind).toBe('long')
    })

    it('detects npm run serve', () => {
      const r = classifyCommand('npm run serve')
      expect(r.kind).toBe('long')
    })

    it('detects docker run', () => {
      const r = classifyCommand('docker run -p 3000:3000 myimage')
      expect(r.kind).toBe('long')
    })

    it('detects docker-compose up', () => {
      const r = classifyCommand('docker-compose up')
      expect(r.kind).toBe('long')
    })

    it('detects python http server', () => {
      const r = classifyCommand('python -m http.server 8080')
      expect(r.kind).toBe('long')
    })

    it('detects vite', () => {
      const r = classifyCommand('npx vite')
      expect(r.kind).toBe('long')
    })

    it('detects bun run with subcommand', () => {
      const r = classifyCommand('bun run start')
      expect(r.kind).toBe('long')
    })

    it('detects pnpm dev', () => {
      const r = classifyCommand('pnpm dev')
      expect(r.kind).toBe('long')
    })

    it('detects yarn start', () => {
      const r = classifyCommand('yarn start')
      expect(r.kind).toBe('long')
    })

    it('detects pm2 start', () => {
      const r = classifyCommand('pm2 start server.js')
      expect(r.kind).toBe('long')
    })

    it('detects nohup piped', () => {
      const r = classifyCommand('command | nohup')
      expect(r.kind).toBe('long')
    })

    // ─── Short commands ─────────────────────────────────────────
    it('classifies echo as short', () => {
      expect(classifyCommand('echo hello').kind).toBe('short')
    })

    it('classifies ls as short', () => {
      expect(classifyCommand('ls -la').kind).toBe('short')
    })

    it('classifies git status as short', () => {
      expect(classifyCommand('git status').kind).toBe('short')
    })

    it('classifies git log as short', () => {
      expect(classifyCommand('git log --oneline -5').kind).toBe('short')
    })

    it('classifies git diff as short', () => {
      expect(classifyCommand('git diff HEAD').kind).toBe('short')
    })

    it('classifies cat as short', () => {
      expect(classifyCommand('cat package.json').kind).toBe('short')
    })

    it('classifies pwd as short', () => {
      expect(classifyCommand('pwd').kind).toBe('short')
    })

    it('classifies which as short', () => {
      expect(classifyCommand('which node').kind).toBe('short')
    })

    it('classifies npm test as short', () => {
      expect(classifyCommand('npm test').kind).toBe('short')
    })

    it('classifies bun test as short', () => {
      expect(classifyCommand('bun test').kind).toBe('short')
    })

    it('classifies tsc as short', () => {
      expect(classifyCommand('tsc --noEmit').kind).toBe('short')
    })

    it('classifies git add + commit as short', () => {
      expect(classifyCommand('git add -A && git commit -m "fix"').kind).toBe('short')
    })

    it('classifies exit as short', () => {
      expect(classifyCommand('exit').kind).toBe('short')
    })

    it('classifies curl as short', () => {
      expect(classifyCommand('curl http://localhost:3000').kind).toBe('short')
    })

    it('classifies mkdir as short', () => {
      expect(classifyCommand('mkdir -p src/utils').kind).toBe('short')
    })

    it('defaults unknown short commands to short', () => {
      expect(classifyCommand('mycustomtool --flag').kind).toBe('short')
    })

    // ─── Terminal label ─────────────────────────────────────────
    it('generates terminal label for long commands', () => {
      const r = classifyCommand('bun run dev')
      expect(r.terminalLabel).toContain('Shogo')
      expect(r.terminalLabel).toContain('bun run dev')
    })

    it('truncates long terminal labels', () => {
      const longCmd = 'a'.repeat(100)
      const r = classifyCommand(`${longCmd} &`)
      expect(r.terminalLabel!.length).toBeLessThan(70)
      expect(r.terminalLabel).toContain('...')
    })

    // ─── Reasons ────────────────────────────────────────────────
    it('provides reason for classification', () => {
      const r = classifyCommand('bun run dev')
      expect(r.reason).toBeTruthy()
      expect(r.reason.length).toBeGreaterThan(0)
    })
  })

  describe('isShortCommand()', () => {
    it('returns true for short commands', () => {
      expect(isShortCommand('echo hello')).toBe(true)
      expect(isShortCommand('git status')).toBe(true)
      expect(isShortCommand('ls -la')).toBe(true)
    })

    it('returns false for long commands', () => {
      expect(isShortCommand('bun run dev')).toBe(false)
      expect(isShortCommand('npm start')).toBe(false)
      expect(isShortCommand('sleep 30 &')).toBe(false)
    })
  })
})
