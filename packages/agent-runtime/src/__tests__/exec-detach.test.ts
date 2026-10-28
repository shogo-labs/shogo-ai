// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { checkSelfDetach, selfDetachRefusal } from '../exec-detach'

describe('checkSelfDetach', () => {
  test.each([
    'bun scripts/export.ts &',
    'bun scripts/export.ts > export.log 2>&1 &',
    'nohup bun scripts/export.ts > logs/export.log 2>&1 &',
    'mkdir -p logs && nohup bun run export > logs/export.log 2>&1 &',
    'bun run dev & sleep 3 && curl -s localhost:4321',
    '(bun run dev &)',
    'cd app; bun run dev &>dev.log &',
    'bun run dev & disown',
    'setsid -f bun run dev',
    'PORT=4000 bun server.ts&',
    'bun run dev &\necho started',
  ])('refuses %j', (command) => {
    expect(checkSelfDetach(command).detached).toBe(true)
  })

  test.each([
    'bun test',
    'bun test 2>&1 | tail -20',
    'bun run build && bun run lint',
    'false || echo fallback',
    'bun run dev &> dev.log',
    'ls >&2',
    'cmd |& tee out.log',
    'echo "a & b" && echo \'c &\'',
    'echo a \\& b',
    'curl "http://x/api?a=1&b=2"',
    'sleep 1 & sleep 2 & wait',
    'bun run a & pid=$!; bun run b; wait $pid',
    'nohup bun scripts/export.ts > export.log 2>&1',
    'echo hi # background with &',
    "cat > index.html <<'EOF'\n<p>Tom &amp; Jerry & co</p>\nEOF\necho written",
    'cat <<EOF > notes.md\nfoo & bar\nEOF',
    '',
  ])('allows %j', (command) => {
    expect(checkSelfDetach(command).detached).toBe(false)
  })

  test('suggests the same job without & or nohup, keeping its redirects', () => {
    const check = checkSelfDetach('nohup bun scripts/export.ts > export.log 2>&1 &')
    expect(check).toMatchObject({ how: '`nohup … &`', ownLog: true, suggestion: 'bun scripts/export.ts > export.log 2>&1' })
    const message = selfDetachRefusal(check)
    expect(message).toContain('background: true')
    expect(message).toContain('"bun scripts/export.ts > export.log 2>&1"')
    expect(message).toContain('output_file')
  })

  test('/dev/null is not a log of its own', () => {
    expect(checkSelfDetach('bun run dev > /dev/null 2>&1 &').ownLog).toBe(false)
  })

  test('a compound command gets advice to split it rather than a rewrite', () => {
    const check = checkSelfDetach('bun run dev & sleep 3 && curl -s localhost:4321')
    expect(check.suggestion).toBeUndefined()
    expect(selfDetachRefusal(check)).toContain('until')
  })
})
